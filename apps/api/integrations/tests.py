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


from projects import files
from projects.models import Membership, Project, Workspace

from . import bibtex

ENTRY_A = '@article{lovelace_attention_2020,\n\ttitle = {Attention},\n\tauthor = {Lovelace, Ada},\n\tyear = {2020},\n}'
ENTRY_B = '@book{babbage_engines_1864,\n\ttitle = {Engines},\n\tyear = {1864},\n}'


class BibtexUnitTests(ZoteroBase):
    def test_accepts_regular_entry(self):
        entry, kind, key = bibtex.parse_single_entry('  ' + ENTRY_A + '\n')
        self.assertEqual((entry, kind, key), (ENTRY_A, 'article', 'lovelace_attention_2020'))

    def test_refuses_hostile_or_malformed(self):
        bad = ['', 'hello', '@preamble{"\\input{/etc/passwd}"}', '@string{a = "b"}', '@comment{x}',
               '@article{k, title = {unbalanced}', '@article{k, title = {a}}}', ENTRY_A + '\n\\input{x}',
               ENTRY_A + '\n' + ENTRY_B, '@article{k, title = {a\x00b}}', '@article{k, note = {' + 'x' * 30000 + '}}',
               '\\write18{x}\n' + ENTRY_A, '@article {k title = {no comma}}']
        for text in bad:
            with self.assertRaises(bibtex.BibError, msg=text[:40]):
                bibtex.parse_single_entry(text)

    def test_with_key_and_generated_key(self):
        self.assertIn('@article{newkey,', bibtex.with_key(ENTRY_A, 'newkey'))
        data = {'creators': [{'lastName': 'Ünal'}], 'date': '2020-01-02', 'title': 'The Attention Machine'}
        self.assertEqual(bibtex.generate_key(data), 'unal2020attention')

    def test_unique_key(self):
        self.assertEqual(bibtex.unique_key('smith2020', set()), 'smith2020')
        self.assertEqual(bibtex.unique_key('smith2020', {'smith2020'}), 'smith2020a')
        self.assertEqual(bibtex.unique_key('smith2020', {'smith2020', 'smith2020a'}), 'smith2020b')


class AddFixture(ZoteroBase):
    def setUp(self):
        super().setUp()
        self.items = {
            'AAAA1111': (ENTRY_A, {'title': 'Attention', 'date': '2020', 'creators': [{'lastName': 'Lovelace'}]}),
            'BBBB2222': (ENTRY_B, {'title': 'Engines', 'date': '1864', 'creators': [{'lastName': 'Babbage'}]}),
            'CCCC3333': ('@article{lovelace_attention_2020,\n\ttitle = {Other},\n}',
                         {'title': 'Other', 'date': '2020', 'creators': [{'lastName': 'Lovelace'}]}),
            'EVIL0000': ('@preamble{"x"}', {}),
        }
        self.fake.routes['/users/4242/groups'] = (200, [])
        self.fake.routes['/users/4242/items'] = self.items_reply
        self.connect()
        self.pid = self.new_project()
        self.project = Project.objects.get(pk=self.pid)

    def items_reply(self, query):
        fmt = query['include'].split(',')[1]
        wanted = query['itemKey'].split(',')
        return 200, [{'key': k, 'data': self.items[k][1], fmt: self.items[k][0]} for k in wanted if k in self.items]

    def add(self, keys, **extra):
        return self.c.post(f'/api/projects/{self.pid}/zotero/add', {'library': 'user', 'keys': keys, **extra}, format='json').json()

    def bib(self, path='references.bib'):
        return files.read_text(self.project, path)


class AddToProjectTests(AddFixture):
    def test_creates_references_bib(self):
        res = self.add(['AAAA1111', 'BBBB2222'])
        self.assertTrue(res['ok'], res)
        self.assertEqual(res['file'], 'references.bib')
        self.assertEqual([a['citeKey'] for a in res['added']], ['lovelace_attention_2020', 'babbage_engines_1864'])
        self.assertTrue(res['applied'])
        text = self.bib()
        self.assertIn('% zotero: user:AAAA1111\n@article{lovelace_attention_2020,', text)
        self.assertIn(ENTRY_B, text)

    def test_adding_again_changes_nothing(self):
        self.add(['AAAA1111'])
        before = self.bib()
        res = self.add(['AAAA1111'])
        self.assertEqual(res['added'], [])
        self.assertEqual(res['skipped'], [{'zoteroKey': 'AAAA1111', 'citeKey': 'lovelace_attention_2020'}])
        self.assertEqual(self.bib(), before)

    def test_existing_text_is_never_altered_and_new_entries_are_appended(self):
        files.write_text(self.project, 'refs.bib', '% my notes\n@misc{mine,\n  title = {Mine}\n}\n')
        res = self.add(['BBBB2222'])
        self.assertEqual(res['file'], 'refs.bib')  # the project's only .bib
        text = self.bib('refs.bib')
        self.assertTrue(text.startswith('% my notes\n@misc{mine,\n  title = {Mine}\n}\n'))
        self.assertTrue(text.endswith(ENTRY_B + '\n'))

    def test_key_collision_with_a_different_entry_gets_a_generated_key(self):
        files.write_text(self.project, 'references.bib', '@misc{lovelace_attention_2020,\n  title = {Not Zotero}\n}\n')
        res = self.add(['AAAA1111', 'CCCC3333'])
        keys = [a['citeKey'] for a in res['added']]
        self.assertEqual(keys, ['lovelace2020attention', 'lovelace2020other'])
        text = self.bib()
        self.assertIn('title = {Not Zotero}', text)
        self.assertIn('@article{lovelace2020attention,', text)

    def test_duplicate_keys_within_one_batch(self):
        res = self.add(['AAAA1111', 'CCCC3333'])
        self.assertEqual([a['citeKey'] for a in res['added']], ['lovelace_attention_2020', 'lovelace2020other'])

    def test_hostile_entries_are_refused_and_others_still_added(self):
        res = self.add(['EVIL0000', 'BBBB2222', 'MISSING1'])
        self.assertEqual([a['zoteroKey'] for a in res['added']], ['BBBB2222'])
        self.assertEqual(sorted(r['zoteroKey'] for r in res['refused']), ['EVIL0000', 'MISSING1'])
        self.assertNotIn('preamble', self.bib())

    def test_explicit_file_and_bad_file_names(self):
        self.assertEqual(self.add(['AAAA1111'], bibFile='bib/mine.bib')['file'], 'bib/mine.bib')
        for bad in ('../x.bib', '/etc/x.bib', 'notes.txt', 'main.tex'):
            self.assertFalse(self.add(['AAAA1111'], bibFile=bad)['ok'], bad)

    def test_biblatex_projects_get_biblatex_entries(self):
        files.write_text(self.project, 'main.tex', '\\documentclass{article}\n\\usepackage[backend=biber]{biblatex}\n')
        self.add(['AAAA1111'])
        self.assertIn('biblatex', self.fake.requests[-1]['query']['include'])
        self.add(['BBBB2222'])
        files.write_text(self.project, 'main.tex', '\\documentclass{article}\n')
        self.add(['AAAA1111'], bibFile='x.bib')
        self.assertIn('bibtex', self.fake.requests[-1]['query']['include'])
        self.assertNotIn('biblatex', self.fake.requests[-1]['query']['include'])

    def test_permissions(self):
        viewer = make_user('viewer@example.com')
        Membership.objects.create(workspace=self.project.workspace, user=viewer, role=Membership.VIEWER)
        vc = client_for(viewer)
        self.connect(vc)
        res = vc.post(f'/api/projects/{self.pid}/zotero/add', {'library': 'user', 'keys': ['AAAA1111']}, format='json')
        self.assertEqual(res.status_code, 403)
        stranger = client_for(make_user('stranger@example.com'))
        res = stranger.post(f'/api/projects/{self.pid}/zotero/add', {'library': 'user', 'keys': ['AAAA1111']}, format='json')
        self.assertEqual(res.status_code, 404)

    def test_requires_connection_and_keys_and_allowed_library(self):
        self.assertFalse(self.add([])['ok'])
        self.assertFalse(self.add(['AAAA1111'], library='99')['ok'])
        self.c.delete('/api/integrations/zotero')
        self.assertEqual(self.add(['AAAA1111'])['error'], 'Zotero is not connected.')

    def test_live_room_leaves_the_write_to_the_editor(self):
        with mock.patch('integrations.views.live_room', return_value=True), \
                mock.patch('integrations.views.flush_room', return_value=True) as flush:
            res = self.add(['AAAA1111'])
        flush.assert_called_once()
        self.assertFalse(res['applied'])
        self.assertIn('@article{lovelace_attention_2020,', res['text'])
        self.assertFalse(self.project.files.filter(path='references.bib').exists())

    def test_flush_timeout_is_reported(self):
        with mock.patch('integrations.views.flush_room', return_value=False):
            self.assertIn('Timed out', self.add(['AAAA1111'])['error'])

    def test_bibtex_preview_endpoint(self):
        res = self.c.get('/api/integrations/zotero/bibtex', {'library': 'user', 'keys': 'AAAA1111,EVIL0000'}).json()
        self.assertEqual(res['entries'], [{'zoteroKey': 'AAAA1111', 'citeKey': 'lovelace_attention_2020', 'bibtex': ENTRY_A}])
        self.assertEqual(res['refused'][0]['zoteroKey'], 'EVIL0000')


import shutil
from unittest import skipUnless

from jobs import compile as tex


@skipUnless(shutil.which('pdflatex') and shutil.which('bibtex'),
            'needs TeX Live: docker compose run --rm worker-tex python manage.py test integrations')
class CompileWithZoteroEntriesTests(AddFixture):
    """A reference added from Zotero (marker comment and all) is resolved by the real bibtex pass."""

    def test_cited_entry_resolves(self):
        self.items['AAAA1111'] = (
            '@article{lovelace_notes_1843,\n\ttitle = {Notes by the Translator},\n\tauthor = {Lovelace, Ada},\n'
            '\tdate = {1843},\n\tjournal = {Scientific Memoirs},\n\tfile = {x.pdf:/tmp/x.pdf:application/pdf},\n}',
            {'title': 'Notes', 'date': '1843', 'creators': [{'lastName': 'Lovelace'}]})
        res = self.add(['AAAA1111'])
        self.assertEqual(res['added'][0]['citeKey'], 'lovelace_notes_1843')
        files.write_text(self.project, 'main.tex', '\\documentclass{article}\\begin{document}See \\cite{lovelace_notes_1843}.'
                         '\\bibliographystyle{plain}\\bibliography{references}\\end{document}')
        out = tex.compile_project(self.project, 'main.tex', 'pdflatex')
        self.assertTrue(out['pdf'], out['log'][-800:])
        self.assertNotIn("Citation `lovelace_notes_1843' undefined", out['log'].split('This is pdfTeX')[-1])


from .models import WorkspaceLlmConfig
from . import llmconfig

LLM_KEY = 'sk-workspace-SECRET-9876'


class WorkspaceLlmTests(ApiBase):
    def setUp(self):
        super().setUp()
        self.ws = self.c.post('/api/workspaces', {'name': 'Lab'}, format='json').data['workspace']['id']
        self.url = f'/api/workspaces/{self.ws}/llm'
        pub = mock.patch('integrations.llmconfig.assert_public_url')  # no DNS in tests; the guard has its own tests
        pub.start()
        self.addCleanup(pub.stop)

    def member(self, email, role):
        user = make_user(email)
        Membership.objects.create(workspace_id=self.ws, user=user, role=role)
        return user, client_for(user)

    def put(self, client=None, **body):
        return (client or self.c).put(self.url, body, format='json')

    def test_admin_sets_changes_rotates_and_removes(self):
        self.assertEqual(self.c.get(self.url).json(), {'ok': True, 'configured': False, 'canManage': True, 'canUse': False})
        res = self.put(endpoint='https://llm.example.com/v1', model='gpt-x', apiKey=LLM_KEY).json()
        self.assertTrue(res['configured'])
        self.assertEqual((res['endpoint'], res['model'], res['lastFour']), ('https://llm.example.com/v1/chat/completions', 'gpt-x', '9876'))
        self.assertEqual(res['updatedBy'], 'owner@example.com')
        # change the model only: the key is kept
        self.assertEqual(self.put(model='gpt-y').json()['model'], 'gpt-y')
        self.assertEqual(llmconfig.workspace_llm_for(Workspace.objects.get(pk=self.ws), self.user)[1], {'apiKey': LLM_KEY})
        # rotate
        self.assertEqual(self.put(apiKey='sk-new-key-0001').json()['lastFour'], '0001')
        self.assertEqual(llmconfig.workspace_llm_for(Workspace.objects.get(pk=self.ws), self.user)[1], {'apiKey': 'sk-new-key-0001'})
        # remove
        self.assertFalse(self.c.delete(self.url).json()['configured'])
        self.assertFalse(WorkspaceLlmConfig.objects.exists())

    def test_first_save_needs_a_key_and_long_keys_are_refused(self):
        self.assertEqual(self.put(model='m').json(), {'ok': False, 'error': 'Enter an API key.'})
        self.assertFalse(self.put(apiKey='x' * 501).json()['ok'])
        self.assertFalse(WorkspaceLlmConfig.objects.exists())

    def test_private_endpoints_are_refused(self):
        mock.patch.stopall()
        with override_settings(LLM_ALLOW_PRIVATE_ENDPOINTS=False):
            for bad in ('http://127.0.0.1:8000/v1', 'http://169.254.169.254/', 'http://localhost/v1', 'file:///etc/passwd'):
                res = self.put(endpoint=bad, apiKey=LLM_KEY).json()
                self.assertFalse(res['ok'], bad)
        self.assertFalse(WorkspaceLlmConfig.objects.exists())

    def test_roles(self):
        self.put(model='m', apiKey=LLM_KEY)
        admin_c = self.member('admin@example.com', Membership.ADMIN)[1]
        self.assertEqual(self.put(admin_c, model='by-admin').json()['model'], 'by-admin')
        for role in (Membership.EDITOR, Membership.COMMENTER, Membership.VIEWER):
            _, c = self.member(f'{role}@example.com', role)
            seen = c.get(self.url).json()
            self.assertTrue(seen['configured'], role)
            self.assertFalse(seen['canManage'])
            self.assertEqual(seen['canUse'], role == Membership.EDITOR)
            self.assertNotIn('lastFour', seen)
            self.assertEqual(self.put(c, model='x', apiKey='k').status_code, 403, role)
            self.assertEqual(c.delete(self.url).status_code, 403, role)
        self.assertEqual(WorkspaceLlmConfig.objects.get().model, 'by-admin')

    def test_outsiders_and_anonymous(self):
        self.put(model='m', apiKey=LLM_KEY)
        stranger = client_for(make_user('stranger@example.com'))
        self.assertEqual(stranger.get(self.url).status_code, 404)
        self.assertEqual(stranger.put(self.url, {'apiKey': 'k'}, format='json').status_code, 404)
        from rest_framework.test import APIClient
        self.assertEqual(APIClient().get(self.url).status_code, 401)

    def test_key_is_encrypted_and_never_leaks(self):
        res = self.put(model='m', apiKey=LLM_KEY)
        self.assertNotIn(LLM_KEY, res.content.decode())
        self.assertNotIn(LLM_KEY, self.c.get(self.url).content.decode())
        with connection.cursor() as cur:
            cur.execute('SELECT api_key_encrypted FROM integrations_workspacellmconfig')
            raw = bytes(cur.fetchone()[0])
        self.assertNotIn(LLM_KEY.encode(), raw)
        self.assertEqual(crypto.decrypt(raw), LLM_KEY)
        with self.assertLogs(level=logging.DEBUG) as logs:
            logging.getLogger('probe').debug('start')
            self.put(apiKey='sk-other-5555')
            self.put(endpoint='http://127.0.0.1/', apiKey='sk-bad-6666')
        self.assertNotIn('sk-other', '\n'.join(logs.output))

    def test_helper_only_serves_users_who_can_write(self):
        self.put(endpoint='https://llm.example.com/v1/chat/completions', model='m', apiKey=LLM_KEY)
        ws = Workspace.objects.get(pk=self.ws)
        public, secrets = llmconfig.workspace_llm_for(ws, self.user)
        self.assertEqual(public, {'endpoint': 'https://llm.example.com/v1/chat/completions', 'model': 'm'})
        editor, _ = self.member('ed@example.com', Membership.EDITOR)
        self.assertIsNotNone(llmconfig.workspace_llm_for(ws, editor))
        for role in (Membership.COMMENTER, Membership.VIEWER):
            u, _ = self.member(f'{role}2@example.com', role)
            self.assertIsNone(llmconfig.workspace_llm_for(ws, u), role)
        self.assertIsNone(llmconfig.workspace_llm_for(ws, make_user('out@example.com')))
        self.assertIsNone(llmconfig.workspace_llm_for(None, self.user))

    def test_deleting_the_workspace_deletes_the_config(self):
        self.put(model='m', apiKey=LLM_KEY)
        Workspace.objects.filter(pk=self.ws).delete()
        self.assertFalse(WorkspaceLlmConfig.objects.exists())
