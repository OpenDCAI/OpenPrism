import shutil
import tempfile

from rest_framework.test import APIClient

from jobs import compile as tex
from jobs.tests import DOC, make_png
from projects import files
from projects.models import Membership, Project
from projects.test_api import ApiBase, client_for, make_user

from . import snapshot


class VersionApiBase(ApiBase):
    def setUp(self):
        super().setUp()
        self.pid = self.new_project()
        self.project = Project.objects.get(pk=self.pid)

    def save_version(self, project=None, pdf=b'%PDF-test', engine='pdflatex'):
        project = project or self.project
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        version, _ = snapshot.record(project, tex.materialise(project, root), pdf, 'main.tex', engine, user=self.user)
        return version

    def url(self, *parts, pid=None):
        return '/'.join(['/api/projects', str(pid or self.pid), 'versions', *map(str, parts)]).rstrip('/')

    def guest(self, role):
        token = self.c.post(f'/api/projects/{self.pid}/collab/invite', {'role': role}, format='json').data['token']
        g = APIClient()
        g.credentials(HTTP_AUTHORIZATION=f'Bearer {token}')
        return g


class ListAndDetailTests(VersionApiBase):
    def test_listing_is_newest_first_with_the_documented_fields(self):
        files.write_text(self.project, 'main.tex', DOC)
        files.mkdir(self.project, 'empty')
        v1 = self.save_version()
        files.write_text(self.project, 'main.tex', DOC + '% 2')
        v2 = self.save_version()
        body = self.c.get(self.url()).data
        self.assertTrue(body['ok'])
        self.assertEqual([v['number'] for v in body['versions']], [2, 1])
        self.assertFalse(body['hasMore'])
        top = body['versions'][0]
        self.assertEqual(top['id'], str(v2.id))
        self.assertEqual((top['mainFile'], top['engine'], top['name'], top['fileCount'], top['pdfSize'], top['restoredFrom']),
                         ('main.tex', 'pdflatex', '', 1, 9, None))
        self.assertEqual(top['createdBy'], {'name': 'owner'})
        self.assertTrue(top['createdAt'].endswith('Z'))
        self.assertNotIn('manifest', top)
        self.assertNotEqual(top['id'], str(v1.id))

    def test_the_list_says_whether_the_caller_may_change_versions(self):
        viewer = make_user('viewer@example.com')
        Membership.objects.create(workspace=self.project.workspace, user=viewer, role=Membership.VIEWER)
        self.assertTrue(self.c.get(self.url()).data['canWrite'])
        self.assertFalse(client_for(viewer).get(self.url()).data['canWrite'])
        self.assertTrue(self.guest('editor').get(self.url()).data['canWrite'])
        self.assertFalse(self.guest('viewer').get(self.url()).data['canWrite'])

    def test_paging(self):
        for i in range(3):
            files.write_text(self.project, 'main.tex', f'v{i}')
            self.save_version()
        page = self.c.get(self.url(), {'limit': 2}).data
        self.assertEqual(([v['number'] for v in page['versions']], page['hasMore']), ([3, 2], True))
        page = self.c.get(self.url(), {'limit': 2, 'before': 2}).data
        self.assertEqual(([v['number'] for v in page['versions']], page['hasMore']), ([1], False))
        self.assertEqual(self.c.get(self.url(), {'limit': 'x'}).status_code, 400)

    def test_detail_has_the_manifest(self):
        files.write_text(self.project, 'main.tex', DOC)
        v = self.save_version()
        body = self.c.get(self.url(v.id)).data['version']
        self.assertEqual([(m['path'], m['kind']) for m in body['manifest']], [('main.tex', 'text')])

    def test_another_projects_versions_never_appear(self):
        other = Project.objects.get(pk=self.new_project('Other'))
        files.write_text(other, 'main.tex', 'x')
        theirs = self.save_version(other)
        self.assertEqual(self.c.get(self.url()).data['versions'], [])
        self.assertEqual(self.c.get(self.url(theirs.id)).status_code, 404)  # right id, wrong project
        self.assertEqual(self.c.get(self.url(theirs.id, 'pdf')).status_code, 404)
        self.assertEqual(self.c.get(self.url('not-a-uuid')).status_code, 404)


class AccessTests(VersionApiBase):
    def setUp(self):
        super().setUp()
        files.write_text(self.project, 'main.tex', DOC)
        self.version = self.save_version()

    def test_login_is_required_and_non_members_get_404(self):
        self.assertEqual(APIClient().get(self.url()).status_code, 401)
        stranger = client_for(make_user('stranger@example.com'))
        for suffix in ((), (self.version.id,), (self.version.id, 'pdf'), ('diff',)):
            self.assertEqual(stranger.get(self.url(*suffix)).status_code, 404, suffix)

    def test_viewers_can_read(self):
        viewer = make_user('viewer@example.com')
        Membership.objects.create(workspace=self.project.workspace, user=viewer, role=Membership.VIEWER)
        c = client_for(viewer)
        self.assertEqual(len(c.get(self.url()).data['versions']), 1)
        self.assertEqual(c.get(self.url(self.version.id, 'pdf')).status_code, 200)

    def test_invite_guests_read_their_own_project_only(self):
        g = self.guest('viewer')
        self.assertEqual(len(g.get(self.url()).data['versions']), 1)
        self.assertEqual(g.get(self.url(self.version.id, 'pdf')).status_code, 200)
        other = self.new_project('Other')
        self.assertEqual(g.get(self.url(pid=other)).status_code, 404)

    def test_pdf_accepts_a_query_token_for_object_tags(self):
        from rest_framework_simplejwt.tokens import RefreshToken
        token = str(RefreshToken.for_user(self.user).access_token)
        res = APIClient().get(self.url(self.version.id, 'pdf'), {'token': token})
        self.assertEqual((res.status_code, res['Content-Type']), (200, 'application/pdf'))


class ContentTests(VersionApiBase):
    def test_pdf_and_files_are_what_was_compiled_even_after_the_project_changed(self):
        png = make_png()
        files.write_text(self.project, 'main.tex', DOC)
        files.write_binary(self.project, 'figs/dot.png', png, 'image/png')
        files.write_text(self.project, 'sec/a.tex', 'old text')
        v = self.save_version(pdf=b'%PDF-as-compiled')
        files.write_text(self.project, 'main.tex', 'rewritten')
        files.write_binary(self.project, 'figs/dot.png', b'replaced', 'image/png')
        files.delete(self.project, 'sec/a.tex')

        self.assertEqual(self.c.get(self.url(v.id, 'pdf')).content, b'%PDF-as-compiled')
        text = self.c.get(self.url(v.id, 'file'), {'path': 'main.tex'}).data
        self.assertEqual((text['kind'], text['content']), ('text', DOC))
        self.assertEqual(self.c.get(self.url(v.id, 'file'), {'path': 'sec/a.tex'}).data['content'], 'old text')
        res = self.c.get(self.url(v.id, 'file'), {'path': 'figs/dot.png'})
        self.assertEqual((res.content, res['Content-Type']), (png, 'image/png'))

    def test_untrusted_binaries_are_sandboxed(self):
        files.write_binary(self.project, 'a.svg', b'<svg onload="alert(1)"/>', 'image/svg+xml')
        v = self.save_version()
        res = self.c.get(self.url(v.id, 'file'), {'path': 'a.svg'})
        self.assertEqual(res['Content-Security-Policy'], 'sandbox')
        self.assertEqual(res['X-Content-Type-Options'], 'nosniff')

    def test_bad_paths_are_rejected_and_unknown_ones_are_404(self):
        files.write_text(self.project, 'main.tex', DOC)
        files.mkdir(self.project, 'empty')
        v = self.save_version()
        get = lambda path=None: self.c.get(self.url(v.id, 'file'), {'path': path} if path is not None else {})  # noqa: E731
        self.assertEqual(get().status_code, 400)
        for bad in ('../etc/passwd', '/etc/passwd', 'a/../../x'):
            self.assertEqual(get(bad).status_code, 400, bad)
        self.assertEqual(get('nope.tex').status_code, 404)
        self.assertEqual(get('empty').status_code, 404)  # a folder is not a file


class DiffTests(VersionApiBase):
    def setUp(self):
        super().setUp()
        files.write_text(self.project, 'main.tex', 'one')
        files.write_text(self.project, 'keep.tex', 'same')
        files.write_text(self.project, 'gone.tex', 'bye')
        files.write_binary(self.project, 'a.png', b'aaaa', 'image/png')
        files.write_binary(self.project, 'b.png', b'bbbb', 'image/png')
        self.v1 = self.save_version()
        files.write_text(self.project, 'main.tex', 'two')
        files.delete(self.project, 'gone.tex')
        files.write_text(self.project, 'new.tex', 'hi')
        files.write_binary(self.project, 'a.png', b'AAAA', 'image/png')  # same size, different bytes
        self.v2 = self.save_version()

    def diff(self, **params):
        res = self.c.get(self.url('diff'), params)
        self.assertEqual(res.status_code, 200, res.content)
        return {f['path']: (f['status'], f['kind']) for f in res.data['files']}

    def test_two_versions(self):
        self.assertEqual(self.diff(**{'from': self.v1.id, 'to': self.v2.id}), {
            'main.tex': ('modified', 'text'), 'gone.tex': ('removed', 'text'), 'new.tex': ('added', 'text'),
            'a.png': ('modified', 'binary')})

    def test_the_order_swaps_added_and_removed(self):
        d = self.diff(**{'from': self.v2.id, 'to': self.v1.id})
        self.assertEqual((d['gone.tex'][0], d['new.tex'][0]), ('added', 'removed'))

    def test_all_includes_unchanged_files(self):
        d = self.diff(**{'from': self.v1.id, 'to': self.v2.id, 'all': '1'})
        self.assertEqual((d['keep.tex'][0], d['b.png'][0]), ('unchanged', 'unchanged'))

    def test_against_the_current_project(self):
        self.assertEqual(self.diff(**{'from': self.v2.id, 'to': 'current'}), {})
        self.assertEqual(self.diff(**{'from': self.v2.id}), {})  # current is the default
        files.write_text(self.project, 'keep.tex', 'edited')
        files.write_binary(self.project, 'b.png', b'BBBB', 'image/png')  # same size, different bytes
        files.write_binary(self.project, 'c.png', b'cc', 'image/png')
        files.delete(self.project, 'new.tex')
        self.assertEqual(self.diff(**{'from': self.v2.id, 'to': 'current'}), {
            'keep.tex': ('modified', 'text'), 'b.png': ('modified', 'binary'), 'c.png': ('added', 'binary'),
            'new.tex': ('removed', 'text')})

    def test_an_unchanged_binary_of_equal_size_is_not_reported(self):
        files.write_binary(self.project, 'b.png', b'bbbb', 'image/png')  # rewritten with the same bytes
        self.assertNotIn('b.png', self.diff(**{'from': self.v2.id, 'to': 'current'}))

    def test_a_text_file_replaced_by_a_binary_is_modified(self):
        files.delete(self.project, 'keep.tex')
        files.write_binary(self.project, 'keep.tex', b'same', 'image/png')
        self.assertEqual(self.diff(**{'from': self.v2.id})['keep.tex'], ('modified', 'binary'))

    def test_versions_of_other_projects_and_missing_params(self):
        other = Project.objects.get(pk=self.new_project('Other'))
        files.write_text(other, 'main.tex', 'x')
        theirs = self.save_version(other)
        self.assertEqual(self.c.get(self.url('diff'), {'from': self.v1.id, 'to': theirs.id}).status_code, 404)
        self.assertEqual(self.c.get(self.url('diff'), {'from': theirs.id}).status_code, 404)
        self.assertEqual(self.c.get(self.url('diff')).status_code, 400)
        self.assertEqual(self.c.get(self.url('diff'), {'from': 'junk'}).status_code, 404)
