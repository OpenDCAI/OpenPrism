import importlib.util
import json
from unittest import mock, skipUnless

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, override_settings

from common.testing import FakeLLM, tool_call
from rest_framework.response import Response

from jobs.models import Job
from projects import files, storage
from projects.models import Membership, Project
from projects.test_api import ApiBase, client_for, make_user

from . import arxiv, llm, plot
from . import tasks as ai_tasks
from .i18n import get_lang, t
from .patches import PatchError, apply_patch, extract_path, make_patch
from .ssrf import BlockedEndpoint, assert_public_url

KEY = 'sk-test-SECRET-123'
ATOM = """<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><id>http://arxiv.org/abs/1706.03762v7</id><published>2017-06-12T17:57:34Z</published>
<title>Attention Is
 All You Need</title><summary> The dominant   models </summary>
<author><name>A. Vaswani</name></author><author><name>N. Shazeer</name></author></entry></feed>"""


class PureTests(SimpleTestCase):
    def test_endpoint_normalisation(self):
        n = llm.normalize_chat_endpoint
        self.assertEqual(n(''), llm.DEFAULT_ENDPOINT)
        self.assertEqual(n('https://x.test/v1/'), 'https://x.test/v1/chat/completions')
        self.assertEqual(n('https://x.test/v1/chat/completions'), 'https://x.test/v1/chat/completions')
        self.assertEqual(n('https://x.test'), 'https://x.test/v1/chat/completions')
        self.assertEqual(n('https://x.test/v1/custom'), 'https://x.test/v1/custom')

    def test_ssrf_guard(self):
        for bad in ('http://127.0.0.1:8000/v1', 'http://localhost/v1', 'http://169.254.169.254/latest', 'http://10.0.0.5/v1',
                    'http://[::1]/v1', 'file:///etc/passwd', 'ftp://x.test/'):
            with self.assertRaises(BlockedEndpoint, msg=bad):
                assert_public_url(bad)
        with override_settings(LLM_ALLOW_PRIVATE_ENDPOINTS=True):
            assert_public_url('http://127.0.0.1:11434/v1')

    def test_llm_errors(self):
        with mock.patch.dict('os.environ', {'OPENPRISM_LLM_API_KEY': ''}):
            self.assertEqual(llm.chat_raw([], {})['error'], 'OPENPRISM_LLM_API_KEY not set')
        res = llm.chat([], {'apiKey': 'k', 'endpoint': 'http://169.254.169.254/'})
        self.assertFalse(res['ok'])
        self.assertIn('non-public', res['error'])

    @override_settings(LLM_ALLOW_PRIVATE_ENDPOINTS=True)
    def test_llm_http_failures(self):
        fake = FakeLLM([(401, 'bad key'), (200, 'not json')])
        self.addCleanup(fake.close)
        cfg = {'endpoint': fake.url, 'apiKey': 'k'}
        self.assertEqual(llm.chat([], cfg), {'ok': False, 'error': 'bad key'})
        self.assertFalse(llm.chat([], cfg)['ok'])

    def test_patch_roundtrip_and_offset(self):
        old = 'a\nb\nc\nd\ne\n'
        new = 'a\nB\nc\nd\ne\nf\n'
        patch = make_patch('x.tex', old, new)
        self.assertIn('--- x.tex\tcurrent', patch)
        self.assertEqual(apply_patch(old, patch), new)
        self.assertEqual(apply_patch('zz\n' + old, patch), 'zz\n' + new)  # hunk found despite shifted lines
        self.assertEqual(extract_path(patch), 'x.tex')
        with self.assertRaises(PatchError):
            apply_patch('completely different\n', patch)
        with self.assertRaises(PatchError):
            apply_patch(old, 'no hunks here')

    def test_plot_code_checker(self):
        plot.check_code("plt.bar(header, df_numeric[header[1]])\nplt.xlabel('x')")
        for bad in ('import os', 'from os import path', "open('/etc/passwd')", 'x = ().__class__', "getattr(plt, 'x')",
                    'eval("1")', 'global x', '__import__("os")', 'def f(:'):
            with self.assertRaises(plot.UnsafeCode, msg=bad):
                plot.check_code(bad)

    def test_arxiv_helpers(self):
        self.assertEqual(arxiv.extract_id('https://arxiv.org/pdf/1706.03762v7.pdf'), '1706.03762')
        self.assertEqual(arxiv.extract_id('arXiv:1706.03762v2'.replace('arXiv:', '')), '1706.03762')
        entry = {'title': 'T', 'authors': ['A', 'B'], 'year': '2017', 'arxivId': '1706.03762'}
        self.assertEqual(arxiv.build_bibtex(entry), '@article{arxiv:1706.03762,\n  title={T},\n  author={A and B},\n'
                         '  journal={arXiv preprint arXiv:1706.03762},\n  year={2017}\n}')

    def test_i18n(self):
        self.assertEqual(get_lang('zh-CN,zh;q=0.9'), 'zh-CN')
        self.assertEqual(get_lang(None), 'en-US')
        self.assertIn('boom', t('en-US', 'llm_error', error='boom'))


@override_settings(LLM_ALLOW_PRIVATE_ENDPOINTS=True)
class AiApiTests(ApiBase):
    def setUp(self):
        super().setUp()
        sync = lambda job_id, secrets=None: ai_tasks.run_ai_job.run(job_id, secrets)  # run the worker task inline
        patcher = mock.patch('ai.views.run_ai_job.delay', side_effect=sync)
        self.delay = patcher.start()
        self.addCleanup(patcher.stop)

    def fake(self, *replies):
        fake = FakeLLM(replies)
        self.addCleanup(fake.close)
        return fake

    def cfg(self, fake):
        return {'endpoint': fake.url, 'apiKey': KEY, 'model': 'm1'}

    def assert_key_not_persisted(self):
        for job in Job.objects.all():
            blob = json.dumps([job.params, job.result, job.progress_log, job.error])
            self.assertNotIn(KEY, blob)
            self.assertNotIn('apiKey', blob)

    def test_requires_auth(self):
        from rest_framework.test import APIClient
        self.assertEqual(APIClient().post('/api/llm', {}, format='json').status_code, 401)

    def test_llm_roundtrip_and_key_handling(self):
        fake = self.fake({'content': 'hello'})
        res = self.c.post('/api/llm', {'messages': [{'role': 'user', 'content': 'hi'}], 'llmConfig': self.cfg(fake)}, format='json')
        self.assertEqual(res.data, {'ok': True, 'content': 'hello'})
        req = fake.requests[0]
        self.assertEqual((req['path'], req['auth'], req['body']['model']), ('/v1/chat/completions', f'Bearer {KEY}', 'm1'))
        self.assertEqual(req['body']['messages'], [{'role': 'user', 'content': 'hi'}])
        self.assert_key_not_persisted()
        self.delay.assert_called_once()
        self.assertEqual(self.delay.call_args.args[1], {'apiKey': KEY})  # secret travels only as a task argument

    def test_llm_failure_is_reported_in_node_shape(self):
        fake = self.fake((500, 'upstream down'))
        res = self.c.post('/api/llm', {'messages': [], 'llmConfig': self.cfg(fake)}, format='json')
        self.assertEqual(res.data, {'ok': False, 'error': 'upstream down'})
        self.assertEqual(Job.objects.get().status, 'failed')

    def test_blocked_endpoint_via_api(self):
        with override_settings(LLM_ALLOW_PRIVATE_ENDPOINTS=False):
            res = self.c.post('/api/llm', {'messages': [], 'llmConfig': {'endpoint': 'http://169.254.169.254', 'apiKey': 'k'}}, format='json')
        self.assertFalse(res.data['ok'])
        self.assertIn('non-public', res.data['error'])

    def test_agent_chat_and_direct_modes(self):
        fake = self.fake({'content': 'just chatting'}, {'content': json.dumps({'reply': 'r', 'suggestion': 's'})},
                         {'content': 'not json'}, (500, 'down'))
        base = {'llmConfig': self.cfg(fake), 'prompt': 'help', 'selection': 'sel'}
        chat = self.c.post('/api/agent/run', {**base, 'interaction': 'chat', 'history': [
            {'role': 'user', 'content': 'earlier'}, {'role': 'system', 'content': 'dropped'}]}, format='json')
        self.assertEqual(chat.data, {'ok': True, 'reply': 'just chatting', 'suggestion': ''})
        roles = [m['role'] for m in fake.requests[0]['body']['messages']]
        self.assertEqual(roles, ['system', 'user', 'user'])  # the system-role history entry was filtered out
        self.assertEqual(self.c.post('/api/agent/run', {**base, 'task': 'polish'}, format='json').data,
                         {'ok': True, 'reply': 'r', 'suggestion': 's'})
        self.assertEqual(self.c.post('/api/agent/run', base, format='json').data,
                         {'ok': True, 'reply': 'not json', 'suggestion': ''})
        failed = self.c.post('/api/agent/run', base, format='json').data
        self.assertFalse(failed['ok'])
        self.assertIn('LLM is not configured or the call failed', failed['reply'])
        zh = self.c.post('/api/agent/run', base, format='json', HTTP_X_LANG='zh-CN').data  # default FakeLLM reply
        self.assertEqual(zh['reply'], 'default')
        self.assert_key_not_persisted()

    def test_agent_tools_mode_reads_proposes_and_recovers_from_tool_errors(self):
        pid = self.new_project()
        project = Project.objects.get(pk=pid)
        files.write_text(project, 'main.tex', 'line1\nline2\nline3\n')
        fake = self.fake(
            tool_call('read_file', {'path': 'missing.tex'}, 'a'),
            tool_call('read_file', {'path': 'main.tex'}, 'b'),
            tool_call('apply_patch', {'patch': make_patch('main.tex', 'line1\nline2\nline3\n', 'line1\nLINE2\nline3\n')}, 'c'),
            tool_call('propose_patch', {'path': 'new.bib', 'content': '@x{}'}, 'd'),
            {'content': 'Done: 2 patches.'})
        res = self.c.post('/api/agent/run', {'mode': 'tools', 'projectId': pid, 'activePath': 'main.tex', 'prompt': 'fix',
                                             'llmConfig': self.cfg(fake)}, format='json').data
        self.assertTrue(res['ok'], res)
        self.assertEqual(res['reply'], 'Done: 2 patches.')
        by_path = {p['path']: p for p in res['patches']}
        self.assertEqual(by_path['main.tex']['content'], 'line1\nLINE2\nline3\n')
        self.assertEqual(by_path['main.tex']['original'], 'line1\nline2\nline3\n')
        self.assertIn('+LINE2', by_path['main.tex']['diff'])
        self.assertEqual(by_path['new.bib']['original'], '')
        # nothing was written: patches are only proposals
        self.assertEqual(files.read_text(project, 'main.tex'), 'line1\nline2\nline3\n')
        with self.assertRaises(files.FileNotFound):
            files.read_text(project, 'new.bib')
        # the failed read_file was reported back to the model rather than aborting the run
        tool_msgs = [m['content'] for m in fake.requests[1]['body']['messages'] if m['role'] == 'tool']
        self.assertEqual(tool_msgs, ['Error: File not found: missing.tex'])
        self.assertEqual(len(fake.requests[0]['body']['tools']), 7)
        self.assert_key_not_persisted()

    def test_agent_tools_mode_guards(self):
        fake = self.fake()
        no_project = self.c.post('/api/agent/run', {'mode': 'tools', 'llmConfig': self.cfg(fake)}, format='json').data
        self.assertEqual(no_project, {'ok': False, 'reply': 'Missing projectId; tools mode is unavailable.', 'patches': []})
        pid = self.new_project()
        other = client_for(make_user('o@example.com'))
        self.assertEqual(other.post('/api/agent/run', {'mode': 'tools', 'projectId': pid}, format='json').status_code, 404)
        with mock.patch.dict('os.environ', {}, clear=False):
            res = self.c.post('/api/agent/run', {'mode': 'tools', 'projectId': pid, 'llmConfig': {'endpoint': fake.url}}, format='json').data
        self.assertFalse(res['ok'])

    def test_agent_tools_path_traversal_and_step_limit(self):
        pid = self.new_project()
        fake = self.fake(*[tool_call('read_file', {'path': '../../etc/passwd'}, str(i)) for i in range(20)])
        res = self.c.post('/api/agent/run', {'mode': 'tools', 'projectId': pid, 'llmConfig': self.cfg(fake)}, format='json').data
        self.assertTrue(res['ok'])
        self.assertIn('Stopped after 15 steps', res['reply'])
        self.assertEqual(len(fake.requests), 15)
        last_tool = [m['content'] for m in fake.requests[-1]['body']['messages'] if m['role'] == 'tool'][0]
        self.assertEqual(last_tool, 'Error: Invalid path')

    def test_vision_saves_asset_and_sends_image(self):
        pid = self.new_project()
        fake = self.fake({'content': '\\begin{equation}x\\end{equation}'})
        res = self.c.post('/api/vision/latex', {'image': SimpleUploadedFile('eq.png', b'\x89PNGdata', content_type='image/png'),
                                                'projectId': pid, 'mode': 'equation', 'prompt': 'note',
                                                'llmConfig': json.dumps(self.cfg(fake))}, format='multipart').data
        self.assertEqual(res, {'ok': True, 'latex': '\\begin{equation}x\\end{equation}', 'assetPath': 'assets/eq.png'})
        self.assertEqual(files.read_bytes(Project.objects.get(pk=pid), 'assets/eq.png'), b'\x89PNGdata')
        content = fake.requests[0]['body']['messages'][1]['content']
        self.assertIn('User note: note', content[0]['text'])
        self.assertTrue(content[1]['image_url']['url'].startswith('data:image/png;base64,'))
        job = Job.objects.get()
        with self.assertRaises(Exception):
            storage.get_bytes(job.params['imageKey'])  # uploaded input is deleted after use
        self.assert_key_not_persisted()

    def test_vision_requires_image_and_respects_read_only(self):
        self.assertEqual(self.c.post('/api/vision/latex', {'mode': 'table'}, format='multipart').data,
                         {'ok': False, 'error': 'Missing image.'})
        pid = self.new_project()
        viewer = make_user('v@example.com')
        Membership.objects.create(workspace=Project.objects.get(pk=pid).workspace, user=viewer, role=Membership.VIEWER)
        fake = self.fake({'content': 'x'})
        res = client_for(viewer).post('/api/vision/latex', {'image': SimpleUploadedFile('a.png', b'1'), 'projectId': pid,
                                                           'llmConfig': json.dumps(self.cfg(fake))}, format='multipart').data
        self.assertEqual(res['assetPath'], '')  # read-only users get a result but nothing is saved

    def test_plot_validation_and_permissions(self):
        pid = self.new_project()
        self.assertEqual(self.c.post('/api/plot/from-table', {}, format='json').data['error'], 'Missing projectId.')
        self.assertEqual(self.c.post('/api/plot/from-table', {'projectId': pid}, format='json').data['error'], 'Missing tableLatex.')
        viewer = make_user('v@example.com')
        Membership.objects.create(workspace=Project.objects.get(pk=pid).workspace, user=viewer, role=Membership.VIEWER)
        self.assertEqual(client_for(viewer).post('/api/plot/from-table', {'projectId': pid, 'tableLatex': 'x'}, format='json').status_code, 403)

    @skipUnless(importlib.util.find_spec('matplotlib'), 'needs matplotlib: docker compose run --rm worker-ai python manage.py test ai')
    def test_plot_end_to_end_with_retry_after_bad_code(self):
        pid = self.new_project()
        table = '\\begin{tabular}{lr}\\toprule Name & Score \\\\ \\midrule A & 1 \\\\ B & 3 \\\\ \\bottomrule\\end{tabular}'
        fake = self.fake({'content': '```python\nimport os\n```'},  # rejected by the checker -> error fed back
                         {'content': '```python\nplt.bar(df["Name"], df_numeric["Score"])\n```'})
        res = self.c.post('/api/plot/from-table', {'projectId': pid, 'tableLatex': table, 'chartType': 'bar', 'title': 'T',
                                                   'filename': 'scores', 'llmConfig': self.cfg(fake)}, format='json').data
        self.assertEqual(res, {'ok': True, 'assetPath': 'assets/plots/scores.png'})
        self.assertTrue(files.read_bytes(Project.objects.get(pk=pid), 'assets/plots/scores.png').startswith(b'\x89PNG'))
        self.assertIn('Imports are not allowed', fake.requests[1]['body']['messages'][1]['content'])
        self.assert_key_not_persisted()

    @skipUnless(importlib.util.find_spec('matplotlib'), 'needs matplotlib')
    def test_plot_sandbox_limits(self):
        table = '\\begin{tabular}{lr}A & 1 \\\\ B & 2\\end{tabular}'
        with override_settings(PLOT_TIMEOUT_SECONDS=3):
            self.assertTrue(plot.render(table, 'plt.bar(header, df_numeric[header[1]])')['ok'])  # control: the runner works
            self.assertIn('not allowed', plot.render(table, 'x = open("/etc/passwd").read()')['error'])  # layer 1: AST check
            with mock.patch('ai.plot.check_code'):  # layer 2 alone: the runner's builtins whitelist
                self.assertIn("name 'open' is not defined", plot.render(table, 'x = open("/etc/passwd").read()')['error'])
            self.assertIn('timed out', plot.render(table, 'while True:\n    pass')['error'])

    @skipUnless(importlib.util.find_spec('matplotlib'), 'needs matplotlib')
    @mock.patch.dict('os.environ', {'DJANGO_SECRET_KEY': 'hunter2-secret', 'S3_SECRET_ACCESS_KEY': 'topsecret-s3'})
    def test_plot_code_cannot_see_worker_secrets(self):
        table = '\\begin{tabular}{lr}A & 1 \\\\ B & 2\\end{tabular}'
        # an attribute chain the AST check cannot catch: pyplot imports sys, sys.modules has os
        out = plot.render(table, "raise ValueError(str(dict(plt.sys.modules['os'].environ)))")
        self.assertFalse(out['ok'])
        self.assertIn('MPLBACKEND', out['error'])             # positive control: the code did read the environment
        self.assertNotIn('hunter2-secret', out['error'])
        self.assertNotIn('topsecret-s3', out['error'])
        self.assertNotIn('DJANGO_SECRET_KEY', out['error'])

    @skipUnless(importlib.util.find_spec('matplotlib'), 'needs matplotlib')
    @mock.patch.dict('os.environ', {'S3_SECRET_ACCESS_KEY': 'topsecret-s3-parent'})
    def test_plot_code_cannot_read_its_parents_environment_through_proc(self):
        from config.hardening import make_undumpable
        make_undumpable()  # the Celery worker does this at startup; this test process plays the worker
        table = '\\begin{tabular}{lr}A & 1 \\\\ B & 2\\end{tabular}'
        # `open` is not a forbidden *name* when reached as an attribute, so the AST check alone does not stop this:
        code = ("b = plt.sys.modules['builtins']; o = plt.sys.modules['os']\n"
                "raise ValueError(b.open('/proc/%d/environ' % o.getppid(), 'rb').read()[:400].decode('latin-1'))")
        out = plot.render(table, code)
        self.assertFalse(out['ok'])
        self.assertIn('Permission', out['error'])               # refused by the kernel, not merely empty
        self.assertNotIn('topsecret-s3-parent', out['error'])

    def test_wait_timeout_returns_job_id_and_status_endpoint_serves_result(self):
        fake = self.fake({'content': 'late'})
        with override_settings(AI_WAIT_SECONDS=0), mock.patch('ai.views.run_ai_job.delay'):
            res = self.c.post('/api/llm', {'messages': [], 'llmConfig': self.cfg(fake)}, format='json').data
        self.assertFalse(res['ok'])
        job = Job.objects.get(pk=res['jobId'])
        self.assertEqual(job.status, 'queued')
        ai_tasks.run_ai_job.run(str(job.id), {'apiKey': KEY})  # the worker gets to it later
        status = self.c.get(f'/api/jobs/{job.id}').data
        self.assertEqual((status['status'], status['result']), ('success', {'ok': True, 'content': 'late'}))

    @mock.patch('ai.arxiv.httpx.get')
    def test_arxiv_endpoints(self, get):
        get.return_value = mock.Mock(status_code=200, text=ATOM)
        res = self.c.post('/api/arxiv/search', {'query': 'attention', 'maxResults': 99}, format='json').data
        self.assertEqual(res['papers'], [{'title': 'Attention Is All You Need', 'abstract': 'The dominant models',
                                          'authors': ['A. Vaswani', 'N. Shazeer'], 'url': 'http://arxiv.org/abs/1706.03762v7',
                                          'arxivId': '1706.03762v7'}])
        self.assertEqual(get.call_args.kwargs['params']['max_results'], 10)  # clamped
        self.assertEqual(self.c.post('/api/arxiv/search', {'query': ' '}, format='json').data['error'], 'Missing query.')
        bib = self.c.post('/api/arxiv/bibtex', {'arxivId': 'https://arxiv.org/abs/1706.03762v7'}, format='json').data
        self.assertTrue(bib['ok'])
        self.assertEqual(bib['entry']['year'], '2017')
        self.assertIn('author={A. Vaswani and N. Shazeer}', bib['bibtex'])
        self.assertEqual(self.c.post('/api/arxiv/bibtex', {'arxivId': ''}, format='json').data['error'], 'Invalid arXiv ID.')
        get.return_value = mock.Mock(status_code=503, text='')
        self.assertEqual(self.c.post('/api/arxiv/search', {'query': 'x'}, format='json').data['error'], 'arXiv search failed: 503')


WS_KEY = 'sk-workspace-SECRET-4242'


@override_settings(LLM_ALLOW_PRIVATE_ENDPOINTS=True)
class WorkspaceKeyTests(ApiBase):
    """A workspace provider replaces the browser's key for members who can write; precedence and permissions."""

    def setUp(self):
        super().setUp()
        sync = lambda job_id, secrets=None: ai_tasks.run_ai_job.run(job_id, secrets)
        patcher = mock.patch('ai.views.run_ai_job.delay', side_effect=sync)
        self.delay = patcher.start()
        self.addCleanup(patcher.stop)
        self.pid = self.new_project()
        self.project = Project.objects.get(pk=self.pid)

    def fake(self, *replies):
        fake = FakeLLM(replies or [{'content': 'ok'}] * 4)
        self.addCleanup(fake.close)
        return fake

    def set_workspace_key(self, fake, model='ws-model'):
        from integrations import llmconfig
        llmconfig.save(self.project.workspace, self.user, fake.url, model, WS_KEY)

    def browser_cfg(self, fake):
        return {'endpoint': fake.url, 'apiKey': KEY, 'model': 'browser-model'}

    def member(self, role):
        user = make_user(f'{role}@example.com')
        Membership.objects.create(workspace=self.project.workspace, user=user, role=role)
        return client_for(user)

    def assert_ws_key_not_persisted(self):
        for job in Job.objects.all():
            blob = json.dumps([job.params, job.result, job.progress_log, job.error])
            self.assertNotIn(WS_KEY, blob)
            self.assertNotIn(KEY, blob)
            self.assertNotIn('apiKey', blob)

    def used(self, fake):
        return [(r['auth'], r['body']['model']) for r in fake.requests]

    def test_llm_with_project_uses_the_workspace_key_over_the_browsers(self):
        ws, browser = self.fake(), self.fake()
        self.set_workspace_key(ws)
        res = self.c.post('/api/llm', {'messages': [], 'projectId': self.pid, 'llmConfig': self.browser_cfg(browser)}, format='json')
        self.assertEqual(res.data, {'ok': True, 'content': 'ok'})
        self.assertEqual(self.used(ws), [(f'Bearer {WS_KEY}', 'ws-model')])
        self.assertEqual(browser.requests, [])
        self.assertEqual(self.delay.call_args.args[1], {'apiKey': WS_KEY})  # only as a task argument
        self.assert_ws_key_not_persisted()

    def test_works_with_no_key_from_the_browser(self):
        ws = self.fake()
        self.set_workspace_key(ws)
        self.assertTrue(self.c.post('/api/llm', {'messages': [], 'projectId': self.pid}, format='json').data['ok'])

    def test_without_a_workspace_key_the_browsers_key_is_used(self):
        browser = self.fake()
        self.c.post('/api/llm', {'messages': [], 'projectId': self.pid, 'llmConfig': self.browser_cfg(browser)}, format='json')
        self.assertEqual(self.used(browser), [(f'Bearer {KEY}', 'browser-model')])

    def test_removing_the_workspace_key_returns_to_the_browsers(self):
        from integrations.models import WorkspaceLlmConfig
        ws, browser = self.fake(), self.fake()
        self.set_workspace_key(ws)
        WorkspaceLlmConfig.objects.all().delete()
        self.c.post('/api/llm', {'messages': [], 'projectId': self.pid, 'llmConfig': self.browser_cfg(browser)}, format='json')
        self.assertEqual(ws.requests, [])
        self.assertEqual(len(browser.requests), 1)

    def test_llm_without_a_project_ignores_the_workspace_key(self):
        ws, browser = self.fake(), self.fake()
        self.set_workspace_key(ws)
        self.c.post('/api/llm', {'messages': [], 'llmConfig': self.browser_cfg(browser)}, format='json')
        self.assertEqual(ws.requests, [])
        self.assertEqual(len(browser.requests), 1)

    def test_agent_and_vision_use_it(self):
        ws = self.fake({'content': 'chat reply'}, {'content': '\\begin{equation}x\\end{equation}'})
        self.set_workspace_key(ws)
        res = self.c.post('/api/agent/run', {'projectId': self.pid, 'prompt': 'help', 'selection': 's', 'interaction': 'chat'}, format='json').data
        self.assertTrue(res['ok'], res)
        res = self.c.post('/api/vision/latex', {'image': SimpleUploadedFile('eq.png', b'\x89PNGdata', content_type='image/png'),
                                                'projectId': self.pid, 'mode': 'equation'}, format='multipart').data
        self.assertTrue(res['ok'], res)
        self.assertEqual(self.used(ws), [(f'Bearer {WS_KEY}', 'ws-model')] * 2)
        self.assert_ws_key_not_persisted()

    def test_plot_job_params_get_the_workspace_provider(self):
        ws = self.fake()
        self.set_workspace_key(ws)
        with mock.patch('ai.views.run_job', return_value=Response({})) as run:
            self.c.post('/api/plot/from-table', {'projectId': self.pid, 'tableLatex': 'a', 'llmConfig': self.browser_cfg(ws)}, format='json')
        job_type, params, secrets = run.call_args.args[1:4]
        self.assertEqual(secrets, {'apiKey': WS_KEY})
        self.assertEqual(params['llmConfig'], {'endpoint': ws.url + '/chat/completions', 'model': 'ws-model'})

    def test_viewers_and_commenters_do_not_get_the_workspace_key(self):
        ws, browser = self.fake(), self.fake()
        self.set_workspace_key(ws)
        for role in (Membership.VIEWER, Membership.COMMENTER):
            self.member(role).post('/api/llm', {'messages': [], 'projectId': self.pid, 'llmConfig': self.browser_cfg(browser)}, format='json')
        self.assertEqual(ws.requests, [])
        self.assertEqual(len(browser.requests), 2)

    def test_editors_get_it_and_outsiders_cannot_name_the_project(self):
        ws = self.fake()
        self.set_workspace_key(ws)
        self.assertTrue(self.member(Membership.EDITOR).post('/api/llm', {'messages': [], 'projectId': self.pid}, format='json').data['ok'])
        stranger = client_for(make_user('stranger@example.com'))
        self.assertEqual(stranger.post('/api/llm', {'messages': [], 'projectId': self.pid}, format='json').status_code, 404)
        self.assertEqual(len(ws.requests), 1)

    def test_workspace_key_is_scoped_to_its_workspace(self):
        ws, browser = self.fake(), self.fake()
        self.set_workspace_key(ws)
        other = self.c.post('/api/workspaces', {'name': 'Other'}, format='json').data['workspace']['id']
        pid2 = self.new_project('Elsewhere', workspaceId=other)
        self.c.post('/api/llm', {'messages': [], 'projectId': pid2, 'llmConfig': self.browser_cfg(browser)}, format='json')
        self.assertEqual(ws.requests, [])
        self.assertEqual(len(browser.requests), 1)
