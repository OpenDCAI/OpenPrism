"""Contract tests for the endpoints used by apps/frontend/src/api/client.ts."""
import base64
import io
import os
import shutil
import zipfile

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from unittest import skipUnless
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from accounts.serializers import RegisterSerializer
from templates_app import service as templates
from templates_app.models import Template

from . import files
from .models import Membership, Project

User = get_user_model()


def make_user(email):
    s = RegisterSerializer(data={'email': email, 'password': 'correct-horse-battery'})
    s.is_valid(raise_exception=True)
    return s.save()


def client_for(user):
    c = APIClient()
    c.credentials(HTTP_AUTHORIZATION=f'Bearer {RefreshToken.for_user(user).access_token}')
    return c


def make_zip(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    buf.seek(0)
    return buf


def multipart(parts):
    """parts: [(filename, bytes)] as field `files`. Django's test client strips directories from
    filenames, but browsers send them (`form.append('files', file, 'figs/a.png')`), so build the body by hand."""
    boundary = 'xBOUNDARYx'
    body = b''
    for filename, data in parts:
        body += (f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{filename}"\r\n'
                 f'Content-Type: application/octet-stream\r\n\r\n').encode() + data + b'\r\n'
    body += f'--{boundary}--\r\n'.encode()
    return body, f'multipart/form-data; boundary={boundary}'


class ApiBase(TestCase):
    def setUp(self):
        self.user = make_user('owner@example.com')
        self.c = client_for(self.user)
        self.created = []
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        for p in Project.objects.all():
            files.delete_project_files(p)
        for t in Template.objects.all():
            templates.clear(t)

    def new_project(self, name='Paper', **extra):
        res = self.c.post('/api/projects', {'name': name, **extra}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        return res.data['id']


class ProjectTests(ApiBase):
    def test_requires_auth(self):
        self.assertEqual(APIClient().get('/api/projects').status_code, 401)

    def test_create_list_meta_shape(self):
        pid = self.new_project()
        meta = self.c.get('/api/projects').data['projects'][0]
        self.assertEqual(meta['id'], pid)
        for key in ('name', 'createdAt', 'updatedAt', 'tags', 'archived', 'trashed', 'trashedAt', 'fileOrder'):
            self.assertIn(key, meta)
        self.assertTrue(meta['createdAt'].endswith('Z'))

    def test_rename_tags_archive_trash_flow(self):
        pid = self.new_project()
        self.assertEqual(self.c.post(f'/api/projects/{pid}/rename-project', {'name': 'New'}, format='json').data['project']['name'], 'New')
        self.assertFalse(self.c.post(f'/api/projects/{pid}/rename-project', {}, format='json').data['ok'])
        self.assertEqual(self.c.patch(f'/api/projects/{pid}/tags', {'tags': ['a', 'b']}, format='json').data['project']['tags'], ['a', 'b'])
        self.assertFalse(self.c.patch(f'/api/projects/{pid}/tags', {'tags': 'x'}, format='json').data['ok'])
        self.assertTrue(self.c.patch(f'/api/projects/{pid}/archive', {'archived': True}, format='json').data['project']['archived'])
        trashed = self.c.patch(f'/api/projects/{pid}/trash', {'trashed': True}, format='json').data['project']
        self.assertTrue(trashed['trashed'] and trashed['trashedAt'])
        restored = self.c.patch(f'/api/projects/{pid}/trash', {'trashed': False}, format='json').data['project']
        self.assertIsNone(restored['trashedAt'])
        self.assertTrue(self.c.delete(f'/api/projects/{pid}').data['ok'])  # soft delete
        self.assertTrue(self.c.get('/api/projects').data['projects'][0]['trashed'])

    def test_permanent_delete_removes_files(self):
        pid = self.new_project()
        self.c.post(f'/api/projects/{pid}/upload', {'files': SimpleUploadedFile('a.png', b'x')}, format='multipart')
        self.assertTrue(self.c.delete(f'/api/projects/{pid}/permanent').data['ok'])
        self.assertEqual(self.c.get('/api/projects').data['projects'], [])
        self.assertEqual(self.c.get(f'/api/projects/{pid}/tree').status_code, 404)

    def test_copy_is_independent(self):
        pid = self.new_project('Orig')
        self.c.put(f'/api/projects/{pid}/file', {'path': 'main.tex', 'content': 'hello'}, format='json')
        self.c.post(f'/api/projects/{pid}/upload', {'files': SimpleUploadedFile('i.png', b'img')}, format='multipart')
        copy = self.c.post(f'/api/projects/{pid}/copy', {}, format='json').data['project']
        self.assertEqual(copy['name'], 'Orig (Copy)')
        self.assertNotEqual(copy['id'], pid)
        self.c.delete(f'/api/projects/{pid}/file?path=i.png')
        self.assertEqual(self.c.get(f"/api/projects/{copy['id']}/file", {'path': 'main.tex'}).data['content'], 'hello')
        self.assertEqual(self.c.get(f"/api/projects/{copy['id']}/blob", {'path': 'i.png'}).content, b'img')

    def test_import_zip_skips_unsafe_and_project_json(self):
        z = make_zip({'main.tex': 'x', 'figs/a.png': b'png', '../evil.tex': 'bad', 'project.json': '{}'})
        res = self.c.post('/api/projects/import-zip', {'zip': SimpleUploadedFile('p.zip', z.read()), 'projectName': 'Imp'}, format='multipart')
        self.assertTrue(res.data['ok'], res.data)
        pid = res.data['project']['id']
        paths = [i['path'] for i in self.c.get(f'/api/projects/{pid}/tree').data['items']]
        self.assertEqual(paths, ['evil.tex', 'figs', 'figs/a.png', 'main.tex'])  # '..' segment stripped, not escaped

    def test_import_zip_bad_zip(self):
        res = self.c.post('/api/projects/import-zip', {'zip': SimpleUploadedFile('p.zip', b'nope')}, format='multipart')
        self.assertFalse(res.data['ok'])
        self.assertEqual(Project.objects.count(), 0)


class FileTests(ApiBase):
    def setUp(self):
        super().setUp()
        self.pid = self.new_project()
        self.base = f'/api/projects/{self.pid}'

    def test_put_get_delete_file(self):
        self.assertTrue(self.c.put(f'{self.base}/file', {'path': 'sec/a.tex', 'content': 'héllo'}, format='json').data['ok'])
        self.assertEqual(self.c.get(f'{self.base}/file', {'path': 'sec/a.tex'}).data['content'], 'héllo')
        self.assertEqual(self.c.get(f'{self.base}/file').data, {'content': ''})
        self.assertEqual(self.c.get(f'{self.base}/file', {'path': 'nope.tex'}).status_code, 404)
        self.assertTrue(self.c.delete(f'{self.base}/file?path=sec').data['ok'])  # directory
        self.assertEqual(self.c.delete(f'{self.base}/file?path=sec').data, {'ok': False, 'error': 'File not found'})

    def test_path_traversal_rejected(self):
        for bad in ('../x.tex', '/abs.tex'):
            self.assertEqual(self.c.put(f'{self.base}/file', {'path': bad, 'content': ''}, format='json').status_code, 400, bad)
            self.assertEqual(self.c.get(f'{self.base}/file', {'path': bad}).status_code, 400, bad)

    def test_tree_and_file_order(self):
        self.c.put(f'{self.base}/file', {'path': 'a/b.tex', 'content': ''}, format='json')
        self.c.post(f'{self.base}/folder', {'path': 'empty'}, format='json')
        self.assertTrue(self.c.post(f'{self.base}/file-order', {'folder': 'a', 'order': ['b.tex']}, format='json').data['ok'])
        tree = self.c.get(f'{self.base}/tree').data
        self.assertEqual(tree['items'], [{'path': 'a', 'type': 'dir'}, {'path': 'a/b.tex', 'type': 'file'}, {'path': 'empty', 'type': 'dir'}])
        self.assertEqual(tree['fileOrder'], {'a': ['b.tex']})

    def test_upload_preserves_relative_paths(self):
        body, ctype = multipart([('figs/sub/a.png', b'\x89PNG'), ('main.tex', b'doc'), ('../../escape.tex', b'x')])
        res = self.c.generic('POST', f'{self.base}/upload', body, content_type=ctype)
        self.assertEqual(sorted(res.data['files']), ['escape.tex', 'figs/sub/a.png', 'main.tex'])
        self.assertEqual(self.c.get(f'{self.base}/file', {'path': 'main.tex'}).data['content'], 'doc')

    def test_blob_content_type_and_query_token(self):
        files.write_binary(Project.objects.get(pk=self.pid), 'a.svg', b'<svg onload="alert(1)"/>')
        r = self.c.get(f'{self.base}/blob', {'path': 'a.svg'})
        self.assertEqual(r['Content-Type'], 'image/svg+xml')
        self.assertEqual(r['Content-Security-Policy'], 'sandbox')
        token = str(RefreshToken.for_user(self.user).access_token)
        anon = APIClient()
        self.assertEqual(anon.get(f'{self.base}/blob', {'path': 'a.svg'}).status_code, 401)
        self.assertEqual(anon.get(f'{self.base}/blob', {'path': 'a.svg', 'token': token}).status_code, 200)
        self.assertEqual(anon.get(f'{self.base}/tree', {'token': token}).status_code, 401)  # query token only on blob

    def test_files_endpoint_encodings(self):
        self.c.put(f'{self.base}/file', {'path': 'main.tex', 'content': 'x'}, format='json')
        self.c.post(f'{self.base}/upload', {'files': SimpleUploadedFile('a.png', b'\x00\x01')}, format='multipart')
        got = {f['path']: f for f in self.c.get(f'{self.base}/files').data['files']}
        self.assertEqual(got['main.tex'], {'path': 'main.tex', 'content': 'x', 'encoding': 'utf8'})
        self.assertEqual(base64.b64decode(got['a.png']['content']), b'\x00\x01')
        self.assertEqual(got['a.png']['encoding'], 'base64')

    def test_rename_and_conflicts(self):
        self.c.put(f'{self.base}/file', {'path': 'a/x.tex', 'content': '1'}, format='json')
        self.c.put(f'{self.base}/file', {'path': 'b.tex', 'content': '2'}, format='json')
        self.assertTrue(self.c.post(f'{self.base}/rename', {'from': 'a', 'to': 'z'}, format='json').data['ok'])
        self.assertEqual(self.c.get(f'{self.base}/file', {'path': 'z/x.tex'}).data['content'], '1')
        self.assertEqual(self.c.post(f'{self.base}/rename', {'from': 'b.tex', 'to': 'z/x.tex'}, format='json').status_code, 409)
        # cannot create a file below a file, or a file where a directory is
        self.assertEqual(self.c.put(f'{self.base}/file', {'path': 'b.tex/c.tex', 'content': ''}, format='json').status_code, 409)
        self.assertEqual(self.c.put(f'{self.base}/file', {'path': 'z', 'content': ''}, format='json').status_code, 409)


class AccessTests(ApiBase):
    def test_other_user_gets_404_not_403(self):
        pid = self.new_project()
        other = client_for(make_user('other@example.com'))
        self.assertEqual(other.get(f'/api/projects/{pid}/tree').status_code, 404)
        self.assertEqual(other.get('/api/projects').data['projects'], [])
        self.assertEqual(self.c.get('/api/projects/not-a-uuid/tree').status_code, 404)

    def test_viewer_can_read_not_write(self):
        pid = self.new_project()
        viewer = make_user('viewer@example.com')
        Membership.objects.create(workspace=Project.objects.get(pk=pid).workspace, user=viewer, role=Membership.VIEWER)
        v = client_for(viewer)
        self.assertEqual(v.get(f'/api/projects/{pid}/tree').status_code, 200)
        self.assertEqual(v.put(f'/api/projects/{pid}/file', {'path': 'a.tex', 'content': ''}, format='json').status_code, 403)
        self.assertEqual(v.delete(f'/api/projects/{pid}/permanent').status_code, 403)


class TemplateTests(ApiBase):
    def upload(self, tid='mine', entries=None, **kw):
        z = make_zip(entries or {'main.tex': '\\begin{document}\nTPL\n\\end{document}', 'sty/x.sty': 's', 'logo.png': b'png'})
        return self.c.post('/api/templates/upload', {'templateId': tid, 'templateLabel': 'Mine',
                           'file': SimpleUploadedFile('t.zip', z.read()), **kw}, format='multipart')

    def test_upload_list_and_create_project_from_template(self):
        self.assertTrue(self.upload().data['ok'])
        listing = self.c.get('/api/templates').data
        self.assertEqual([t['id'] for t in listing['templates']], ['mine'])
        self.assertEqual(listing['templates'][0]['mainFile'], 'main.tex')
        self.assertTrue(any(c['id'] == 'academic' for c in listing['categories']))
        pid = self.new_project(template='mine')
        paths = [i['path'] for i in self.c.get(f'/api/projects/{pid}/tree').data['items'] if i['type'] == 'file']
        self.assertEqual(paths, ['logo.png', 'main.tex', 'sty/x.sty'])

    def test_upload_picks_the_root_document_as_main_file(self):
        doc = b'\\documentclass{article}\n\\begin{document}x\\end{document}'
        self.upload(tid='paper', entries={'paper.tex': doc, 'macros.tex': b'\\newcommand{\\x}{y}', 'sec/a.tex': doc})
        self.assertEqual(Template.objects.get(pk='paper').main_file, 'paper.tex')
        self.upload(tid='both', entries={'main.tex': doc, 'a.tex': doc})
        self.assertEqual(Template.objects.get(pk='both').main_file, 'main.tex')
        self.upload(tid='none', entries={'macros.tex': b'\\newcommand{\\x}{y}'})
        self.assertEqual(Template.objects.get(pk='none').main_file, 'main.tex')  # nothing to detect: the old default

    def test_reupload_keeps_a_main_file_that_still_exists(self):
        doc = b'\\documentclass{article}\n\\begin{document}x\\end{document}'
        self.upload(tid='t', entries={'a.tex': doc, 'b.tex': doc})
        Template.objects.filter(pk='t').update(main_file='b.tex')
        self.upload(tid='t', entries={'a.tex': doc, 'b.tex': doc})
        self.assertEqual(Template.objects.get(pk='t').main_file, 'b.tex')

    def test_detect_main_file(self):
        texts = {'x.tex': 'plain', 'y.tex': '\\documentclass{a}', 'z.tex': '\\documentclass{b}', 'sub/w.tex': '\\documentclass{c}'}
        self.assertEqual(templates.detect_main_file(list(texts), texts.get), 'y.tex')
        self.assertEqual(templates.detect_main_file(['main.tex', 'y.tex'], texts.get), 'main.tex')
        self.assertIsNone(templates.detect_main_file(['x.tex', 'sub/w.tex', 'a.sty'], texts.get))

    def test_upload_validation(self):
        self.assertEqual(self.upload(tid='../evil').status_code, 400)
        self.assertEqual(self.c.post('/api/templates/upload', {'templateId': 'x'}, format='multipart').status_code, 400)
        self.assertEqual(self.c.post('/api/projects', {'template': 'missing'}, format='json').status_code, 404)

    def test_builtin_template_protected(self):
        self.upload()
        Template.objects.filter(pk='mine').update(builtin=True)
        self.assertEqual(self.upload().status_code, 403)

    def test_convert_template_keeps_body(self):
        self.upload()
        pid = self.new_project()
        self.c.put(f'/api/projects/{pid}/file', {'path': 'main.tex', 'content': '\\documentclass{x}\n\\begin{document}\nMY BODY\n\\end{document}'}, format='json')
        res = self.c.post(f'/api/projects/{pid}/convert-template', {'targetTemplate': 'mine'}, format='json')
        self.assertTrue(res.data['ok'], res.data)
        self.assertIn('logo.png', res.data['changedFiles'])
        self.assertNotIn('main.tex', res.data['changedFiles'][:-1])
        merged = self.c.get(f'/api/projects/{pid}/file', {'path': 'main.tex'}).data['content']
        self.assertIn('MY BODY', merged)
        self.assertFalse(self.c.post(f'/api/projects/{pid}/convert-template', {'targetTemplate': 'nope'}, format='json').data['ok'])


class BuiltinTemplateTests(ApiBase):
    """Every template shipped in templates/ must have a main file the editor and transfer can compile."""
    TEMPLATES_DIR = '/legacy/templates'

    def _cleanup(self):
        # These tests import the *real* templates into the bucket the running app also uses, so the shared cleanup
        # (which deletes every Template's files) would wipe the dev data. Import is idempotent: leave them in place.
        for p in Project.objects.all():
            files.delete_project_files(p)

    def test_cleanup_leaves_the_real_templates_in_storage(self):
        import os
        from django.core.management import call_command
        if not os.path.isdir(self.TEMPLATES_DIR):
            self.skipTest('templates/ is not mounted at /legacy/templates')
        call_command('import_legacy', '--skip-projects', templates_dir=self.TEMPLATES_DIR, stdout=io.StringIO())
        self._cleanup()
        for tpl in Template.objects.all():
            self.assertTrue(list(templates.list_paths(tpl)), f'{tpl.id}: files were deleted from storage')

    def test_every_builtin_template_has_an_existing_main_file(self):
        import os
        from django.core.management import call_command
        if not os.path.isdir(self.TEMPLATES_DIR):
            self.skipTest('templates/ is not mounted at /legacy/templates')
        call_command('import_legacy', '--skip-projects', templates_dir=self.TEMPLATES_DIR, stdout=io.StringIO())
        listing = {t['id']: t for t in self.c.get('/api/templates').data['templates']}
        self.assertEqual({'acl', 'arxiv', 'cvpr', 'icml', 'neurips'}, set(listing))
        for tid, meta in listing.items():
            tpl = Template.objects.get(pk=tid)
            self.assertIn(meta['mainFile'], list(templates.list_paths(tpl)), f'{tid}: main file missing')
        self.assertEqual(listing['acl']['mainFile'], 'acl_latex.tex')
        self.assertEqual(listing['arxiv']['mainFile'], 'template.tex')

    @skipUnless(shutil.which('pdflatex'), 'needs TeX Live: docker compose run --rm worker-tex python manage.py test projects --noinput')
    def test_acl_and_arxiv_compile_to_a_pdf(self):
        import os
        from django.core.management import call_command
        from jobs.compile import compile_project
        if not os.path.isdir(self.TEMPLATES_DIR):
            self.skipTest('templates/ is not mounted at /legacy/templates')
        call_command('import_legacy', '--skip-projects', templates_dir=self.TEMPLATES_DIR, stdout=io.StringIO())
        for tid in ('acl', 'arxiv'):
            pid = self.new_project(tid, template=tid)
            out = compile_project(Project.objects.get(pk=pid), Template.objects.get(pk=tid).main_file, 'pdflatex')
            self.assertTrue(out['pdf'], f'{tid} produced no PDF:\n{out["log"][-1500:]}')

    @skipUnless(os.access(os.path.join(settings.TECTONIC_HOME, 'bin', 'tectonic'), os.X_OK),
                'needs tectonic: docker compose run --rm worker-tex python manage.py test projects --noinput')
    def test_every_builtin_template_compiles_with_tectonic(self):
        from django.core.management import call_command
        from jobs.compile import compile_project
        if not os.path.isdir(self.TEMPLATES_DIR):
            self.skipTest('templates/ is not mounted at /legacy/templates')
        call_command('import_legacy', '--skip-projects', templates_dir=self.TEMPLATES_DIR, stdout=io.StringIO())
        for tpl in Template.objects.filter(pk__in=['acl', 'arxiv', 'cvpr', 'icml', 'neurips']):
            pid = self.new_project(f'{tpl.id} tectonic', template=tpl.id)
            out = compile_project(Project.objects.get(pk=pid), tpl.main_file, 'tectonic')
            self.assertTrue(out['pdf'], f'{tpl.id} produced no PDF with tectonic:\n{out["log"][-1500:]}')
