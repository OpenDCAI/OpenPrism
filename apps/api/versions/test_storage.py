from datetime import timedelta

from django.utils import timezone

from jobs.tests import make_png
from projects import files
from projects.models import Membership, Project
from projects.test_api import client_for, make_user

from .models import ProjectVersion
from .tasks import prune_versions
from .test_api import VersionApiBase
from .test_retention import exists


class StorageReportTests(VersionApiBase):
    def storage(self, client=None, **patch):
        url = f'/api/workspaces/{self.project.workspace_id}/storage'
        c = client or self.c
        return c.patch(url, patch, format='json') if patch else c.get(url)

    def test_the_numbers_match_a_hand_computed_project(self):
        png = make_png()
        files.write_text(self.project, 'main.tex', 'one')  # 3 bytes
        files.write_binary(self.project, 'fig.png', png, 'image/png')
        v1 = self.save_version(pdf=b'%PDF-1', log='log1')  # pdf 6, log 4
        files.write_text(self.project, 'main.tex', 'three')  # 5 bytes; fig.png's blob is shared by both versions
        v2 = self.save_version(pdf=b'%PDF-22', log='log22')  # pdf 7, log 5
        ProjectVersion.objects.filter(pk=v2.pk).update(pdf_key=v1.pdf_key, pdf_size=6)  # one PDF shared by two versions
        other = Project.objects.get(pk=self.new_project('Other'))
        files.write_text(other, 'main.tex', 'é')  # 2 bytes in UTF-8, 1 character
        Project.objects.filter(pk=other.pk).update(trashed=True)

        body = self.storage().data
        self.assertTrue(body['ok'])
        paper = next(p for p in body['projects'] if p['id'] == self.pid)
        self.assertEqual((paper['fileBytes'], paper['versionCount']), (5 + len(png), 2))
        self.assertEqual(paper['versionBytes'], (3 + 5 + len(png)) + 6 + (4 + 5))  # blobs once, the PDF once, both logs
        trashed = next(p for p in body['projects'] if p['id'] == str(other.pk))
        self.assertEqual((trashed['fileBytes'], trashed['versionBytes'], trashed['trashed']), (2, 0, True))
        self.assertEqual(body['projects'][0]['id'], self.pid)  # largest history first
        self.assertEqual(body['totals'], {'fileBytes': 7 + len(png), 'versionBytes': paper['versionBytes'], 'versionCount': 2})
        self.assertIsNone(body['versionRetentionDays'])

    def test_only_owners_and_admins_may_see_or_change_it(self):
        for role in (Membership.EDITOR, Membership.COMMENTER, Membership.VIEWER):
            user = make_user(f'{role}@example.com')
            Membership.objects.create(workspace=self.project.workspace, user=user, role=role)
            self.assertEqual(self.storage(client_for(user)).status_code, 403)
            self.assertEqual(self.storage(client_for(user), versionRetentionDays=30).status_code, 403)
        admin = make_user('admin@example.com')
        Membership.objects.create(workspace=self.project.workspace, user=admin, role=Membership.ADMIN)
        self.assertEqual(self.storage(client_for(admin)).status_code, 200)
        self.assertEqual(self.storage(client_for(make_user('stranger@example.com'))).status_code, 404)

    def test_the_retention_setting_is_validated_and_kept(self):
        for bad in (0, -1, 'abc', '30', 5000, True, 2.5):
            res = self.storage(versionRetentionDays=bad)
            self.assertEqual(res.status_code, 400, bad)
            self.assertIn('days', res.data['error'])
        self.assertEqual(self.c.patch(f'/api/workspaces/{self.project.workspace_id}/storage', {}, format='json').status_code, 400)
        self.assertEqual(self.storage(versionRetentionDays=30).data['versionRetentionDays'], 30)
        self.assertEqual(self.storage().data['versionRetentionDays'], 30)
        res = self.c.patch(f'/api/workspaces/{self.project.workspace_id}/storage', {'versionRetentionDays': None}, format='json')
        self.assertIsNone(res.data['versionRetentionDays'])


class AgeRetentionTests(VersionApiBase):
    def make(self, ages):
        """One version per age in days, oldest first."""
        out = []
        for i, age in enumerate(ages):
            files.write_text(self.project, 'main.tex', f'draft {i}')
            v = self.save_version(log=f'log {i}')
            ProjectVersion.objects.filter(pk=v.pk).update(created_at=timezone.now() - timedelta(days=age))
            out.append(v)
        return out

    def keep_for(self, days):
        self.project.workspace.version_retention_days = days
        self.project.workspace.save()

    def numbers(self):
        return sorted(self.project.versions.values_list('number', flat=True))

    def test_unnamed_versions_older_than_the_setting_go_and_named_ones_stay(self):
        v = self.make([60, 45, 40, 10, 1])
        ProjectVersion.objects.filter(pk=v[0].pk).update(name='submitted')
        self.keep_for(30)
        self.assertEqual(prune_versions(), 2)
        self.assertEqual(self.numbers(), [1, 4, 5])
        self.assertFalse(exists(v[1].pdf_key) or exists(v[1].log_key))

    def test_the_newest_version_stays_however_old(self):
        self.make([400, 300, 200])
        self.keep_for(30)
        prune_versions()
        self.assertEqual(self.numbers(), [3])

    def test_with_the_setting_off_age_does_not_matter(self):
        self.make([400, 300, 200])
        self.assertEqual(prune_versions(), 0)
        self.assertEqual(self.numbers(), [1, 2, 3])

    def test_the_count_limit_still_applies_with_an_age_limit(self):
        self.make([5, 4, 3, 2, 1])
        self.keep_for(30)
        with self.settings(VERSION_KEEP_UNNAMED=2):
            prune_versions()
        self.assertEqual(self.numbers(), [4, 5])
