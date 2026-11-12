"""Load models and test the connection in the workspace AI provider form (#76)."""
from unittest import mock

from django.test import override_settings
from rest_framework.test import APIClient

from common.testing import FakeLLM
from jobs.models import Job
from projects.models import Membership
from projects.test_api import ApiBase, client_for, make_user

from .models import CredentialEvent, LlmUsage, AiProfile

KEY, OTHER_KEY = 'sk-PROVIDER-SECRET-1111', 'sk-OTHER-SECRET-2222'


class ProviderFormTests(ApiBase):
    def setUp(self):
        super().setUp()
        self.ws = self.c.post('/api/workspaces', {'name': 'Lab'}, format='json').data['workspace']['id']
        self.base = f'/api/workspaces/{self.ws}/llm'
        for name in ('integrations.aiprofiles.assert_public_url', 'integrations.provider.assert_public_url'):
            p = mock.patch(name)   # the fake provider listens on localhost; the guard has its own test below
            p.start()
            self.addCleanup(p.stop)

    def fake(self, replies=(), models=('gpt-4o', 'gpt-4o-mini', 'o3')):
        f = FakeLLM(list(replies) or [{'content': 'ok'}], models=list(models) if models is not None else None)
        self.addCleanup(f.close)
        return f

    def post(self, what, client=None, **body):
        res = (client or self.c).post(f'{self.base}/{what}', body, format='json')
        return res

    def member(self, email, role):
        user = make_user(email)
        Membership.objects.create(workspace_id=self.ws, user=user, role=role)
        return client_for(user)

    def save_provider(self, fake):
        res = self.c.put(self.base, {'endpoint': fake.url, 'model': 'gpt-4o-mini', 'apiKey': KEY}, format='json')
        self.assertTrue(res.json()['ok'], res.content)

    # --- models ---------------------------------------------------------------------------------------------------

    def test_models_are_listed_sorted_with_the_typed_key(self):
        f = self.fake()
        res = self.post('models', endpoint=f.url, apiKey=KEY)
        self.assertEqual(res.json(), {'ok': True, 'models': ['gpt-4o', 'gpt-4o-mini', 'o3']})
        self.assertEqual(f.requests[0]['path'], '/v1/models')
        self.assertEqual(f.requests[0]['auth'], f'Bearer {KEY}')

    def test_models_with_no_typed_key_use_the_stored_key_for_the_unchanged_endpoint(self):
        f = self.fake()
        self.save_provider(f)
        for body in ({}, {'endpoint': f.url}):
            with self.subTest(body=body):
                f.requests.clear()
                self.assertTrue(self.post('models', **body).json()['ok'])
                self.assertEqual(f.requests[0]['auth'], f'Bearer {KEY}')

    def test_a_changed_endpoint_needs_the_key_typed_again_and_sends_nothing(self):
        stored, elsewhere = self.fake(), self.fake()
        self.save_provider(stored)
        res = self.post('models', endpoint=elsewhere.url)
        self.assertFalse(res.json()['ok'])
        self.assertIn('key', res.json()['error'].lower())
        self.assertEqual(elsewhere.requests, [])           # the stored key never travelled to the new address
        self.assertTrue(self.post('models', endpoint=elsewhere.url, apiKey=OTHER_KEY).json()['ok'])
        self.assertEqual(elsewhere.requests[0]['auth'], f'Bearer {OTHER_KEY}')

    def test_no_key_anywhere_asks_for_one(self):
        f = self.fake()
        res = self.post('models', endpoint=f.url)
        self.assertFalse(res.json()['ok'])
        self.assertEqual(f.requests, [])

    def test_a_provider_without_a_list_leaves_the_model_to_be_typed(self):
        f = self.fake(models=None)   # 404 on /models, like some local servers
        res = self.post('models', endpoint=f.url, apiKey=KEY).json()
        self.assertFalse(res['ok'])
        self.assertIn('404', res['error'])
        self.assertTrue(self.post('test', endpoint=f.url, apiKey=KEY, model='my-deployment').json()['ok'])  # still testable

    # --- test -----------------------------------------------------------------------------------------------------

    def test_a_working_provider_reports_latency_and_gets_one_tiny_request(self):
        f = self.fake([{'content': 'ok'}])
        res = self.post('test', endpoint=f.url, apiKey=KEY, model='gpt-4o-mini').json()
        self.assertTrue(res['ok'])
        self.assertIsInstance(res['latencyMs'], int)
        req = f.requests[0]
        self.assertEqual((req['path'], req['auth']), ('/v1/chat/completions', f'Bearer {KEY}'))
        self.assertEqual(req['body']['model'], 'gpt-4o-mini')
        self.assertLessEqual(req['body']['max_tokens'], 5)

    def test_the_providers_own_error_is_shown_without_the_key(self):
        f = self.fake([(401, f'Incorrect API key provided: {KEY}.')])
        res = self.post('test', endpoint=f.url, apiKey=KEY, model='gpt-4o').json()
        self.assertFalse(res['ok'])
        self.assertIn('Incorrect API key', res['error'])
        self.assertNotIn(KEY, res['error'])

    def test_unknown_model_error_comes_back(self):
        f = self.fake([(404, '{"error": {"message": "The model `nope` does not exist"}}')])
        res = self.post('test', endpoint=f.url, apiKey=KEY, model='nope').json()
        self.assertFalse(res['ok'])
        self.assertIn('does not exist', res['error'])

    def test_a_model_is_required(self):
        self.assertFalse(self.post('test', endpoint=self.fake().url, apiKey=KEY).json()['ok'])

    # --- who, limits, secrecy --------------------------------------------------------------------------------------

    def test_only_admins_may_use_it(self):
        f = self.fake()
        for role in ('editor', 'viewer'):
            c = self.member(f'{role}@example.com', role)
            for what in ('models', 'test'):
                self.assertEqual(self.post(what, c, endpoint=f.url, apiKey=KEY, model='m').status_code, 403)
        self.assertEqual(self.post('models', client_for(make_user('out@example.com')), endpoint=f.url, apiKey=KEY).status_code, 404)
        self.assertEqual(self.post('models', APIClient(), endpoint=f.url, apiKey=KEY).status_code, 401)
        self.assertEqual(f.requests, [])
        admin = self.member('admin@example.com', 'admin')
        self.assertTrue(self.post('models', admin, endpoint=f.url, apiKey=KEY).json()['ok'])

    @override_settings(AI_RATE_PER_MINUTE=2)
    def test_calls_are_rate_limited_per_user(self):
        f = self.fake()
        for _ in range(2):
            self.assertEqual(self.post('models', endpoint=f.url, apiKey=KEY).status_code, 200)
        res = self.post('models', endpoint=f.url, apiKey=KEY)
        self.assertEqual(res.status_code, 429)
        self.assertIn('Retry-After', res)

    def test_nothing_is_stored_logged_counted_or_returned(self):
        f = self.fake()
        responses = [self.post('models', endpoint=f.url, apiKey=KEY).content, self.post('test', endpoint=f.url, apiKey=KEY, model='m').content]
        for body in responses:
            self.assertNotIn(KEY.encode(), body)
        self.assertEqual(AiProfile.objects.count(), 0)    # trying a provider does not save it
        self.assertEqual(CredentialEvent.objects.count(), 0)
        self.assertEqual(LlmUsage.objects.count(), 0)              # test calls do not use the daily limit
        self.assertEqual(Job.objects.count(), 0)

    def test_private_addresses_are_blocked_by_the_ssrf_guard(self):
        mock.patch.stopall()   # use the real guard
        for what in ('models', 'test'):
            res = self.post(what, endpoint='http://127.0.0.1:9/v1', apiKey=KEY, model='m').json()
            self.assertFalse(res['ok'], what)
            self.assertNotIn(KEY, res['error'])
