"""Writing assistant: chat, direct JSON completion, and a tool-calling agent that proposes patches.

Port of routes/agent.js + services/agentService.js. The tool loop talks to the OpenAI tools API directly
(LangChain's AgentExecutor was only used for this loop). Patches are never written: they are returned for the
user to confirm in the editor.
"""
import json

from projects import files as pfiles
from projects.models import ProjectFile
from projects.paths import InvalidPath, safe_path

from . import arxiv, llm
from .i18n import t
from .patches import PatchError, apply_patch, extract_path, make_patch

MAX_STEPS = 15
READ_LIMIT = 20000
CONTEXT_LINES = 40  # lines of the active file shown on each side of the caret
CURSOR = '<<CURSOR>>'

SYSTEM_TOOLS = ' '.join([
    'You are a LaTeX paper assistant for OpenPrism.',
    'You can read files and propose patches via tools, and you may call tools multiple times.',
    'If a request affects multiple files (e.g., sections + bib), inspect and update all relevant files.',
    'You can use arxiv_search to find papers and arxiv_bibtex to generate BibTeX.',
    'Never assume writes are applied; use propose_patch and wait for user confirmation.',
    'Use apply_patch for localized edits; use propose_patch for full-file rewrites.',
    'Be concise. Provide a short summary in the final response.'])

SYSTEM_EDIT = ' '.join([
    'You are an in-place editing assistant inside a LaTeX editor. The user typed one short request; do exactly that task.',
    'You are given the active file around the caret (marked %s), the selection if any, and the main file.' % CURSOR,
    'Read other files with read_file before editing them. Front matter (title, authors, affiliations) is written differently',
    'in each conference template: read the preamble of the main file and follow the markup this template uses.',
    'A task may need several files (for example a new section is a new file plus an \\input in the main file): propose all of them.',
    'Edit existing files with replace_text (exact old text, unique in the file) or apply_patch; never rewrite an existing file with propose_patch.',
    'Use propose_patch only to create a new file. Never assume writes are applied.',
    'Keep changes minimal and do not touch unrelated text. Finish with a one or two sentence summary.'])

TOOL_SPECS = [
    ('read_file', 'Read a UTF-8 file from the project. Input: { path } (relative to project root).',
     {'path': {'type': 'string'}}, ['path']),
    ('list_files', 'List files under a directory. Input: { dir } (relative path, optional).',
     {'dir': {'type': 'string'}}, []),
    ('replace_text', 'Replace exact text in a file. Input: { path, old_text, new_text }. old_text must occur exactly once (include enough surrounding lines to make it unique). Preferred for edits to existing files. This does NOT write.',
     {'path': {'type': 'string'}, 'old_text': {'type': 'string'}, 'new_text': {'type': 'string'}}, ['path', 'old_text', 'new_text']),
    ('propose_patch', 'Propose a full file rewrite. Input: { path, content }. This does NOT write. It returns a patch for user confirmation.',
     {'path': {'type': 'string'}, 'content': {'type': 'string'}}, ['path', 'content']),
    ('apply_patch', 'Apply a unified diff to a file and propose changes. Input: { patch, path? }. This does NOT write.',
     {'patch': {'type': 'string'}, 'path': {'type': 'string'}}, ['patch']),
    ('get_compile_log', 'Return the latest compile log from the client (read-only). Input: { }.', {}, []),
    ('arxiv_search', 'Search arXiv papers. Input: { query, maxResults? }.',
     {'query': {'type': 'string'}, 'maxResults': {'type': 'number'}}, ['query']),
    ('arxiv_bibtex', 'Generate BibTeX for an arXiv paper. Input: { arxivId }.', {'arxivId': {'type': 'string'}}, ['arxivId']),
]
TOOLS = [{'type': 'function', 'function': {'name': n, 'description': d,
                                           'parameters': {'type': 'object', 'properties': p, 'required': r}}}
         for n, d, p, r in TOOL_SPECS]


def _llm_failure(lang, res):
    return {'ok': False, 'reply': t(lang, 'llm_error', error=res.get('error') or 'unknown error'), 'suggestion': ''}


def chat_mode(p, cfg, lang):
    history = [h for h in (p.get('history') or []) if isinstance(h, dict) and h.get('role') in ('user', 'assistant')
               and isinstance(h.get('content'), str)]
    system = ' '.join(['You are a helpful academic writing assistant.',
                       'This is chat-only mode: do not propose edits, patches, or JSON.', 'Respond concisely and helpfully.'])
    user = '\n\n'.join(x for x in [
        f"User Prompt: {p['prompt']}" if p.get('prompt') else '',
        f"Selection (read-only):\n{p['selection']}" if p.get('selection') else '',
        '' if p.get('selection') else (f"Current File (read-only):\n{p['content']}" if p.get('content') else ''),
        f"Compile Log (read-only):\n{p['compileLog']}" if p.get('compileLog') else ''] if x)
    res = llm.chat([{'role': 'system', 'content': system}, *history, {'role': 'user', 'content': user}], cfg)
    if not res['ok']:
        return _llm_failure(lang, res)
    return {'ok': True, 'reply': res['content'], 'suggestion': ''}


def direct_mode(p, cfg, lang):
    task = p.get('task') or 'polish'
    if task == 'autocomplete':
        system = ' '.join(['You are an autocomplete engine for LaTeX.', 'Only return JSON with keys: reply, suggestion.',
                           'suggestion must be the continuation text after the cursor.',
                           'Do not include explanations or code fences.'])
    else:
        system = ' '.join(['You are a LaTeX writing assistant for academic papers.',
                           'Return a concise response and a suggested rewrite for the selection or full content.',
                           'Output in JSON with keys: reply, suggestion.'])
    user = '\n\n'.join(x for x in [
        f'Task: {task}', 'Mode: direct',
        f"User Prompt: {p['prompt']}" if p.get('prompt') else '',
        f"Selection:\n{p['selection']}" if p.get('selection') else '',
        '' if p.get('selection') else f"Full Content:\n{p.get('content') or ''}"] if x)
    res = llm.chat([{'role': 'system', 'content': system}, {'role': 'user', 'content': user}], cfg)
    if not res['ok']:
        return _llm_failure(lang, res)
    try:
        parsed = json.loads(res['content'])
        return {'ok': True, 'reply': parsed.get('reply') or '', 'suggestion': parsed.get('suggestion') or ''}
    except (ValueError, AttributeError):
        return {'ok': True, 'reply': res['content'], 'suggestion': ''}


class ToolBox:
    def __init__(self, project, compile_log, edit_mode=False):
        self.project, self.compile_log, self.patches, self.edit_mode = project, compile_log, [], edit_mode

    def _read(self, path):
        """The file as this run has left it: an earlier patch to the same file is already applied."""
        for patch in self.patches:
            if patch['path'] == path:
                return patch['content']
        try:
            return pfiles.read_text(self.project, path)
        except pfiles.FileNotFound:
            return None

    def _stage(self, path, content):
        """Record a proposal; several edits to one file collapse into one patch from the stored text to the final text."""
        for patch in self.patches:
            if patch['path'] == path:
                patch['content'], patch['diff'] = content, make_patch(path, patch['original'], content)
                return
        try:
            original = pfiles.read_text(self.project, path)
        except pfiles.FileNotFound:
            original = ''
        self.patches.append({'path': path, 'original': original, 'content': content, 'diff': make_patch(path, original, content)})

    def call(self, name, args):
        """Run a tool; failures come back as text so the model can correct itself."""
        fn = getattr(self, f'tool_{name}', None)
        if fn is None:
            return f'Error: unknown tool {name}'
        try:
            return fn(**args)
        except (TypeError, PatchError, InvalidPath, pfiles.FileNotFound, RuntimeError, ValueError, IsADirectoryError) as exc:
            return f'Error: {exc}'

    def tool_read_file(self, path):
        content = self._read(path)
        if content is None:
            raise pfiles.FileNotFound(f'File not found: {path}')
        return content[:READ_LIMIT]

    def tool_list_files(self, dir=None):
        prefix = safe_path(dir) + '/' if dir else ''
        names = [i['path'] for i in pfiles.list_tree(self.project) if i['type'] == 'file' and i['path'].startswith(prefix)]
        return json.dumps({'files': [n[len(prefix):] for n in names]})

    def tool_propose_patch(self, path, content):
        path = safe_path(path)
        if self.edit_mode and (self._read(path) or '').strip():
            raise ValueError(f'{path} already exists: change it with replace_text or apply_patch, not a full rewrite.')
        self._stage(path, content)
        return f'Patch prepared for {path}. Awaiting user confirmation.'

    def tool_replace_text(self, path, old_text, new_text):
        path = safe_path(path)
        original = self._read(path)
        if original is None:
            raise pfiles.FileNotFound(f'File not found: {path}')
        if not old_text:
            raise ValueError('old_text must not be empty')
        count = original.count(old_text)
        if count == 0:
            raise ValueError('old_text was not found in the file; copy it exactly, including whitespace')
        if count > 1:
            raise ValueError(f'old_text occurs {count} times; include more surrounding text so it is unique')
        self._stage(path, original.replace(old_text, new_text, 1))
        return f'Change prepared for {path}. Awaiting user confirmation.'

    def tool_apply_patch(self, patch, path=None):
        path = safe_path(path or extract_path(patch) or '')
        original = self._read(path)
        if original is None:
            raise pfiles.FileNotFound(f'File not found: {path}')
        self._stage(path, apply_patch(original, patch))
        return f'Patch applied in memory for {path}. Awaiting user confirmation.'

    def tool_get_compile_log(self):
        return self.compile_log or 'No compile log provided.'

    def tool_arxiv_search(self, query, maxResults=None):
        res = arxiv.search(query, maxResults)
        if not res['ok']:
            raise RuntimeError(res['error'])
        return json.dumps({'papers': res['papers']})

    def tool_arxiv_bibtex(self, arxivId):
        arxiv_id = arxiv.extract_id(arxivId)
        if not arxiv_id:
            raise ValueError('Invalid arXiv ID')
        entry = arxiv.fetch_entry(arxiv_id)
        if not entry:
            raise RuntimeError('No arXiv metadata found')
        return arxiv.build_bibtex(entry)


def _marked_window(text, line, col):
    """The lines around the caret with CURSOR inserted at (line, col); both 1-based, clamped to the text."""
    lines = text.split('\n')
    line = min(max(line, 1), len(lines))
    row = lines[line - 1]
    col = min(max(col, 1), len(row) + 1)
    lines[line - 1] = row[:col - 1] + CURSOR + row[col - 1:]
    first, last = max(line - 1 - CONTEXT_LINES, 0), min(line + CONTEXT_LINES, len(lines))
    head = f'(lines {first + 1}-{last} of {len(lines)})\n'
    return head + '\n'.join(lines[first:last])


def edit_prompt(p, project, ctx):
    """The user message for an in-place edit. `ctx` was validated by the view."""
    try:
        main_text = pfiles.read_text(project, ctx['mainFile']) if ctx.get('mainFile') else ''
    except pfiles.FileNotFound:
        main_text = ''
    docclass = next((ln.strip() for ln in main_text.splitlines() if ln.lstrip().startswith('\\documentclass')), '')
    active = ctx.get('content')
    if active is None:
        try:
            active = pfiles.read_text(project, ctx['activeFile'])
        except pfiles.FileNotFound:
            active = ''
    cur = ctx.get('cursor') or {}
    sel = (ctx.get('selection') or {}).get('text') or ''
    return '\n\n'.join(x for x in [
        f"Request: {p.get('prompt') or ''}",
        f"Project: {project.name}",
        f"Main file: {ctx['mainFile']}" if ctx.get('mainFile') else '',
        f'Template / document class: {docclass}' if docclass else '',
        f"Active file: {ctx['activeFile']} (caret at line {cur.get('line', 1)}, column {cur.get('col', 1)})",
        f'Selection:\n{sel}' if sel else 'No selection; the change goes at the caret unless the task says otherwise.',
        f"Active file around the caret:\n{_marked_window(active, int(cur.get('line', 1)), int(cur.get('col', 1)))}"] if x)


def _describe(name, args):
    """One line of progress for a tool call (shown in the editor while the request runs)."""
    path = args.get('path') or args.get('dir') or '' if isinstance(args, dict) else ''
    return {'read_file': f'Reading {path}', 'list_files': 'Listing files', 'propose_patch': f'Writing {path}',
            'apply_patch': f'Editing {path or "a file"}'}.get(name, name.replace('_', ' ').capitalize())


class Cancelled(Exception):
    """The user cancelled the request: stop spending tokens and drop the result."""


def tools_mode(p, project, cfg, lang, progress=None, cancelled=None):
    if project is None:
        return {'ok': False, 'reply': t(lang, 'missing_project_id_tools'), 'patches': []}
    if not llm.resolve_config(cfg)['api_key']:
        return {'ok': False, 'reply': 'OPENPRISM_LLM_API_KEY not set', 'patches': []}
    box = ToolBox(project, p.get('compileLog'), edit_mode=bool(p.get('editContext')))
    user = '\n\n'.join(x for x in [
        f"Task: {p.get('task') or 'polish'}",
        f"Active file: {p['activePath']}" if p.get('activePath') else '',
        f"User prompt: {p['prompt']}" if p.get('prompt') else '',
        f"Selection:\n{p['selection']}" if p.get('selection') else '',
        f"Compile log:\n{p['compileLog']}" if p.get('compileLog') else ''] if x)
    system = SYSTEM_TOOLS
    if p.get('editContext'):
        system, user = SYSTEM_EDIT, edit_prompt(p, project, p['editContext'])
    messages = [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]
    for step in range(MAX_STEPS):
        if cancelled and cancelled():
            raise Cancelled()
        if progress:
            progress('Thinking…' if step == 0 else 'Thinking again…')
        res = llm.chat_raw(messages, cfg, tools=TOOLS)
        if not res['ok']:
            return {'ok': False, 'reply': res['error'], 'patches': box.patches}
        message = res['message']
        calls = message.get('tool_calls') or []
        if not calls:
            return {'ok': True, 'reply': message.get('content') or '', 'patches': box.patches}
        messages.append({'role': 'assistant', 'content': message.get('content'), 'tool_calls': calls})
        for call in calls:
            try:
                args = json.loads(call['function'].get('arguments') or '{}')
            except ValueError:
                args = None
            if progress:
                progress(_describe(call['function']['name'], args))
            result = box.call(call['function']['name'], args) if isinstance(args, dict) else 'Error: tool arguments were not valid JSON'
            messages.append({'role': 'tool', 'tool_call_id': call['id'], 'content': str(result)})
    return {'ok': True, 'reply': f'Stopped after {MAX_STEPS} steps without a final answer.', 'patches': box.patches}


def run(p, project, cfg, lang, progress=None, cancelled=None):
    if (p.get('interaction') or 'agent') == 'chat':
        return chat_mode(p, cfg, lang)
    if p.get('mode') == 'tools':
        return tools_mode(p, project, cfg, lang, progress, cancelled)
    return direct_mode(p, cfg, lang)
