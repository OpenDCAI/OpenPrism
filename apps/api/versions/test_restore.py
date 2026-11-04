import asyncio
from unittest import mock

from asgiref.sync import sync_to_async
from django.test import override_settings

from collab.tests import CollabTestBase, settle
from jobs import compile as tex
from jobs.tests import make_png
from projects import files, storage
from projects.models import Membership, Project, ProjectFile
from projects.test_api import client_for, make_user

from . import snapshot
from .models import ProjectVersion, VersionBlob
from .test_api import VersionApiBase
from .test_retention import exists


def state(project):
    """Every row as (path, kind, text or the bytes), for comparing the project before and after."""
    out = {}
    for row in project.files.order_by('path'):
        out[row.path] = (row.kind, row.content if row.kind == ProjectFile.TEXT else storage.get_bytes(row.s3_key) if row.s3_key else '')
    return out


class RestoreTests(VersionApiBase):
    def restore(self, version, client=None, pid=None):
        return (client or self.c).post(self.url(version.id, 'restore', pid=pid), {}, format='json')

    def build_v1(self):
        files.write_text(self.project, 'main.tex', 'version one')
        files.write_text(self.project, 'sec/a.tex', 'section a')
        files.write_binary(self.project, 'figs/dot.png', make_png(), 'image/png')
        files.mkdir(self.project, 'empty')
        return self.save_version(pdf=b'%PDF-one')

    def drift(self):
        files.write_text(self.project, 'main.tex', 'version two')
        files.delete(self.project, 'sec/a.tex')  # deleted since
        files.write_binary(self.project, 'figs/dot.png', b'other bytes', 'image/png')
        files.write_text(self.project, 'extra.tex', 'did not exist in v1')
        files.write_binary(self.project, 'extra.png', b'png2', 'image/png')
        files.delete(self.project, 'empty')

    def test_restoring_makes_the_project_byte_identical_and_records_a_new_version(self):
        v1 = self.build_v1()
        expected = state(self.project)
        self.drift()
        v2 = self.save_version(pdf=b'%PDF-two')
        self.assertNotEqual(state(self.project), expected)

        with self.captureOnCommitCallbacks(execute=True):
            res = self.restore(v1)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual((res.data['restored'], res.data['versionNumber']), (True, 3))
        self.assertEqual(state(self.project), expected)

        created = ProjectVersion.objects.get(number=3)
        self.assertEqual((created.restored_from, created.manifest_hash), (v1, v1.manifest_hash))
        self.assertEqual(self.c.get(self.url()).data['versions'][0]['restoredFrom'], 1)
        # history is untouched, and the restore has its own copy of the PDF
        self.assertEqual(list(ProjectVersion.objects.order_by('number').values_list('number', flat=True)), [1, 2, 3])
        self.assertNotEqual(created.pdf_key, v1.pdf_key)
        self.assertEqual(storage.get_bytes(created.pdf_key), b'%PDF-one')
        self.assertEqual(storage.get_bytes(v2.pdf_key), b'%PDF-two')

    def test_the_replaced_binaries_are_deleted_only_after_the_commit(self):
        v1 = self.build_v1()
        old_key = self.project.files.get(path='figs/dot.png').s3_key
        files.write_binary(self.project, 'figs/dot.png', b'changed', 'image/png')
        changed_key = self.project.files.get(path='figs/dot.png').s3_key
        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            self.assertEqual(self.restore(v1).status_code, 200)
            self.assertTrue(exists(changed_key))  # still there until the transaction commits
        for callback in callbacks:
            callback()
        self.assertFalse(exists(changed_key))
        self.assertFalse(exists(old_key) and old_key == changed_key)

    def test_restoring_an_identical_state_writes_nothing(self):
        v1 = self.build_v1()
        res = self.restore(v1)
        self.assertEqual((res.status_code, res.data['restored']), (200, False))
        self.assertEqual(ProjectVersion.objects.count(), 1)

    def test_a_compile_after_a_restore_does_not_duplicate_the_version(self):
        v1 = self.build_v1()
        self.drift()
        self.save_version()
        self.restore(v1)
        import shutil
        import tempfile
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        _, created = snapshot.record(self.project, tex.materialise(self.project, root), b'%PDF', 'main.tex', 'pdflatex')
        self.assertFalse(created)
        self.assertEqual(ProjectVersion.objects.count(), 3)

    def test_a_file_can_turn_into_a_folder_and_back(self):
        files.write_text(self.project, 'a', 'I am a file')
        files.write_text(self.project, 'z/inner.tex', 'inner')
        file_version = self.save_version()
        files.delete(self.project, 'a')
        files.delete(self.project, 'z')
        files.write_text(self.project, 'a/b.tex', 'now a folder')
        files.write_text(self.project, 'z', 'now a file')
        folder_version = self.save_version()
        self.assertEqual(self.restore(file_version).status_code, 200)
        self.assertEqual(state(self.project), {'a': ('text', 'I am a file'), 'z/inner.tex': ('text', 'inner')})
        self.assertEqual(self.restore(folder_version).status_code, 200)
        self.assertEqual(state(self.project), {'a/b.tex': ('text', 'now a folder'), 'z': ('text', 'now a file')})

    def test_a_failed_binary_copy_leaves_the_project_unchanged(self):
        v1 = self.build_v1()
        self.drift()
        before = state(self.project)
        keys_before = set(self.project.files.exclude(s3_key='').values_list('s3_key', flat=True))
        real = storage.copy
        calls = []

        def flaky(src, dst):
            calls.append(dst)
            if len(calls) == 2:
                raise RuntimeError('s3 hiccup')
            real(src, dst)

        with mock.patch('projects.files.storage.copy', side_effect=flaky):
            res = self.restore(v1)
        self.assertEqual(res.status_code, 500)
        self.assertIn('nothing was changed', res.data['error'])
        self.assertEqual(state(self.project), before)
        self.assertEqual(ProjectVersion.objects.count(), 1)
        self.assertEqual(set(self.project.files.exclude(s3_key='').values_list('s3_key', flat=True)), keys_before)
        self.assertFalse(exists(calls[0]))  # the object staged before the failure was cleaned up

    def test_a_failure_recording_the_version_rolls_everything_back(self):
        v1 = self.build_v1()
        self.drift()
        before = state(self.project)
        staged = []
        real = pfiles_apply = __import__('projects.files', fromlist=['apply_changes']).apply_changes

        def spy(*args, **kwargs):
            applied = real(*args, **kwargs)
            staged.extend(applied.staged_keys)
            return applied

        with mock.patch('versions.views.pfiles.apply_changes', side_effect=spy), \
                mock.patch('versions.views.snapshot.record_restore', side_effect=RuntimeError('db hiccup')):
            res = self.restore(v1)
        self.assertEqual(res.status_code, 500)
        self.assertEqual(state(self.project), before)
        self.assertTrue(staged)
        self.assertFalse(any(exists(k) for k in staged))
        del pfiles_apply

    def test_a_version_whose_content_was_lost_cannot_be_restored(self):
        v1 = self.build_v1()
        self.drift()
        before = state(self.project)
        VersionBlob.objects.filter(project=self.project, text='version one').delete()
        res = self.restore(v1)
        self.assertEqual(res.status_code, 409)
        self.assertEqual(state(self.project), before)

    def test_permissions(self):
        v1 = self.build_v1()
        self.drift()
        before = state(self.project)
        viewer = make_user('viewer@example.com')
        Membership.objects.create(workspace=self.project.workspace, user=viewer, role=Membership.VIEWER)
        for c in (client_for(viewer), self.guest('viewer')):
            self.assertEqual(self.restore(v1, c).status_code, 403)
        self.assertEqual(self.restore(v1, client_for(make_user('stranger@example.com'))).status_code, 404)
        other = Project.objects.get(pk=self.new_project('Other'))
        files.write_text(other, 'main.tex', 'x')
        theirs = self.save_version(other)
        self.assertEqual(self.restore(theirs).status_code, 404)
        self.assertEqual(state(self.project), before)
        self.assertEqual(self.restore(v1, self.guest('editor')).status_code, 200)  # an editor guest may

    def test_a_live_room_on_an_affected_file_blocks_everything(self):
        v1 = self.build_v1()
        self.drift()
        before = state(self.project)
        with mock.patch('versions.views.live_room', side_effect=lambda project, path: path == 'main.tex'), \
                mock.patch('versions.views.flush_room', return_value=True), \
                mock.patch('versions.views.evict_idle_room', return_value=False):
            res = self.restore(v1)
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.data['files'], ['main.tex'])
        self.assertIn('open', res.data['error'])
        self.assertEqual(state(self.project), before)  # unaffected files were not touched either
        self.assertEqual(ProjectVersion.objects.count(), 1)

    def test_a_live_room_on_an_unaffected_file_does_not_block(self):
        v1 = self.build_v1()
        files.write_text(self.project, 'extra.tex', 'changes')  # the only difference is extra.tex
        with mock.patch('versions.views.live_room', side_effect=lambda project, path: path == 'main.tex'), \
                mock.patch('versions.views.flush_room', return_value=True), \
                mock.patch('versions.views.evict_idle_room', return_value=False):
            res = self.restore(v1)
        self.assertEqual(res.status_code, 200)
        self.assertNotIn('extra.tex', state(self.project))

    def test_live_edits_that_cannot_be_saved_block_the_restore(self):
        v1 = self.build_v1()
        self.drift()
        before = state(self.project)
        with mock.patch('versions.views.live_room', return_value=True), mock.patch('versions.views.flush_room', return_value=False):
            res = self.restore(v1)
        self.assertEqual(res.status_code, 409)
        self.assertEqual(state(self.project), before)


@override_settings(COLLAB_ROOM_EVICT_SECONDS=30)  # a room whose last client left lingers for a long time
class RestoreWithRealRoomsTests(CollabTestBase):
    async def setup_versions(self):
        def build():
            files.write_text(self.project, 'main.tex', 'the first version')
            import shutil
            import tempfile
            root = tempfile.mkdtemp()
            try:
                v1, _ = snapshot.record(self.project, tex.materialise(self.project, root), b'%PDF-1', 'main.tex', 'pdflatex')
            finally:
                shutil.rmtree(root, True)
            files.write_text(self.project, 'main.tex', 'the second version')
            return v1
        return await self.db(build)

    async def restore(self, version):
        client = await self.db(client_for, self.user)
        return await sync_to_async(client.post, thread_sensitive=False)(
            f'/api/projects/{self.pid}/versions/{version.id}/restore', {}, format='json')

    async def test_someone_connected_blocks_and_an_idle_room_does_not(self):
        v1 = await self.setup_versions()
        m = self.manager()
        alice = await self.join(m, name='alice')
        await settle(alice)
        self.assertEqual(str(alice.text), 'the second version')

        blocked = await self.restore(v1)
        self.assertEqual(blocked.status_code, 409, blocked.content)
        self.assertEqual(blocked.data['files'], ['main.tex'])
        self.assertEqual(await self.db(self.file_text), 'the second version')

        await alice.disconnect()
        await asyncio.sleep(0.3)
        done = await self.restore(v1)  # the idle room (still lingering for 30 s) is evicted first
        self.assertEqual(done.status_code, 200, done.content)
        self.assertEqual(await self.db(self.file_text), 'the first version')

        bob = await self.join(m, name='bob')  # a late joiner must see the restored text, not the evicted room's old one
        await settle(bob)
        self.assertEqual(str(bob.text), 'the first version')
        await bob.disconnect()

    async def test_unsaved_live_edits_are_flushed_before_the_comparison(self):
        v1 = await self.setup_versions()
        m = self.manager()
        alice = await self.join(m, name='alice')
        await settle(alice)
        alice.text.insert(0, '>> ')  # live text now differs from the database until a flush
        await settle(alice)
        blocked = await self.restore(v1)
        self.assertEqual(blocked.status_code, 409)
        self.assertEqual(await self.db(self.file_text), '>> the second version')  # flushed, and left alone
        await alice.disconnect()
