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


GROUPS = [{'id': 77, 'data': {'name': 'Lab'}}]


def item(key, title, year='2020', item_type='journalArticle', **extra):
    return {'key': key, 'data': {'key': key, 'itemType': item_type, 'title': title, 'date': f'{year}-05-01',
                                 'creators': [{'creatorType': 'author', 'firstName': 'Ada', 'lastName': 'Lovelace'},
                                              {'name': 'Acme Group'}], **extra},
            'meta': {'parsedDate': f'{year}-05-01'}}


class BrowseTests(ZoteroBase):
    def setUp(self):
        super().setUp()
        self.fake.routes.update({
            '/users/4242/groups': (200, GROUPS),
            '/users/4242/items/top': (200, [item('AAAA1111', 'Attention', citationKey='lovelace2020'),
                                            item('NOTE0001', 'a note', item_type='note')], {'Total-Results': '41'}),
            '/groups/77/items/top': (200, [item('GGGG7777', 'Group paper')], {'Total-Results': '1'}),
            '/users/4242/collections/COLL1234/items/top': (200, [item('CCCC1234', 'In collection')]),
            '/users/4242/collections': (200, [{'key': 'COLL1234', 'data': {'name': 'Thesis', 'parentCollection': False}},
                                              {'key': 'SUB00001', 'data': {'name': 'Ch1', 'parentCollection': 'COLL1234'}}]),
        })
        self.connect()
        self.fake.requests.clear()

    def get(self, path, **params):
        return self.c.get(f'/api/integrations/zotero/{path}', params).json()

    def test_not_connected(self):
        self.c.delete('/api/integrations/zotero')
        res = self.get('libraries')
        self.assertEqual(res, {'ok': False, 'error': 'Zotero is not connected.'})

    def test_libraries(self):
        res = self.get('libraries')
        self.assertEqual(res['libraries'], [{'id': 'user', 'type': 'user', 'name': 'My Library'},
                                            {'id': '77', 'type': 'group', 'name': 'Lab'}])

    def test_items_page_and_summary(self):
        res = self.get('items', library='user')
        self.assertEqual(res['total'], 41)
        self.assertEqual(len(res['items']), 1)  # the standalone note is dropped
        self.assertEqual(res['items'][0], {
            'key': 'AAAA1111', 'title': 'Attention', 'creators': ['Ada Lovelace', 'Acme Group'], 'year': '2020',
            'itemType': 'journalArticle', 'citationKey': 'lovelace2020', 'doi': ''})
        q = self.fake.requests[-1]['query']
        self.assertEqual((q['limit'], q['start'], q['format']), ('25', '0', 'json'))

    def test_paging_limit_is_capped(self):
        self.get('items', library='user', start=50, limit=9999)
        q = self.fake.requests[-1]['query']
        self.assertEqual((q['limit'], q['start']), ('50', '50'))

    def test_search_text_is_url_encoded(self):
        self.get('items', library='user', q='a&b=c #1/ü')
        last = self.fake.requests[-1]
        self.assertEqual(last['query']['q'], 'a&b=c #1/ü')
        self.assertEqual(last['path'], '/users/4242/items/top')
        self.assertNotIn('b', last['query'])

    def test_group_library_and_collection_filter(self):
        self.assertEqual(self.get('items', library='77')['items'][0]['key'], 'GGGG7777')
        res = self.get('items', library='user', collection='COLL1234')
        self.assertEqual(res['items'][0]['key'], 'CCCC1234')
        self.assertEqual(self.get('collections', library='user')['collections'], [
            {'key': 'COLL1234', 'name': 'Thesis', 'parent': None}, {'key': 'SUB00001', 'name': 'Ch1', 'parent': 'COLL1234'}])

    def test_library_allow_list_and_path_injection(self):
        for lib in ('99', '../users/1', '77/../../x', '', 'user/items', '7 7'):
            res = self.get('items', library=lib)
            self.assertFalse(res['ok'], lib)
        res = self.get('items', library='user', collection='../../keys')
        self.assertFalse(res['ok'])
        bad = [r['path'] for r in self.fake.requests if r['path'] not in ('/users/4242/groups', '/users/4242/items/top')]
        self.assertEqual(bad, [])

    def test_bad_numbers(self):
        self.assertFalse(self.get('items', library='user', limit='x')['ok'])

    def test_backoff_on_a_good_reply_is_honoured(self):
        self.fake.routes['/users/4242/items/top'] = (200, [], {'Backoff': '3'})
        with mock.patch('integrations.zotero.time.sleep') as sleep:
            self.assertTrue(self.get('items', library='user')['ok'])
        sleep.assert_called_once_with(3.0)

    def test_retry_after_waits_once_then_reports(self):
        self.fake.routes['/users/4242/items/top'] = (429, 'slow down', {'Retry-After': '2'})
        with mock.patch('integrations.zotero.time.sleep') as sleep:
            res = self.get('items', library='user')
        self.assertFalse(res['ok'])
        self.assertIn('Try again in 2 s', res['error'])
        sleep.assert_called_once_with(2.0)
        self.assertEqual(len([r for r in self.fake.requests if r['path'].endswith('/items/top')]), 2)

    def test_long_retry_after_is_not_waited_for(self):
        self.fake.routes['/users/4242/items/top'] = (429, '', {'Retry-After': '600'})
        with mock.patch('integrations.zotero.time.sleep') as sleep:
            res = self.get('items', library='user')
        sleep.assert_not_called()
        self.assertIn('Try again in 600 s', res['error'])

    def test_revoked_key(self):
        self.fake.routes['/users/4242/items/top'] = (403, 'Forbidden')
        res = self.get('items', library='user')
        self.assertIn('Reconnect Zotero', res['error'])

    def test_garbage_reply(self):
        self.fake.routes['/users/4242/items/top'] = (200, '<html>oops</html>')
        self.assertIn('unexpected reply', self.get('items', library='user')['error'])

    def test_key_never_in_responses(self):
        for path in ('libraries', 'collections?library=user', 'items?library=user'):
            self.assertNotIn(KEY, self.c.get(f'/api/integrations/zotero/{path}').content.decode())
