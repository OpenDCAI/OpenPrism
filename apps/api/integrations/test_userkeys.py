"""Users' own AI keys stored encrypted on the server (v0.0.8, #50)."""
import json
from unittest import mock

from django.db import connection
from django.test import override_settings
from rest_framework.test import APIClient

from ai import tasks as ai_tasks
from collab import tokens
from common.testing import FakeLLM
from jobs.models import Job
from projects.models import Membership, Project
from projects.test_api import ApiBase, client_for, make_user

from . import llmconfig
from .models import AiProfile, CredentialEvent

KEY, KEY2, SEARCH_KEY, MINERU, WS_KEY = 'sk-USER-SECRET-1111', 'sk-USER-SECRET-2222', 'sk-SEARCH-SECRET-3333', \
    'mineru-SECRET-4444', 'sk-WS-SECRET-5555'
URL = '/api/integrations/ai-keys'


@override_settings(LLM_ALLOW_PRIVATE_ENDPOINTS=True)  # the fake LLM listens on localhost
class UserKeyTests(ApiBase):
    def setUp(self):
        super().setUp()
        sync = lambda job_id, secrets=None: ai_tasks.run_ai_job.run(job_id, secrets)
        patcher = mock.patch('ai.views.run_ai_job.delay', side_effect=sync)
        self.delay = patcher.start()
        self.addCleanup(patcher.stop)

    def fake(self, n=4):
        fake = FakeLLM([{'content': 'ok'}] * n)
        self.addCleanup(fake.close)
        return fake

    def put(self, profile, client=None, **body):
        return (client or self.c).put(f'{URL}/{profile}', body, format='json').json()

    def assert_no_secret_persisted(self):
        with connection.cursor() as cur:
            cur.execute("SELECT encode(api_key_encrypted, 'escape') FROM integrations_aiprofile")
            stored = json.dumps(cur.fetchall())
        jobs = json.dumps([[j.params, j.result, j.progress_log, j.error] for j in Job.objects.all()])
        events = json.dumps(list(CredentialEvent.objects.values_list('detail', 'last_four')))
        for secret in (KEY, KEY2, SEARCH_KEY, MINERU, WS_KEY):
            for blob in (stored, jobs, events):
                self.assertNotIn(secret, blob)

    def test_save_status_rotate_and_remove_never_return_the_key(self):
        self.assertEqual(self.c.get(URL).json(), {'ok': True, 'profiles': {'llm': None, 'search': None, 'vision': None, 'mineru': None}})
        self.assertEqual(self.put('llm', model='m')['error'], 'Enter an API key.')
        res = self.put('llm', endpoint='https://llm.example.com/v1', model='m1', apiKey=KEY)
        self.assertEqual({k: res['profiles']['llm'][k] for k in ('endpoint', 'model', 'lastFour')},
                         {'endpoint': 'https://llm.example.com/v1/chat/completions', 'model': 'm1', 'lastFour': '1111'})
        self.assertEqual(self.put('llm', model='m2')['profiles']['llm']['model'], 'm2')  # model alone: no key needed
        self.assertEqual(self.put('llm', endpoint='https://other.example.com/v1')['error'],
                         'Enter the API key again to change the endpoint.')
        self.assertEqual(self.put('llm', endpoint='https://other.example.com/v1', apiKey=KEY2)['profiles']['llm']['lastFour'], '2222')
        self.assertEqual(self.c.put(f'{URL}/nope', {}, format='json').status_code, 404)
        self.assertIsNone(self.c.delete(f'{URL}/llm').json()['profiles']['llm'])
        actions = list(CredentialEvent.objects.order_by('created_at').values_list('kind', 'action', 'detail'))
        # A person's keys are the settings of their personal workspace (#78), so the history is that workspace's.
        self.assertEqual([a[:2] for a in actions], [('workspace_llm', 'set'), ('workspace_llm', 'updated'), ('workspace_llm', 'rotated'), ('workspace_llm', 'removed')])
        self.assertEqual(actions[1][2], {'model': 'm2'})
        self.assert_no_secret_persisted()
        for res in (self.c.get(URL), self.c.get('/api/integrations/credential-events')):
            self.assertNotIn(KEY2, res.content.decode())

    @override_settings(LLM_ALLOW_PRIVATE_ENDPOINTS=False)
    def test_private_endpoints_are_refused(self):
        self.assertIn('non-public', self.put('llm', endpoint='http://127.0.0.1:9/v1', apiKey=KEY)['error'])
        self.assertIn('non-public', self.put('mineru', endpoint='http://10.0.0.1/api', apiKey=MINERU)['error'])

    def test_requests_use_the_saved_key_with_its_own_endpoint_and_profiles_fall_back_to_llm(self):
        main, search, attacker = self.fake(), self.fake(), self.fake()
        self.put('llm', endpoint=main.url, model='main-model', apiKey=KEY)
        pid = self.new_project()   # in the personal workspace, where these keys apply
        body = {'messages': [], 'projectId': pid, 'llmConfig': {'profile': 'vision', 'endpoint': attacker.url}}
        self.assertTrue(self.c.post('/api/llm', body, format='json').data['ok'])  # vision unset: the llm profile
        self.put('search', endpoint=search.url, model='search-model', apiKey=SEARCH_KEY)
        self.c.post('/api/llm', {'messages': [], 'projectId': pid, 'llmConfig': {'profile': 'search'}}, format='json')
        self.assertEqual(attacker.requests, [])  # the saved key goes only with the saved endpoint
        self.assertEqual([(r['auth'], r['body']['model']) for r in main.requests], [(f'Bearer {KEY}', 'main-model')])
        self.assertEqual([(r['auth'], r['body']['model']) for r in search.requests], [(f'Bearer {SEARCH_KEY}', 'search-model')])
        self.assertEqual(set(Job.objects.values_list('params__keySource', flat=True)), {'workspace'})
        self.assertEqual(self.delay.call_args.args[1], {'apiKey': SEARCH_KEY})  # only as a task argument
        self.assert_no_secret_persisted()

    def test_a_workspace_provider_wins_and_a_request_key_still_works(self):
        mine, ws, own = self.fake(), self.fake(), self.fake()
        self.put('llm', endpoint=mine.url, apiKey=KEY)
        pid = self.new_project()
        with mock.patch('integrations.aiprofiles.assert_public_url'):
            llmconfig.save(Project.objects.get(pk=pid).workspace, self.user, ws.url, 'ws', WS_KEY)
        self.c.post('/api/llm', {'messages': [], 'projectId': pid, 'llmConfig': {'profile': 'llm'}}, format='json')
        self.c.post('/api/llm', {'messages': [], 'llmConfig': {'endpoint': own.url, 'apiKey': KEY2}}, format='json')
        self.assertEqual((len(ws.requests), len(own.requests), len(mine.requests)), (1, 1, 0))

    def test_mineru_uses_the_saved_token_and_base(self):
        self.put('mineru', endpoint='https://mineru.example.com/api/v4', apiKey=MINERU)
        pid = self.new_project()
        from templates_app.models import Template
        template = Template.objects.create(id='t-userkeys', label='T', main_file='main.tex')
        with mock.patch('transfer.views.job_secrets.put') as put_secrets:
            res = self.c.post('/api/transfer/start-mineru', {'sourceProjectId': pid, 'sourceMainFile': 'main.tex',
                                                             'targetTemplateId': str(template.id),
                                                             'targetMainFile': 'main.tex'}, format='json').data
        job = Job.objects.get(pk=res['jobId'])
        self.assertEqual(job.params['mineruConfig']['apiBase'], 'https://mineru.example.com/api/v4')
        self.assertEqual(put_secrets.call_args.args[1]['mineruToken'], MINERU)
        self.assert_no_secret_persisted()

    def test_guests_and_strangers(self):
        pid = self.new_project()
        token, _ = tokens.create_invite(Project.objects.get(pk=pid), self.user, 'editor')
        guest = APIClient()
        guest.credentials(HTTP_AUTHORIZATION=f'Bearer {token}')
        self.assertEqual(guest.get(URL).status_code, 403)
        self.assertEqual(APIClient().get(URL).status_code, 401)
        self.put('llm', apiKey=KEY)
        other = client_for(make_user('other@example.com'))
        self.assertIsNone(other.get(URL).json()['profiles']['llm'])  # each user sees only their own

    def test_deleting_the_account_deletes_the_keys(self):
        self.put('llm', apiKey=KEY)
        self.put('mineru', apiKey=MINERU)
        res = self.c.delete('/api/auth/me', {'password': 'correct-horse-battery'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(AiProfile.objects.exists())
