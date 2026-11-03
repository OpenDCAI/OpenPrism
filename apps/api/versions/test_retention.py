from django.test import override_settings

from jobs.tests import make_png
from projects import files, storage
from projects.models import Membership, Project
from projects.test_api import client_for, make_user

from . import retention, snapshot
from .models import ProjectVersion, VersionBlob
from .tasks import prune_versions
from .test_api import VersionApiBase


def exists(key):
    try:
        storage.get_bytes(key)
        return True
    except Exception:
        return False


class NameTests(VersionApiBase):
    def setUp(self):
        super().setUp()
        files.write_text(self.project, 'main.tex', 'x')
        self.v = self.save_version()

    def rename(self, name, client=None, pid=None):
        return (client or self.c).patch(self.url(self.v.id, pid=pid), {'name': name}, format='json')

    def test_editors_name_rename_and_clear(self):
        self.assertEqual(self.rename('  submitted to ACL ').data['version']['name'], 'submitted to ACL')
        self.assertEqual(self.rename('camera ready').data['version']['name'], 'camera ready')
        self.assertEqual(self.rename('').data['version']['name'], '')
        self.v.refresh_from_db()
        self.assertEqual(self.v.name, '')

    def test_bad_names_are_rejected(self):
        self.assertFalse(self.rename('x' * 101).data['ok'])
        res = self.c.patch(self.url(self.v.id), {'name': 5}, format='json')
        self.assertFalse(res.data['ok'])
        self.assertEqual(self.rename('x' * 100).data['version']['name'], 'x' * 100)

    def test_viewers_and_viewer_guests_cannot_change_anything(self):
        viewer = make_user('viewer@example.com')
        Membership.objects.create(workspace=self.project.workspace, user=viewer, role=Membership.VIEWER)
        for c in (client_for(viewer), self.guest('viewer')):
            self.assertEqual(self.rename('mine', c).status_code, 403)
            self.assertEqual(c.delete(self.url(self.v.id)).status_code, 403)
        self.v.refresh_from_db()
        self.assertEqual(self.v.name, '')
        self.assertTrue(ProjectVersion.objects.filter(pk=self.v.pk).exists())

    def test_non_members_get_404(self):
        stranger = client_for(make_user('stranger@example.com'))
        self.assertEqual(self.rename('mine', stranger).status_code, 404)
        self.assertEqual(stranger.delete(self.url(self.v.id)).status_code, 404)

    def test_an_editor_guest_may_name(self):
        self.assertEqual(self.rename('from a guest', self.guest('editor')).status_code, 200)


class DeleteTests(VersionApiBase):
    def test_deleting_removes_the_version_its_pdf_and_only_unshared_blobs(self):
        files.write_text(self.project, 'main.tex', 'one')
        files.write_binary(self.project, 'a.png', make_png(), 'image/png')
        v1 = self.save_version(pdf=b'%PDF-1')
        files.write_text(self.project, 'main.tex', 'two')  # a.png unchanged: shared by v1 and v2
        v2 = self.save_version(pdf=b'%PDF-2')
        png_key = VersionBlob.objects.get(kind='binary').s3_key
        self.assertEqual(VersionBlob.objects.count(), 3)

        self.assertTrue(self.c.delete(self.url(v1.id)).data['ok'])
        self.assertEqual(list(self.project.versions.values_list('number', flat=True)), [2])
        self.assertFalse(exists(v1.pdf_key))
        self.assertTrue(exists(v2.pdf_key))
        self.assertEqual(sorted(VersionBlob.objects.values_list('text', flat=True)), ['', 'two'])  # 'one' went, png stayed
        self.assertTrue(exists(png_key))

        self.c.delete(self.url(v2.id))
        self.assertEqual(VersionBlob.objects.count(), 0)
        self.assertFalse(exists(png_key))
        self.assertEqual(self.c.get(self.url(v2.id)).status_code, 404)

    def test_a_named_version_must_be_unnamed_first(self):
        files.write_text(self.project, 'main.tex', 'x')
        v = self.save_version()
        self.c.patch(self.url(v.id), {'name': 'submitted'}, format='json')
        res = self.c.delete(self.url(v.id))
        self.assertEqual(res.status_code, 400)
        self.assertIn('named', res.data['error'])
        self.assertTrue(ProjectVersion.objects.filter(pk=v.pk).exists())
        self.c.patch(self.url(v.id), {'name': ''}, format='json')
        self.assertTrue(self.c.delete(self.url(v.id)).data['ok'])

    def test_a_pdf_shared_by_two_versions_survives_deleting_one(self):
        files.write_text(self.project, 'main.tex', 'x')
        v1 = self.save_version()
        files.write_text(self.project, 'main.tex', 'y')
        v2 = self.save_version()
        ProjectVersion.objects.filter(pk=v2.pk).update(pdf_key=v1.pdf_key)
        self.c.delete(self.url(v1.id))
        self.assertTrue(exists(v1.pdf_key))

    def test_deleting_another_projects_version_is_404(self):
        other = Project.objects.get(pk=self.new_project('Other'))
        files.write_text(other, 'main.tex', 'x')
        theirs = self.save_version(other)
        self.assertEqual(self.c.delete(self.url(theirs.id)).status_code, 404)
        self.assertTrue(ProjectVersion.objects.filter(pk=theirs.pk).exists())


class PruneTests(VersionApiBase):
    def make(self, count, start=0):
        out = []
        for i in range(start, start + count):
            files.write_text(self.project, 'main.tex', f'draft {i}')
            out.append(self.save_version())
        return out

    def test_keeps_the_newest_50_unnamed_and_every_named_version(self):
        versions = self.make(63)
        named = versions[:3]  # the oldest three
        for v in named:
            ProjectVersion.objects.filter(pk=v.pk).update(name='keep me')
        doomed = [v for v in versions[3:13]]  # numbers 4..13 are the ten oldest unnamed

        self.assertEqual(prune_versions(), 10)

        left = set(self.project.versions.values_list('number', flat=True))
        self.assertEqual(left, set(range(1, 4)) | set(range(14, 64)))
        for v in doomed:
            self.assertFalse(exists(v.pdf_key))
        for v in named + versions[-50:]:
            self.assertTrue(exists(v.pdf_key))
        texts = set(VersionBlob.objects.values_list('text', flat=True))
        self.assertNotIn('draft 5', texts)  # its blob is gone
        self.assertIn('draft 0', texts)  # a named version's blob stays
        self.assertEqual(VersionBlob.objects.count(), 53)

    def test_a_second_run_changes_nothing(self):
        self.make(5)
        with override_settings(VERSION_KEEP_UNNAMED=2):
            self.assertEqual(prune_versions(), 3)
            self.assertEqual(prune_versions(), 0)
        self.assertEqual(self.project.versions.count(), 2)

    def test_the_latest_version_is_never_pruned(self):
        self.make(3)
        with override_settings(VERSION_KEEP_UNNAMED=0):
            retention.prune_all()
        self.assertEqual(list(self.project.versions.values_list('number', flat=True)), [3])

    def test_projects_under_the_limit_are_left_alone(self):
        self.make(4)
        self.assertEqual(prune_versions(), 0)
        self.assertEqual(self.project.versions.count(), 4)

    def test_other_projects_are_pruned_independently(self):
        self.make(3)
        other = Project.objects.get(pk=self.new_project('Other'))
        for i in range(3):
            files.write_text(other, 'main.tex', f'o{i}')
            self.save_version(other)
        with override_settings(VERSION_KEEP_UNNAMED=2):
            prune_versions()
        self.assertEqual((self.project.versions.count(), other.versions.count()), (2, 2))

    def test_collecting_blobs_is_safe_to_repeat(self):
        self.make(2)
        self.assertEqual(retention.collect_blobs(self.project), 0)
        self.project.versions.all().delete()
        self.assertEqual(retention.collect_blobs(self.project), 2)
        self.assertEqual(retention.collect_blobs(self.project), 0)


class ScheduleTests(VersionApiBase):
    def test_the_prune_task_is_scheduled_daily_and_routed(self):
        from django.conf import settings
        entry = settings.CELERY_BEAT_SCHEDULE['prune-versions']
        self.assertEqual((entry['task'], entry['schedule']), ('versions.tasks.prune_versions', 86400.0))
        from config.celery import app
        app.loader.import_default_modules()
        self.assertIn('versions.tasks.prune_versions', app.tasks)
        self.assertEqual(app.amqp.router.route({}, 'versions.tasks.prune_versions')['queue'].name, 'import')
