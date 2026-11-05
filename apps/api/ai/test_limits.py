"""Rate limits, the server-key policy and quota, workspace daily limits and usage counts (v0.0.8, #48)."""
from datetime import timedelta
from unittest import mock

from django.test import override_settings
from django.utils import timezone

from collab import tokens
from common.testing import FakeLLM
from integrations import llmconfig
from integrations.models import LlmUsage, WorkspaceLlmConfig
from jobs.models import Job
from projects import files
from projects.models import Membership, Project
from projects.test_api import ApiBase, client_for, make_user
from transfer import mineru

from . import tasks as ai_tasks
from . import usage

KEY, SERVER_KEY, WS_KEY = 'sk-browser-KEY', 'sk-SERVER-KEY', 'sk-WORKSPACE-KEY'


@override_settings(LLM_ALLOW_PRIVATE_ENDPOINTS=True)  # the fake LLM listens on localhost
class LimitBase(ApiBase):
    def setUp(self):
        super().setUp()
        sync = lambda job_id, secrets=None: ai_tasks.run_ai_job.run(job_id, secrets)  # run the worker task inline
        patcher = mock.patch('ai.views.run_ai_job.delay', side_effect=sync)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.pid = self.new_project()
        self.project = Project.objects.get(pk=self.pid)

    def fake(self, n=6):
        fake = FakeLLM([{'content': 'ok'}] * n)
        self.addCleanup(fake.close)
        return fake

    def server(self, fake):
        """The workers' OPENPRISM_LLM_* pointing at `fake`."""
        patcher = mock.patch.dict('os.environ', {'OPENPRISM_LLM_API_KEY': SERVER_KEY, 'OPENPRISM_LLM_ENDPOINT': fake.url,
                                                 'OPENPRISM_LLM_MODEL': 'server-model'})
        patcher.start()
        self.addCleanup(patcher.stop)

    def llm(self, client=None, cfg=None, project=True):
        body = {'messages': [{'role': 'user', 'content': 'hi'}]}
        if cfg is not None:
            body['llmConfig'] = cfg
        if project:
            body['projectId'] = self.pid
        return (client or self.c).post('/api/llm', body, format='json')


class RateLimitTests(LimitBase):
    @override_settings(AI_RATE_PER_MINUTE=2)
    def test_ai_requests_are_limited_per_user_with_retry_after(self):
        fake = self.fake()
        cfg = {'endpoint': fake.url, 'apiKey': KEY}
        self.assertTrue(self.llm(cfg=cfg).data['ok'])
        self.assertEqual(self.c.post('/api/agent/run', {'prompt': 'x', 'interaction': 'chat', 'llmConfig': cfg},
                                     format='json').status_code, 200)  # agent shares the limit
        res = self.llm(cfg=cfg)
        self.assertEqual(res.status_code, 429)
        self.assertFalse(res.data['ok'])
        self.assertTrue(res.data['error'].startswith('Too many requests: try again in a minute.'))
        self.assertTrue(1 <= int(res['Retry-After']) <= 61)
        for path, body in (('/api/plot/from-table', {'projectId': self.pid, 'tableLatex': 'a'}),
                           ('/api/transfer/start', {'sourceProjectId': self.pid})):
            self.assertEqual(self.c.post(path, body, format='json').status_code, 429)
        other = client_for(make_user('other@example.com'))
        self.assertEqual(self.llm(other, cfg, project=False).status_code, 200)  # someone else is unaffected
        self.assertEqual(Job.objects.count(), 3)  # refused requests created nothing

    @override_settings(COMPILE_RATE_PER_MINUTE=2)
    def test_compiles_are_limited_per_user_and_guests_per_invite(self):
        files.write_text(self.project, 'main.tex', 'x')
        with mock.patch('jobs.views.compile_project.delay'):
            for _ in range(2):
                self.assertTrue(self.c.post('/api/compile', {'projectId': self.pid}, format='json').data['ok'])
                Job.objects.update(status=Job.SUCCESS)  # finished, so the 3-active limit does not interfere
            res = self.c.post('/api/compile', {'projectId': self.pid}, format='json')
            self.assertEqual(res.status_code, 429)
            self.assertIn('Retry-After', res)
            token, _ = tokens.create_invite(self.project, self.user, 'editor')
            from rest_framework.test import APIClient
            guest = APIClient()
            guest.credentials(HTTP_AUTHORIZATION=f'Bearer {token}')
            self.assertEqual(guest.post('/api/compile', {'projectId': self.pid}, format='json').status_code, 200)

    @override_settings(AI_RATE_PER_MINUTE=1)
    def test_arxiv_import_is_limited_too(self):
        with mock.patch('projects.views.import_arxiv.delay'), mock.patch('projects.views.time.sleep', side_effect=StopIteration):
            self.llm(cfg={'endpoint': 'https://x.test', 'apiKey': KEY})
            res = self.c.get('/api/projects/import-arxiv-sse', {'arxivIdOrUrl': '2101.00001'})
            self.assertIn(b'Too many requests', b''.join(res.streaming_content))


class ServerKeyTests(LimitBase):
    def test_the_server_key_never_goes_to_an_endpoint_the_request_names(self):
        server, attacker = self.fake(), self.fake()
        self.server(server)
        self.assertTrue(self.llm(cfg={'endpoint': attacker.url, 'model': 'expensive'}).data['ok'])
        self.assertEqual(attacker.requests, [])
        self.assertEqual([(r['auth'], r['body']['model']) for r in server.requests], [(f'Bearer {SERVER_KEY}', 'server-model')])
        job = Job.objects.get()
        self.assertEqual((job.params['keySource'], job.params['llmConfig']), ('server', {}))

    def test_the_worker_also_refuses_to_pair_its_key_with_a_requests_endpoint(self):
        from . import llm
        with mock.patch.dict('os.environ', {'OPENPRISM_LLM_API_KEY': SERVER_KEY, 'OPENPRISM_LLM_ENDPOINT': 'https://ops.test'}):
            cfg = llm.resolve_config({'endpoint': 'https://evil.test', 'model': 'x'})
            self.assertEqual((cfg['endpoint'], cfg['api_key']), ('https://ops.test', SERVER_KEY))
            self.assertEqual(llm.resolve_config({'endpoint': 'https://own.test', 'apiKey': 'k'})['endpoint'], 'https://own.test')

    def test_mineru_server_token_goes_only_to_the_server_base(self):
        with override_settings(MINERU_TOKEN='OPS', MINERU_API_BASE='https://mineru.ops'):
            self.assertEqual(mineru.resolve_config({'apiBase': 'https://evil.test'}, '')['apiBase'], 'https://mineru.ops')
            self.assertEqual(mineru.resolve_config({'apiBase': 'https://own.test'}, 'MINE')['apiBase'], 'https://own.test')

    def test_policy(self):
        server, browser = self.fake(), self.fake()
        self.server(server)
        own = {'endpoint': browser.url, 'apiKey': KEY}
        with override_settings(SERVER_LLM_KEY_USERS='none'):
            res = self.llm()
            self.assertEqual(res.status_code, 403)
            self.assertIn('Add your own key', res.data['error'])
            self.assertFalse(Job.objects.exists())  # refused before anything was queued
            self.assertTrue(self.llm(cfg=own).data['ok'])  # bringing a key always passes the policy
        with override_settings(SERVER_LLM_KEY_USERS='staff'):
            self.assertEqual(self.llm().status_code, 403)
            type(self.user).objects.filter(pk=self.user.pk).update(is_staff=True)
            self.assertEqual(self.llm().status_code, 200)
        with override_settings(SERVER_LLM_KEY_USERS='verified'):
            type(self.user).objects.filter(pk=self.user.pk).update(email_verified_at=None)
            self.assertEqual(self.llm().status_code, 403)
            type(self.user).objects.filter(pk=self.user.pk).update(email_verified_at=timezone.now())
            self.assertEqual(self.llm().status_code, 200)

    @override_settings(SERVER_LLM_DAILY_QUOTA=2)
    def test_daily_quota_on_the_server_key(self):
        server, browser = self.fake(10), self.fake()
        self.server(server)
        self.assertTrue(self.llm().data['ok'])
        self.assertTrue(self.llm(project=False).data['ok'])  # counted per user, with or without a project
        self.assertTrue(self.llm(cfg={'endpoint': browser.url, 'apiKey': KEY}).data['ok'])  # other keys do not count
        res = self.llm()
        self.assertEqual(res.status_code, 429)
        self.assertIn("today's AI requests", res.data['error'])
        self.assertGreater(int(res['Retry-After']), 0)
        tomorrow = timezone.now().date() + timedelta(days=1)
        with mock.patch('ai.usage.today', return_value=tomorrow):
            self.assertTrue(self.llm().data['ok'])
        rows = sorted((r.day == tomorrow, r.source, r.workspace_id is not None, r.count) for r in LlmUsage.objects.all())
        self.assertEqual(rows, [(False, 'browser', True, 1), (False, 'server', False, 1), (False, 'server', True, 1),
                                (True, 'server', True, 1)])  # the refused fourth request is not counted


class WorkspaceLimitTests(LimitBase):
    def setUp(self):
        super().setUp()
        self.ws = self.fake(10)
        llmconfig.save(self.project.workspace, self.user, self.ws.url, 'm', WS_KEY)
        self.url = f'/api/workspaces/{self.project.workspace_id}/llm'

    def test_daily_limit_refuses_without_falling_back_and_usage_is_reported(self):
        browser = self.fake()
        self.assertEqual(self.c.put(self.url, {'dailyLimit': 2}, format='json').data['dailyLimit'], 2)
        for _ in range(2):
            self.assertTrue(self.llm(cfg={'endpoint': browser.url, 'apiKey': KEY}).data['ok'])
        res = self.llm(cfg={'endpoint': browser.url, 'apiKey': KEY})
        self.assertEqual(res.status_code, 429)
        self.assertEqual(res.data['error'], "This workspace's daily AI limit is used up.")
        self.assertEqual(browser.requests, [])  # no silent fallback to another key
        LlmUsage.objects.create(day=timezone.now().date() - timedelta(days=10), user=self.user,
                                workspace=self.project.workspace, source='workspace', count=5)
        LlmUsage.objects.create(day=timezone.now().date() - timedelta(days=40), user=self.user,
                                workspace=self.project.workspace, source='workspace', count=99)
        self.assertEqual(self.c.get(self.url).data['usage'], {'today': 2, 'last30Days': 7})
        self.assertEqual(Job.objects.get(params__keySource='workspace', pk=Job.objects.first().pk).params['keySource'], 'workspace')

    def test_validation_and_who_sees_it(self):
        for bad in (0, -1, 'abc', 100001, 2.5, True):
            res = self.c.put(self.url, {'dailyLimit': bad}, format='json').data
            self.assertFalse(res['ok'], bad)
            self.assertIn('daily limit', res['error'])
        self.c.put(self.url, {'dailyLimit': 5}, format='json')
        self.c.put(self.url, {'model': 'm2'}, format='json')  # leaving it out keeps it
        self.assertEqual(WorkspaceLlmConfig.objects.get().daily_limit, 5)
        self.assertIsNone(self.c.put(self.url, {'dailyLimit': None}, format='json').data['dailyLimit'])
        editor = make_user('ed@example.com')
        Membership.objects.create(workspace=self.project.workspace, user=editor, role=Membership.EDITOR)
        body = client_for(editor).get(self.url).data
        self.assertNotIn('dailyLimit', body)
        self.assertNotIn('usage', body)
        self.assertEqual(client_for(editor).put(self.url, {'dailyLimit': 3}, format='json').status_code, 403)


class UsagePruneTests(LimitBase):
    def test_old_counts_are_pruned(self):
        from integrations.tasks import prune_llm_usage
        today = timezone.now().date()
        for age in (0, 399, 401):
            LlmUsage.objects.create(day=today - timedelta(days=age), user=self.user, source='server', count=1)
        self.assertEqual(prune_llm_usage(), 1)
        self.assertEqual(LlmUsage.objects.count(), 2)

    def test_usage_rows_are_unique_with_null_workspace(self):
        req = mock.Mock(user=self.user)
        usage.charge(req, 'browser', None)
        usage.charge(req, 'browser', None)
        self.assertEqual(list(LlmUsage.objects.values_list('count', flat=True)), [2])
