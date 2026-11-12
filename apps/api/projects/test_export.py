"""Export a project as one zip (#162)."""
import io
import zipfile
from unittest import mock

from django.test import override_settings
from rest_framework.test import APIClient

from collab import tokens
from common import urltokens
from projects import export as pexport
from projects import files as pfiles
from projects.models import Membership, Project
from projects.test_api import ApiBase, client_for, make_user

BIN = bytes(range(256)) * 40 + b'\x00\x01\x02'


class ExportBase(ApiBase):
    def setUp(self):
        super().setUp()
        self.pid = self.new_project('Attention: "All" you/need ünï')
        self.project = Project.objects.get(pk=self.pid)
        pfiles.write_text(self.project, 'paper.tex', '\\documentclass{article}\n% ünï ✓\n')
        pfiles.write_text(self.project, 'sections/intro.tex', 'Intro')
        pfiles.write_text(self.project, 'refs.bib', '@misc{a,title={t}}')
        pfiles.write_binary(self.project, 'figs/plot.png', BIN, 'image/png')
        pfiles.write_binary(self.project, 'data/blob.bin', BIN[::-1], 'application/octet-stream')
        pfiles.mkdir(self.project, 'figs/empty')

    def url(self, qs=''):
        return f'/api/projects/{self.pid}/export{qs}'

    def body(self, res):
        """The streamed body (the response is an async stream; iterating the response consumes it)."""
        return b''.join(res)

    def zip_of(self, res):
        self.assertEqual(res.status_code, 200, getattr(res, 'content', b''))
        return zipfile.ZipFile(io.BytesIO(self.body(res)))


class ContentTests(ExportBase):
    def test_the_zip_holds_every_file_at_its_path_with_identical_contents_and_empty_folders(self):
        res = self.c.get(self.url())
        zf = zipfile.ZipFile(io.BytesIO(data := self.body(res)))
        self.assertEqual(int(res['Content-Length']), len(data))
        names = set(zf.namelist())
        self.assertEqual(names, {'paper.tex', 'sections/intro.tex', 'refs.bib', 'figs/plot.png', 'data/blob.bin', 'figs/empty/'})
        self.assertEqual(zf.read('paper.tex').decode(), '\\documentclass{article}\n% ünï ✓\n')
        self.assertEqual(zf.read('figs/plot.png'), BIN)                       # binary, byte for byte
        self.assertEqual(zf.read('data/blob.bin'), BIN[::-1])
        self.assertIsNone(zf.testzip())
        self.assertEqual(res['Content-Type'], 'application/zip')
        self.assertEqual(res['Cache-Control'], 'no-store')

    def test_importing_the_export_reproduces_the_files(self):
        data = self.body(self.c.get(self.url()))
        up = io.BytesIO(data)
        up.name = 'export.zip'
        res = self.c.post('/api/projects/import-zip', {'zip': up, 'projectName': 'Again'}, format='multipart').json()
        again = Project.objects.get(pk=res['project']['id'])
        for path in ('paper.tex', 'sections/intro.tex', 'refs.bib', 'figs/plot.png', 'data/blob.bin'):
            self.assertEqual(pfiles.read_bytes(again, path), pfiles.read_bytes(self.project, path), path)

    def test_other_projects_and_unrelated_data_are_not_in_it(self):
        other = Project.objects.get(pk=self.new_project('Other'))
        pfiles.write_text(other, 'secret.tex', 'NOT-MINE')
        self.assertNotIn('secret.tex', self.zip_of(self.c.get(self.url())).namelist())

    def test_the_file_name_is_the_project_name_made_safe(self):
        res = self.c.get(self.url())
        disp = res['Content-Disposition']
        self.assertTrue(disp.startswith('attachment;'), disp)
        self.assertIn('.zip', disp)
        self.assertNotIn('/', disp.split('filename=')[-1] if 'filename=' in disp else '')
        for name, expected in (('plain', 'plain.zip'), ('a/b\\c:d', 'a b c d.zip'), ('   ', 'project.zip'), ('..hidden..', 'hidden.zip'),
                               ('x' * 300, 'x' * 120 + '.zip')):
            self.assertEqual(pexport.archive_name(type('P', (), {'name': name})()), expected)

    def test_a_large_text_file_and_many_files_round_trip(self):
        pfiles.write_text(self.project, 'big.tex', 'line of text\n' * 200000)
        for i in range(60):
            pfiles.write_text(self.project, f'many/f{i}.tex', f'file {i}')
        zf = self.zip_of(self.c.get(self.url()))
        self.assertEqual(len(zf.read('big.tex')), len('line of text\n') * 200000)
        self.assertEqual(zf.read('many/f59.tex'), b'file 59')


class AccessTests(ExportBase):
    def test_viewers_may_export_but_strangers_and_anonymous_may_not(self):
        viewer = make_user('viewer@example.com')
        Membership.objects.create(workspace=self.project.workspace, user=viewer, role='viewer')
        self.assertIn('paper.tex', self.zip_of(client_for(viewer).get(self.url())).namelist())
        self.assertEqual(client_for(make_user('out@example.com')).get(self.url()).status_code, 404)
        self.assertEqual(APIClient().get(self.url()).status_code, 401)

    def test_a_project_url_token_downloads_without_a_header_and_only_that_project(self):
        token, _ = urltokens.mint(self.user, urltokens.PROJECT, self.project.id)
        anon = APIClient()
        self.assertIn('paper.tex', self.zip_of(anon.get(self.url(f'?token={token}'))).namelist())
        other = Project.objects.get(pk=self.new_project('Other'))
        self.assertEqual(anon.get(f'/api/projects/{other.id}/export?token={token}').status_code, 404)
        self.assertEqual(anon.get(self.url('?token=not-a-token')).status_code, 401)
        from rest_framework_simplejwt.tokens import RefreshToken
        access = str(RefreshToken.for_user(self.user).access_token)
        self.assertEqual(anon.get(self.url(f'?token={access}')).status_code, 401)     # a real access token in a URL is refused

    def test_an_invite_link_guest_who_can_read_may_export(self):
        token, _ = tokens.create_invite(self.project, self.user, 'viewer')
        guest = APIClient()
        guest.credentials(HTTP_AUTHORIZATION=f'Bearer {token}')
        self.assertIn('paper.tex', self.zip_of(guest.get(self.url())).namelist())


class LimitTests(ExportBase):
    def test_check_reports_files_and_bytes_without_building_a_zip(self):
        with mock.patch('projects.views.pexport.build') as build:
            body = self.c.get(self.url('?check=1')).json()
        build.assert_not_called()
        self.assertEqual((body['ok'], body['files']), (True, 5))
        self.assertGreater(body['bytes'], len(BIN) * 2)
        self.assertTrue(body['name'].endswith('.zip'))

    @override_settings(EXPORT_MAX_BYTES=100)
    def test_a_project_over_the_limit_is_refused_with_a_message_and_builds_nothing(self):
        check = self.c.get(self.url('?check=1')).json()
        self.assertFalse(check['ok'])
        self.assertIn('too large', check['error'])
        with mock.patch('projects.export.tempfile.TemporaryFile') as tmp, mock.patch('projects.export.storage.get_bytes') as get:
            res = self.c.get(self.url())
        self.assertEqual(res.status_code, 413)
        self.assertIn('too large', res.json()['error'])
        tmp.assert_not_called()
        get.assert_not_called()

    @override_settings(EXPORT_RATE_PER_MINUTE=1)
    def test_downloads_are_rate_limited_per_user_but_checks_are_not(self):
        for _ in range(3):
            self.assertEqual(self.c.get(self.url('?check=1')).status_code, 200)
        self.assertEqual(self.c.get(self.url()).status_code, 200)
        res = self.c.get(self.url())
        self.assertEqual(res.status_code, 429)
        self.assertIn('Retry-After', res)

    def test_a_failed_build_leaves_no_temporary_file_open(self):
        closed = []
        real = pexport.tempfile.TemporaryFile

        def tracking():
            f = real()
            orig = f.close
            f.close = lambda: (closed.append(True), orig())[1]
            return f

        with mock.patch('projects.export.tempfile.TemporaryFile', side_effect=tracking), \
                mock.patch('projects.export.storage.get_bytes', side_effect=RuntimeError('storage down')):
            with self.assertRaises(RuntimeError):
                pexport.build(self.project, 10 ** 9)
        self.assertEqual(closed, [True])


class LiveTextTests(ExportBase):
    def test_text_held_in_a_live_room_is_flushed_before_the_zip_is_built(self):
        order = []
        with mock.patch('collab.views.live_room', side_effect=lambda p, path: path == 'paper.tex') as live, \
                mock.patch('collab.views.flush_room', side_effect=lambda p, path: order.append(path)) as flush:
            self.zip_of(self.c.get(self.url()))
        self.assertEqual(order, ['paper.tex'])                       # only the file with a live room, and only text
        self.assertEqual({c.args[1] for c in live.call_args_list}, {'paper.tex', 'sections/intro.tex', 'refs.bib'})
        flush.assert_called_once()
