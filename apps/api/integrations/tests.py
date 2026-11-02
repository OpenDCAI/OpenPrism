import logging
from unittest import mock

from django.db import connection
from django.test import override_settings
from cryptography.fernet import Fernet

from common.testing import FakeZotero
from projects.test_api import ApiBase, client_for, make_user

from . import crypto
from .models import ZoteroConnection
from .zotero import get_zotero_key

KEY = 'zk-SECRET-abcdef1234'
CURRENT = {'userID': 4242, 'username': 'ada', 'access': {'user': {'library': True}}}


class ZoteroBase(ApiBase):
    def setUp(self):
        super().setUp()
        self.fake = FakeZotero({'/keys/current': (200, CURRENT)})
        self.addCleanup(self.fake.close)
        ov = override_settings(ZOTERO_API_BASE=self.fake.url)
        ov.enable()
        self.addCleanup(ov.disable)

    def connect(self, client=None):
        return (client or self.c).put('/api/integrations/zotero', {'apiKey': KEY}, format='json')


class ConnectionTests(ZoteroBase):
    def test_save_status_and_disconnect(self):
        self.assertEqual(self.c.get('/api/integrations/zotero').json(), {'ok': True, 'connected': False})
        res = self.connect().json()
        self.assertEqual(res, {'ok': True, 'connected': True, 'username': 'ada', 'lastFour': '1234'})
        self.assertEqual(self.fake.requests[0]['key'], KEY)
        self.assertEqual(self.fake.requests[0]['version'], '3')
        self.assertEqual(self.c.get('/api/integrations/zotero').json()['lastFour'], '1234')
        self.assertEqual(get_zotero_key(self.user), (4242, KEY))
        self.assertTrue(self.c.delete('/api/integrations/zotero').json()['ok'])
        self.assertFalse(self.c.get('/api/integrations/zotero').json()['connected'])
        self.assertFalse(ZoteroConnection.objects.exists())

    def test_invalid_key_is_rejected_and_not_stored(self):
        self.fake.routes['/keys/current'] = (403, 'Forbidden')
        res = self.connect().json()
        self.assertFalse(res['ok'])
        self.assertIn('Reconnect', res['error'])
        self.assertFalse(ZoteroConnection.objects.exists())

    def test_empty_key_and_unreachable_zotero(self):
        self.assertFalse(self.c.put('/api/integrations/zotero', {'apiKey': ' '}, format='json').json()['ok'])
        self.fake.close()
        res = self.connect().json()
        self.assertFalse(res['ok'])
        self.assertIn('reach Zotero', res['error'])

    def test_reconnect_replaces_the_key(self):
        self.connect()
        self.c.put('/api/integrations/zotero', {'apiKey': 'second-key-9999'}, format='json')
        self.assertEqual(ZoteroConnection.objects.count(), 1)
        self.assertEqual(get_zotero_key(self.user)[1], 'second-key-9999')

    def test_users_are_isolated_and_login_is_required(self):
        self.connect()
        other = client_for(make_user('other@example.com'))
        self.assertFalse(other.get('/api/integrations/zotero').json()['connected'])
        other.delete('/api/integrations/zotero')
        self.assertTrue(self.c.get('/api/integrations/zotero').json()['connected'])
        from rest_framework.test import APIClient
        self.assertEqual(APIClient().get('/api/integrations/zotero').status_code, 401)

    def test_key_is_never_returned_or_stored_in_plaintext(self):
        res = self.connect()
        self.assertNotIn(KEY, res.content.decode())
        self.assertNotIn(KEY, self.c.get('/api/integrations/zotero').content.decode())
        with connection.cursor() as cur:
            cur.execute('SELECT api_key_encrypted FROM integrations_zoteroconnection')
            raw = bytes(cur.fetchone()[0])
        self.assertNotIn(KEY.encode(), raw)
        self.assertEqual(crypto.decrypt(raw), KEY)

    def test_key_is_not_logged(self):
        with self.assertLogs(level=logging.DEBUG) as logs:
            logging.getLogger('probe').debug('start')
            self.connect()
            self.fake.routes['/keys/current'] = (500, 'boom')
            self.connect()
        self.assertNotIn(KEY, '\n'.join(logs.output))


class RotationTests(ZoteroBase):
    def test_old_rows_stay_readable_after_adding_a_new_first_key(self):
        self.connect()
        new = Fernet.generate_key().decode()
        with override_settings(CREDENTIAL_ENCRYPTION_KEY=f'{new},{crypto.settings.CREDENTIAL_ENCRYPTION_KEY}'):
            self.assertEqual(get_zotero_key(self.user)[1], KEY)
            fresh = crypto.encrypt('x')
        with override_settings(CREDENTIAL_ENCRYPTION_KEY=new):
            self.assertEqual(crypto.decrypt(fresh), 'x')
            with self.assertRaises(ValueError):  # the old key is gone: old rows are unreadable, with a clear message
                get_zotero_key(self.user)
