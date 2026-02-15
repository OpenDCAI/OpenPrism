import { promises as fs } from 'fs';
import { applyPatch, createTwoFilesPatch } from 'diff';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { ChatOpenAI } from '@langchain/openai';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { AgentExecutor, createOpenAIToolsAgent } from 'langchain/agents';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { safeJoin } from '../utils/pathUtils.js';
import { listFilesRecursive } from '../utils/fsUtils.js';
import { extractPathFromPatch } from '../utils/diffUtils.js';
import { resolveLLMConfig, normalizeBaseURL, normalizeChatEndpoint } from './llmService.js';
import { getProjectRoot } from './projectService.js';
import { extractArxivId, fetchArxivEntry, buildArxivBibtex } from './arxivService.js';
import { t } from '../i18n/index.js';

export async function runToolAgent({
  projectId,
  activePath,
  task,
  prompt,
  selection,
  compileLog,
  llmConfig,
  lang = 'zh-CN'
}) {
  if (!projectId) {
    return { ok: false, reply: t(lang, 'missing_project_id_tools'), patches: [] };
  }

  const projectRoot = await getProjectRoot(projectId);
  const pendingPatches = [];
  const READ_FILE_MAX_CHARS = Number(process.env.OPENPRISM_TOOL_READ_MAX_CHARS || 8000);
  const LIST_FILES_MAX_COUNT = Number(process.env.OPENPRISM_TOOL_LIST_MAX_COUNT || 400);

  const readFileTool = new DynamicStructuredTool({
    name: 'read_file',
    description: 'Read a UTF-8 file from the project. Input: { path, startLine?, endLine? } (relative to project root).',
    schema: z.object({
      path: z.string(),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional()
    }),
    func: async ({ path: filePath, startLine, endLine }) => {
      const abs = safeJoin(projectRoot, filePath);
      const content = await fs.readFile(abs, 'utf8');
      const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const lines = normalized.split('\n');
      const totalLines = lines.length;
      const start = Math.max(1, Math.min(startLine || 1, totalLines));
      const end = Math.max(start, Math.min(endLine || totalLines, totalLines));
      const selected = lines.slice(start - 1, end).join('\n');
      if (selected.length <= READ_FILE_MAX_CHARS) {
        return `[read_file] ${filePath} lines ${start}-${end} of ${totalLines}\n${selected}`;
      }
      const truncated = selected.slice(0, READ_FILE_MAX_CHARS);
      return [
        `[read_file] ${filePath} lines ${start}-${end} of ${totalLines} (truncated to ${READ_FILE_MAX_CHARS} chars)`,
        truncated,
        `\n...[truncated ${selected.length - READ_FILE_MAX_CHARS} chars]`,
        'If needed, call read_file again with a narrower line range.'
      ].join('\n');
    }
  });

  const listFilesTool = new DynamicStructuredTool({
    name: 'list_files',
    description: 'List files under a directory. Input: { dir } (relative path, optional).',
    schema: z.object({ dir: z.string().optional() }),
    func: async ({ dir }) => {
      const root = dir ? safeJoin(projectRoot, dir) : projectRoot;
      const items = await listFilesRecursive(root, '');
      const files = items
        .filter((item) => item.type === 'file')
        .map((item) => item.path)
        .sort();
      const limited = files.slice(0, LIST_FILES_MAX_COUNT);
      return JSON.stringify({
        files: limited,
        total: files.length,
        truncated: files.length > limited.length
      });
    }
  });

  const proposePatchTool = new DynamicStructuredTool({
    name: 'propose_patch',
    description: 'Propose a full file rewrite. Input: { path, content }. This does NOT write. It returns a patch for user confirmation.',
    schema: z.object({ path: z.string(), content: z.string() }),
    func: async ({ path: filePath, content }) => {
      let original = '';
      try {
        const abs = safeJoin(projectRoot, filePath);
        original = await fs.readFile(abs, 'utf8');
      } catch {
        original = '';
      }
      const diff = createTwoFilesPatch(filePath, filePath, original, content, 'current', 'proposed');
      pendingPatches.push({ path: filePath, original, content, diff });
      return `Patch prepared for ${filePath}. Awaiting user confirmation.`;
    }
  });

  const applyPatchTool = new DynamicStructuredTool({
    name: 'apply_patch',
    description: 'Apply a unified diff to a file and propose changes. Input: { patch, path? }. This does NOT write.',
    schema: z.object({ patch: z.string(), path: z.string().optional() }),
    func: async ({ patch, path: providedPath }) => {
      const filePath = providedPath || extractPathFromPatch(patch);
      if (!filePath) {
        throw new Error('Patch missing file path');
      }
      const abs = safeJoin(projectRoot, filePath);
      const original = await fs.readFile(abs, 'utf8');
      const patched = applyPatch(original, patch);
      if (patched === false) {
        throw new Error('Failed to apply patch');
      }
      const diff = createTwoFilesPatch(filePath, filePath, original, patched, 'current', 'proposed');
      pendingPatches.push({ path: filePath, original, content: patched, diff });
      return `Patch applied in memory for ${filePath}. Awaiting user confirmation.`;
    }
  });

  const compileLogTool = new DynamicStructuredTool({
    name: 'get_compile_log',
    description: 'Return the latest compile log from the client (read-only). Input: { }.',
    schema: z.object({}),
    func: async () => {
      return compileLog || 'No compile log provided.';
    }
  });

  const arxivSearchTool = new DynamicStructuredTool({
    name: 'arxiv_search',
    description: 'Search arXiv papers. Input: { query, maxResults? }.',
    schema: z.object({ query: z.string(), maxResults: z.number().optional() }),
    func: async ({ query, maxResults }) => {
      const max = Math.min(10, Math.max(1, maxResults || 5));
      const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${max}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'openprism/1.0' } });
      if (!res.ok) {
        throw new Error(`arXiv search failed: ${res.status}`);
      }
      const xml = await res.text();
      const parser = new XMLParser({ ignoreAttributes: false });
      const data = parser.parse(xml);
      const entries = Array.isArray(data?.feed?.entry) ? data.feed.entry : data?.feed?.entry ? [data.feed.entry] : [];
      const papers = entries.map((entry) => {
        const authors = Array.isArray(entry.author) ? entry.author : [entry.author].filter(Boolean);
        const authorNames = authors.map((a) => a?.name).filter(Boolean);
        const id = String(entry.id || '');
        const arxivId = id ? id.split('/').pop() : '';
        return {
          title: String(entry.title || '').replace(/\s+/g, ' ').trim(),
          abstract: String(entry.summary || '').replace(/\s+/g, ' ').trim(),
          authors: authorNames,
          url: id,
          arxivId
        };
      });
      return JSON.stringify({ papers });
    }
  });

  const arxivBibtexTool = new DynamicStructuredTool({
    name: 'arxiv_bibtex',
    description: 'Generate BibTeX for an arXiv paper. Input: { arxivId }.',
    schema: z.object({ arxivId: z.string() }),
    func: async ({ arxivId }) => {
      const id = extractArxivId(arxivId);
      if (!id) throw new Error('Invalid arXiv ID');
      const entry = await fetchArxivEntry(id);
      if (!entry) throw new Error('No arXiv metadata found');
      return buildArxivBibtex(entry);
    }
  });

  const resolved = resolveLLMConfig(llmConfig);
  if (!resolved.apiKey) {
    return { ok: false, reply: 'OPENPRISM_LLM_API_KEY not set', patches: [] };
  }

  const llm = new ChatOpenAI({
    model: resolved.model,
    temperature: 0.2,
    apiKey: resolved.apiKey,
    openAIApiKey: resolved.apiKey,
    configuration: { baseURL: normalizeBaseURL(normalizeChatEndpoint(resolved.endpoint)) }
  });

  const system = [
    'You are a LaTeX paper assistant for OpenPrism.',
    'You can read files and propose patches via tools, and you may call tools multiple times.',
    'If a request affects multiple files (e.g., sections + bib), inspect and update all relevant files.',
    'You can use arxiv_search to find papers and arxiv_bibtex to generate BibTeX.',
    'Never assume writes are applied; use propose_patch and wait for user confirmation.',
    'Use apply_patch for localized edits; use propose_patch for full-file rewrites.',
    'Be concise. Provide a short summary in the final response.'
  ].join(' ');

  const userInput = [
    `Task: ${task || 'polish'}`,
    activePath ? `Active file: ${activePath}` : '',
    prompt ? `User prompt: ${prompt}` : '',
    selection ? `Selection:\n${selection}` : '',
    compileLog ? `Compile log:\n${compileLog}` : ''
  ].filter(Boolean).join('\n\n');

  const promptTemplate = ChatPromptTemplate.fromMessages([
    ['system', system],
    ['human', '{input}'],
    new MessagesPlaceholder('agent_scratchpad')
  ]);

  const tools = [readFileTool, listFilesTool, proposePatchTool, applyPatchTool, compileLogTool, arxivSearchTool, arxivBibtexTool];
  const agent = await createOpenAIToolsAgent({ llm, tools, prompt: promptTemplate });
  const executor = new AgentExecutor({
    agent,
    tools,
    maxIterations: Number(process.env.OPENPRISM_TOOL_AGENT_MAX_ITERATIONS || 6),
    earlyStoppingMethod: 'force'
  });
  const result = await executor.invoke({ input: userInput });

  return {
    ok: true,
    reply: result.output || '',
    patches: pendingPatches
  };
}
