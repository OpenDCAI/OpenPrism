"""Recorded in-place edit tasks against the built-in templates.

The model is faked (`FakeLLM` replays the tool calls a real model made for each task, see the live runs in
docs/xchangelog.md), but everything else is real: the editor context, the prompt the model would see, the patches the tools
stage, and, where TeX Live is installed (worker-tex), a compile of the edited project. The point is that "add an author"
means different markup in each template and that the proposal still builds."""
import io
import os
import shutil
from unittest import mock, skipUnless

from django.core.management import call_command
from django.test import override_settings

from common.testing import FakeLLM, tool_call
from projects import files
from projects.models import Project
from projects.test_api import ApiBase
from templates_app.models import Template

from . import tasks as ai_tasks
from .patches import apply_patch

TEMPLATES_DIR = '/legacy/templates'
KEY = 'sk-test-edit-tasks'
HAS_TEX = shutil.which('pdflatex') is not None


def replace(path, old, new, call_id):
    return tool_call('replace_text', {'path': path, 'old_text': old, 'new_text': new}, call_id)


@override_settings(LLM_ALLOW_PRIVATE_ENDPOINTS=True)
class TemplateEditTaskTests(ApiBase):
    def _cleanup(self):
        # Like BuiltinTemplateTests: the real templates live in the bucket the running app uses, so only projects go.
        for p in Project.objects.all():
            files.delete_project_files(p)

    def setUp(self):
        super().setUp()
        if not os.path.isdir(TEMPLATES_DIR):
            self.skipTest('templates/ is not mounted at /legacy/templates')
        call_command('import_legacy', '--skip-projects', templates_dir=TEMPLATES_DIR, stdout=io.StringIO())
        sync = lambda job_id, secrets=None: ai_tasks.run_ai_job.run(job_id, secrets)
        patcher = mock.patch('ai.views.run_ai_job.delay', side_effect=sync)
        patcher.start()
        self.addCleanup(patcher.stop)

    def start(self, template, script, task):
        """Create the project, replay `script(project, main, text)` as the model's answers, run the task."""
        pid = self.new_project(template, template=template)
        project = Project.objects.get(pk=pid)
        main = Template.objects.get(pk=template).main_file
        text = files.read_text(project, main)
        fake = FakeLLM([*script(main, text), {'content': 'Done.'}])
        self.addCleanup(fake.close)
        line = text.count('\n', 0, text.index('\\begin{document}')) + 1
        res = self.c.post('/api/agent/run', {
            'projectId': pid, 'prompt': task, 'llmConfig': {'endpoint': fake.url, 'apiKey': KEY, 'model': 'm'},
            'editContext': {'activeFile': main, 'mainFile': main, 'cursor': {'line': line, 'col': 1}}}, format='json').data
        self.assertTrue(res['ok'], res)
        return project, main, text, fake, {p['path']: p for p in res['patches']}

    def check(self, project, main, text, fake, patches, task):
        # what the model was told
        system, user = [m['content'] for m in fake.requests[0]['body']['messages']]
        docclass = next(ln for ln in text.splitlines() if ln.lstrip().startswith('\\documentclass'))
        self.assertIn(docclass.strip(), user)  # the template's identity
        self.assertIn(f'Main file: {main}', user)
        self.assertIn(f'Request: {task}', user)
        self.assertIn('read the preamble', system)
        # what it proposed: every diff applies to the stored text and gives the proposed content; nothing was written
        for path, patch in patches.items():
            self.assertEqual(apply_patch(patch['original'], patch['diff']), patch['content'], path)
            if patch['original']:
                self.assertEqual(files.read_text(project, path), patch['original'], path)
        # and where TeX Live exists, the edited project still builds
        if HAS_TEX:
            from jobs.compile import compile_project
            for path, patch in patches.items():
                files.write_text(project, path, patch['content'])
            out = compile_project(project, main, 'pdflatex')
            self.assertTrue(out['pdf'], f'edited project did not build:\n{out["log"][-1500:]}')

    # ---- add an author: different markup per template -------------------------------------------------------------------

    def author_script(self, template):
        def script(main, text):
            if template in ('neurips', 'icml'):
                return [replace(main, '\\author{Author Name \\\\ Institution}', '\\author{Ada Lovelace \\\\ Analytical Engine Lab}', 'a')]
            if template == 'acl':
                return [replace(main, '\\author{First Author \\\\', '\\author{Ada Lovelace \\\\', 'a'),
                        replace(main, '  Affiliation / Address line 1 \\\\\n  Affiliation / Address line 2 \\\\\n  Affiliation / Address line 3 \\\\\n  \\texttt{email@domain} \\\\\\And\n  Second Author',
                                '  Analytical Engine Lab \\\\\n  \\texttt{ada@example.org} \\\\\\And\n  Second Author', 'b')]
            return [replace(main, '\\author{First Author\\\\', '\\author{Ada Lovelace\\\\', 'a'),
                    replace(main, 'firstauthor@i1.org', 'ada@example.org', 'b')]
        return script

    def test_add_an_author(self):
        task = 'Add an author: Ada Lovelace, Analytical Engine Lab, ada@example.org'
        for template in ('neurips', 'icml', 'acl', 'cvpr'):
            with self.subTest(template=template):
                project, main, text, fake, patches = self.start(template, self.author_script(template), task)
                self.assertEqual(list(patches), [main])
                self.assertIn('Ada Lovelace', patches[main]['content'])
                self.assertNotIn('Ada Lovelace', text)
                self.check(project, main, text, fake, patches, task)

    # ---- a new related work section: one file or two ----------------------------------------------------------------------

    def related_script(self, template):
        section = '\\section{Related Work}\nPrior work goes here.\n\n'
        def script(main, text):
            if template in ('neurips', 'icml'):
                return [replace(main, '\\section{Conclusion}', section + '\\section{Conclusion}', 'a')]
            if template == 'acl':
                return [replace(main, '\\section{Engines}', section + '\\section{Engines}', 'a')]
            return [tool_call('propose_patch', {'path': 'sec/4_related.tex', 'content': section}, 'a'),
                    replace(main, '\\input{sec/3_finalcopy}', '\\input{sec/3_finalcopy}\n\\input{sec/4_related}', 'b')]
        return script

    def test_add_a_related_work_section(self):
        task = 'Create a new section on related work'
        for template in ('neurips', 'icml', 'acl', 'cvpr'):
            with self.subTest(template=template):
                project, main, text, fake, patches = self.start(template, self.related_script(template), task)
                self.assertIn('Related Work', patches[main]['content'] if template != 'cvpr' else patches['sec/4_related.tex']['content'])
                if template == 'cvpr':  # a new file and the \input that loads it
                    self.assertEqual(set(patches), {main, 'sec/4_related.tex'})
                    self.assertEqual(patches['sec/4_related.tex']['original'], '')
                    self.assertIn('\\input{sec/4_related}', patches[main]['content'])
                else:
                    self.assertEqual(list(patches), [main])
                self.check(project, main, text, fake, patches, task)

    # ---- a list becomes a table (the request is about the selection) -----------------------------------------------------

    def test_turn_a_list_into_a_table(self):
        listing = '\\begin{itemize}\n\\item alpha: 1\n\\item beta: 2\n\\end{itemize}'
        table = '\\begin{tabular}{lr}\nalpha & 1 \\\\\nbeta & 2 \\\\\n\\end{tabular}'
        for template in ('neurips', 'icml'):
            with self.subTest(template=template):
                pid = self.new_project(template, template=template)
                project = Project.objects.get(pk=pid)
                main = Template.objects.get(pk=template).main_file
                text = files.read_text(project, main).replace('\\section{Method}', '\\section{Method}\n' + listing, 1)
                files.write_text(project, main, text)
                fake = FakeLLM([replace(main, listing, table, 'a'), {'content': 'Done.'}])
                self.addCleanup(fake.close)
                task = 'turn this list into a table'
                res = self.c.post('/api/agent/run', {
                    'projectId': pid, 'prompt': task, 'llmConfig': {'endpoint': fake.url, 'apiKey': KEY, 'model': 'm'},
                    'editContext': {'activeFile': main, 'mainFile': main, 'cursor': {'line': 1, 'col': 1}, 'selection': {'text': listing}}},
                    format='json').data
                patches = {p['path']: p for p in res['patches']}
                user = fake.requests[0]['body']['messages'][1]['content']
                self.assertIn(f'Selection:\n{listing}', user)
                self.assertIn('\\begin{tabular}', patches[main]['content'])
                self.assertNotIn('\\begin{itemize}', patches[main]['content'])
                self.check(project, main, text, fake, patches, task)
