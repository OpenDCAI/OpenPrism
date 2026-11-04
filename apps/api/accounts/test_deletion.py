from django.contrib.auth import get_user_model

from integrations.models import ZoteroConnection
from projects import files, storage
from projects.models import Membership, Project, Workspace
from projects.test_api import ApiBase, client_for, make_user

User = get_user_model()
PASSWORD = 'correct-horse-battery'


class DeleteAccountTests(ApiBase):
    def delete(self, client=None, password=PASSWORD):
        return (client or self.c).delete('/api/auth/me', {'password': password}, format='json')

    def test_deletes_the_account_its_workspaces_projects_and_storage(self):
        pid = self.new_project('Mine')
        project = Project.objects.get(pk=pid)
        files.write_binary(project, 'fig.png', b'\x89PNG', 'image/png')
        key = project.files.get(path='fig.png').s3_key
        solo = self.c.post('/api/workspaces', {'name': 'Solo team'}, format='json').data['workspace']['id']
        ZoteroConnection.objects.create(user=self.user, zotero_user_id=1, username='z', api_key_encrypted=b'x', last_four='1234')
        res = self.delete()
        self.assertEqual(res.data, {'ok': True})
        self.assertFalse(User.objects.filter(pk=self.user.pk).exists())
        self.assertFalse(Project.objects.filter(pk=pid).exists())
        self.assertFalse(Workspace.objects.filter(pk=solo).exists())
        self.assertFalse(ZoteroConnection.objects.exists())
        with self.assertRaises(Exception):
            storage.get_bytes(key)  # the binary is gone from object storage

    def test_wrong_password_deletes_nothing(self):
        pid = self.new_project()
        self.assertEqual(self.delete(password='nope').status_code, 400)
        self.assertTrue(Project.objects.filter(pk=pid).exists())
        self.assertTrue(User.objects.filter(pk=self.user.pk).exists())

    def test_only_owner_of_a_shared_workspace_is_blocked_until_someone_else_owns_it(self):
        ws = self.c.post('/api/workspaces', {'name': 'Lab'}, format='json').data['workspace']['id']
        other = make_user('ed@example.com')
        Membership.objects.create(workspace_id=ws, user=other, role=Membership.EDITOR)
        shared = self.c.post('/api/projects', {'name': 'Shared', 'workspaceId': ws}, format='json').data['id']
        res = self.delete()
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.data['workspaces'], [{'id': ws, 'name': 'Lab'}])
        self.assertTrue(User.objects.filter(pk=self.user.pk).exists())

        # an admin cannot hand out ownership; the owner can
        admin = make_user('ad@example.com')
        Membership.objects.create(workspace_id=ws, user=admin, role=Membership.ADMIN)
        self.assertEqual(client_for(admin).patch(f'/api/workspaces/{ws}/members/{other.id}', {'role': 'owner'}, format='json').status_code, 403)
        self.assertEqual(self.c.patch(f'/api/workspaces/{ws}/members/{other.id}', {'role': 'owner'}, format='json').status_code, 200)
        self.assertEqual(Membership.objects.get(workspace_id=ws, user=other).role, Membership.OWNER)
        # and owners cannot be demoted afterwards
        self.assertEqual(self.c.patch(f'/api/workspaces/{ws}/members/{other.id}', {'role': 'viewer'}, format='json').status_code, 403)

        self.assertEqual(self.delete().data, {'ok': True})
        self.assertTrue(Workspace.objects.filter(pk=ws).exists())  # the shared workspace and its project stay
        self.assertTrue(Project.objects.filter(pk=shared).exists())
        self.assertEqual(Membership.objects.filter(workspace_id=ws).count(), 2)

    def test_membership_elsewhere_is_removed_and_their_projects_untouched(self):
        owner = make_user('boss@example.com')
        boss = client_for(owner)
        ws = boss.post('/api/workspaces', {'name': 'Boss lab'}, format='json').data['workspace']['id']
        Membership.objects.create(workspace_id=ws, user=self.user, role=Membership.EDITOR)
        theirs = boss.post('/api/projects', {'name': 'Theirs', 'workspaceId': ws}, format='json').data['id']
        self.assertTrue(self.delete().data['ok'])
        self.assertTrue(Project.objects.filter(pk=theirs).exists())
        self.assertFalse(Membership.objects.filter(workspace_id=ws, user_id=self.user.pk).exists())

    def test_tokens_stop_working(self):
        from rest_framework_simplejwt.tokens import RefreshToken
        refresh = str(RefreshToken.for_user(self.user))
        self.assertTrue(self.delete().data['ok'])
        from rest_framework.test import APIClient
        self.assertEqual(APIClient().post('/api/auth/refresh', {'refresh': refresh}, format='json').status_code, 401)
        self.assertEqual(self.c.get('/api/auth/me').status_code, 401)
