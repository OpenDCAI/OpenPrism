"""The credential event log (v0.0.8, #49)."""
import json
from unittest import mock

from django.db import connection
from django.test import override_settings

from common.testing import FakeZotero
from projects.models import Membership
from projects.test_api import ApiBase, client_for, make_user

from .models import CredentialEvent

LLM_KEY, LLM_KEY2, ZKEY, ZKEY2 = 'sk-LLM-SECRET-1111', 'sk-LLM-SECRET-2222', 'zk-SECRET-aaaa3333', 'zk-SECRET-bbbb4444'
CURRENT = {'userID': 4242, 'username': 'ada', 'access': {'user': {'library': True}}}


class AuditBase(ApiBase):
    def setUp(self):
        super().setUp()
        pub = mock.patch('integrations.aiprofiles.assert_public_url')  # no DNS in tests; the guard has its own tests
        pub.start()
        self.addCleanup(pub.stop)

    def events(self, client=None, url=None):
        return (client or self.c).get(url or self.events_url).json()

    def assert_no_secret_anywhere(self, *responses):
        with connection.cursor() as cur:
            cur.execute('SELECT kind, action, last_four, detail::text, actor_name FROM integrations_credentialevent')
            table = json.dumps(cur.fetchall())
        for secret in (LLM_KEY, LLM_KEY2, ZKEY, ZKEY2):
            self.assertNotIn(secret, table)
            for res in responses:
                self.assertNotIn(secret, json.dumps(res))


class WorkspaceEventTests(AuditBase):
    def setUp(self):
        super().setUp()
        self.ws = self.c.post('/api/workspaces', {'name': 'Lab'}, format='json').data['workspace']['id']
        self.url = f'/api/workspaces/{self.ws}/llm'
        self.events_url = f'/api/workspaces/{self.ws}/credential-events'

    def put(self, **body):
        return self.c.put(self.url, body, format='json').json()

    def test_each_change_is_one_event_and_identical_saves_none(self):
        self.put(endpoint='https://llm.example.com/v1', model='gpt-x', apiKey=LLM_KEY)
        self.put(endpoint='https://llm.example.com/v1', model='gpt-x', apiKey=LLM_KEY)  # identical
        self.put(model='gpt-x')  # identical
        self.put(model='gpt-4o')
        self.put(apiKey=LLM_KEY2)
        self.put(dailyLimit=50)
        self.c.delete(self.url)
        self.c.delete(self.url)  # nothing left to remove
        body = self.events()
        got = [(e['action'], e['lastFour'], e['detail']) for e in reversed(body['events'])]
        self.assertEqual(got, [
            ('set', '1111', {'endpoint': 'https://llm.example.com/v1/chat/completions', 'model': 'gpt-x'}),
            ('updated', '1111', {'model': 'gpt-4o'}),
            ('rotated', '2222', {}),
            ('updated', '2222', {'dailyLimit': 50}),
            ('removed', '', {}),
        ])
        self.assertEqual({e['kind'] for e in body['events']}, {'workspace_llm'})
        self.assertEqual(body['events'][0]['actor'], {'id': str(self.user.id), 'name': self.user.name or self.user.email})
        self.assert_no_secret_anywhere(body)

    def test_permissions(self):
        editor, viewer = make_user('ed@example.com'), make_user('view@example.com')
        Membership.objects.create(workspace_id=self.ws, user=editor, role=Membership.EDITOR)
        Membership.objects.create(workspace_id=self.ws, user=viewer, role=Membership.VIEWER)
        self.assertEqual(client_for(editor).get(self.events_url).status_code, 403)
        self.assertEqual(client_for(viewer).get(self.events_url).status_code, 403)
        self.assertEqual(client_for(make_user('out@example.com')).get(self.events_url).status_code, 404)
        admin = make_user('admin@example.com')
        Membership.objects.create(workspace_id=self.ws, user=admin, role=Membership.ADMIN)
        self.assertTrue(client_for(admin).get(self.events_url).json()['ok'])

    def test_the_actors_name_survives_their_account_and_events_page(self):
        admin = make_user('gone@example.com')
        Membership.objects.create(workspace_id=self.ws, user=admin, role=Membership.ADMIN)
        client_for(admin).put(self.url, {'apiKey': LLM_KEY}, format='json')
        for model in ('a', 'b', 'c'):
            self.put(model=model)
        admin.delete()
        first = self.c.get(self.events_url, {'limit': 2}).json()
        self.assertEqual((len(first['events']), first['hasMore']), (2, True))
        rest = self.c.get(self.events_url, {'limit': 2, 'before': first['events'][-1]['createdAt']}).json()
        self.assertEqual((len(rest['events']), rest['hasMore']), (2, False))
        oldest = rest['events'][-1]
        self.assertEqual((oldest['action'], oldest['actor'], oldest['actorName']), ('set', None, 'gone@example.com'))


class ZoteroEventTests(AuditBase):
    events_url = '/api/integrations/credential-events'

    def setUp(self):
        super().setUp()
        self.fake = FakeZotero({'/keys/current': (200, CURRENT)})
        self.addCleanup(self.fake.close)
        ov = override_settings(ZOTERO_API_BASE=self.fake.url)
        ov.enable()
        self.addCleanup(ov.disable)

    def test_connect_rotate_disconnect_are_visible_to_that_user_only(self):
        for key in (ZKEY, ZKEY, ZKEY2):
            self.assertTrue(self.c.put('/api/integrations/zotero', {'apiKey': key}, format='json').json()['ok'])
        self.c.delete('/api/integrations/zotero')
        body = self.events()
        self.assertEqual([(e['kind'], e['action'], e['lastFour']) for e in reversed(body['events'])],
                         [('zotero', 'set', '3333'), ('zotero', 'rotated', '4444'), ('zotero', 'removed', '')])
        self.assertEqual(self.events(client_for(make_user('other@example.com')))['events'], [])
        self.assert_no_secret_anywhere(body)

    def test_deleting_the_account_deletes_its_own_events(self):
        self.c.put('/api/integrations/zotero', {'apiKey': ZKEY}, format='json')
        self.user.delete()
        self.assertFalse(CredentialEvent.objects.exists())
