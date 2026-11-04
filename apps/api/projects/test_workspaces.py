from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from accounts.serializers import RegisterSerializer
from .models import Membership, Project, Workspace, WorkspaceInvite
from .test_api import ApiBase, client_for, make_user

User = get_user_model()


class WorkspaceApiTests(ApiBase):
    def setUp(self):
        super().setUp()
        self.ws_id = self.c.post('/api/workspaces', {'name': 'Lab'}, format='json').data['workspace']['id']
        self.base = f'/api/workspaces/{self.ws_id}'

    def member(self, email, role):
        """An account that is a member of the Lab workspace with `role`, and a client for it."""
        user = make_user(email)
        Membership.objects.create(workspace_id=self.ws_id, user=user, role=role)
        return user, client_for(user)

    def roles(self, client=None):
        ws = next(w for w in (client or self.c).get('/api/workspaces').data['workspaces'] if w['id'] == self.ws_id)
        return {ws['users'][m['userId']]['email']: m['role'] for m in ws['members']}

    def test_list_shape_matches_what_the_ui_expects(self):
        data = self.c.get('/api/workspaces').data['workspaces']
        self.assertEqual([(w['name'], w['kind']) for w in data], [('Personal', 'Personal'), ('Lab', 'Team')])
        lab = data[1]
        self.assertEqual(lab['members'], [{'userId': str(self.user.id), 'role': 'Owner'}])
        self.assertEqual(lab['users'][str(self.user.id)]['email'], 'owner@example.com')
        self.assertRegex(lab['color'], r'^#[0-9a-f]{6}$')
        self.assertRegex(lab['users'][str(self.user.id)]['color'], r'^#[0-9a-f]{6}$')

    def test_create_and_rename_validation(self):
        self.assertEqual(self.c.post('/api/workspaces', {'name': '  '}, format='json').status_code, 400)
        self.assertEqual(self.c.post('/api/workspaces', {'name': 'lab'}, format='json').data['error'], 'You already have a workspace with that name.')
        self.assertTrue(self.c.patch(self.base, {'name': 'Research Lab'}, format='json').data['ok'])
        self.assertEqual(self.c.patch(self.base, {'name': 'Personal'}, format='json').status_code, 400)

    def test_only_admins_manage_the_workspace(self):
        _, editor = self.member('ed@example.com', 'editor')
        _, admin = self.member('ad@example.com', 'admin')
        outsider = client_for(make_user('out@example.com'))
        self.assertEqual(editor.patch(self.base, {'name': 'X'}, format='json').status_code, 403)
        self.assertEqual(editor.post(f'{self.base}/members', {'email': 'a@b.co', 'role': 'viewer'}, format='json').status_code, 403)
        self.assertEqual(outsider.patch(self.base, {'name': 'X'}, format='json').status_code, 404)    # existence not revealed
        self.assertEqual(outsider.get('/api/workspaces').data['workspaces'][0]['name'], 'Personal')
        self.assertTrue(admin.patch(self.base, {'name': 'Admin renamed'}, format='json').data['ok'])

    def test_invite_existing_user_adds_them_immediately(self):
        make_user('known@example.com')
        res = self.c.post(f'{self.base}/members', {'email': 'Known@Example.com', 'role': 'Commenter'}, format='json')
        self.assertEqual(res.status_code, 201)
        self.assertEqual(self.roles()['known@example.com'], 'Commenter')
        self.assertEqual(self.c.post(f'{self.base}/members', {'email': 'known@example.com', 'role': 'editor'}, format='json').status_code, 409)

    def test_invite_unknown_email_becomes_membership_once_the_address_is_verified(self):
        res = self.c.post(f'{self.base}/members', {'email': 'new@university.edu', 'role': 'editor'}, format='json')
        pending = [m for m in res.data['workspace']['members'] if m.get('invited')]
        self.assertEqual([{k: m[k] for k in ('userId', 'role', 'invited', 'sendFailed')} for m in pending],
                         [{'userId': 'invite-new@university.edu', 'role': 'Editor', 'invited': True, 'sendFailed': False}])
        self.assertTrue(pending[0]['invitedAt'].endswith('Z') and pending[0]['lastSentAt'].endswith('Z'))
        self.assertEqual(res.data['workspace']['users']['invite-new@university.edu']['email'], 'new@university.edu')
        self.assertEqual(self.c.post(f'{self.base}/members', {'email': 'new@university.edu', 'role': 'viewer'}, format='json').status_code, 409)
        newcomer = APIClient()
        reg = newcomer.post('/api/auth/register', {'email': 'New@University.edu', 'password': 'correct-horse-battery'}, format='json')
        newcomer.credentials(HTTP_AUTHORIZATION=f"Bearer {reg.data['access']}")
        names = lambda: sorted(w['name'] for w in newcomer.get('/api/workspaces').data['workspaces'])
        self.assertEqual(names(), ['Personal'])  # registering alone proves nothing about the address
        from accounts.verification import make_token
        from accounts.models import User
        self.assertTrue(newcomer.post('/api/auth/verify-email', {'token': make_token(User.objects.get(email='new@university.edu'))}, format='json').data['ok'])
        self.assertEqual(names(), ['Lab', 'Personal'])                                # joined Lab once verified
        self.assertEqual(self.roles()['new@university.edu'], 'Editor')
        self.assertFalse(WorkspaceInvite.objects.exists())

    def test_invite_validation(self):
        for body in ({'email': 'nope', 'role': 'editor'}, {'email': 'a@b.co', 'role': 'owner'}, {'email': 'a@b.co', 'role': 'wizard'}):
            self.assertEqual(self.c.post(f'{self.base}/members', body, format='json').status_code, 400, body)

    def test_role_changes_and_removal(self):
        user, _ = self.member('m@example.com', 'editor')
        mid = str(user.id)
        self.assertEqual(self.c.patch(f'{self.base}/members/{mid}', {'role': 'Viewer'}, format='json').status_code, 200)
        self.assertEqual(self.roles()['m@example.com'], 'Viewer')
        self.assertEqual(self.c.patch(f'{self.base}/members/{mid}', {'role': 'superuser'}, format='json').status_code, 400)
        self.assertEqual(self.c.patch(f'{self.base}/members/{self.user.id}', {'role': 'viewer'}, format='json').status_code, 403)  # owner
        self.assertEqual(self.c.delete(f'{self.base}/members/{self.user.id}').status_code, 403)
        self.assertTrue(self.c.delete(f'{self.base}/members/{mid}').data['ok'])
        self.assertNotIn('m@example.com', self.roles())
        self.c.post(f'{self.base}/members', {'email': 'p@example.com', 'role': 'viewer'}, format='json')
        self.assertEqual(self.c.patch(f'{self.base}/members/invite-p@example.com', {'role': 'owner'}, format='json').status_code, 400)  # members only
        self.assertTrue(self.c.patch(f'{self.base}/members/invite-p@example.com', {'role': 'editor'}, format='json').data['ok'])
        self.assertEqual(self.roles()['p@example.com'], 'Editor')
        self.assertTrue(self.c.delete(f'{self.base}/members/invite-p@example.com').data['ok'])
        self.assertNotIn('p@example.com', self.roles())
        self.assertEqual(self.c.delete(f'{self.base}/members/not-a-uuid').status_code, 404)

    def test_admins_cannot_grant_or_touch_admin_rights(self):
        other_admin, _ = self.member('a2@example.com', 'admin')
        _, admin = self.member('a1@example.com', 'admin')
        _, editor = self.member('e@example.com', 'editor')
        eid = str(User.objects.get(email='e@example.com').id)
        self.assertEqual(admin.post(f'{self.base}/members', {'email': 'x@y.co', 'role': 'admin'}, format='json').status_code, 403)
        self.assertEqual(admin.patch(f'{self.base}/members/{eid}', {'role': 'admin'}, format='json').status_code, 403)
        self.assertEqual(admin.patch(f'{self.base}/members/{other_admin.id}', {'role': 'viewer'}, format='json').status_code, 403)
        self.assertEqual(admin.patch(f'{self.base}/members/{eid}', {'role': 'viewer'}, format='json').status_code, 200)

    def test_leave_rules(self):
        personal = next(w['id'] for w in self.c.get('/api/workspaces').data['workspaces'] if w['kind'] == 'Personal')
        self.assertEqual(self.c.post(f'/api/workspaces/{personal}/leave').status_code, 400)
        self.assertIn('only owner', self.c.post(f'{self.base}/leave').data['error'])
        _, editor = self.member('e@example.com', 'editor')
        self.assertTrue(editor.post(f'{self.base}/leave').data['ok'])
        self.assertNotIn('e@example.com', self.roles())

    def test_roles_gate_project_writes(self):
        pid = self.c.post('/api/projects', {'name': 'P', 'workspaceId': self.ws_id}, format='json').data['id']
        for role, can_write in (('editor', True), ('commenter', False), ('viewer', False)):
            _, client = self.member(f'{role}@example.com', role)
            tree = client.get(f'/api/projects/{pid}/tree')
            self.assertEqual(tree.status_code, 200, role)
            self.assertEqual(tree.data['canWrite'], can_write, role)  # the editor hides write-only tools
            code = client.put(f'/api/projects/{pid}/file', {'path': 'a.tex', 'content': 'x'}, format='json').status_code
            self.assertEqual(code, 200 if can_write else 403, role)

    def test_move_project_between_workspaces(self):
        personal = next(w['id'] for w in self.c.get('/api/workspaces').data['workspaces'] if w['kind'] == 'Personal')
        pid = self.c.post('/api/projects', {'name': 'Movable'}, format='json').data['id']
        self.assertEqual(Project.objects.get(pk=pid).workspace_id.hex, personal.replace('-', ''))
        res = self.c.patch(f'/api/projects/{pid}/workspace', {'workspaceId': self.ws_id}, format='json')
        self.assertEqual(res.data['project']['workspaceId'], self.ws_id)
        # members of the new workspace now see it; a viewer cannot move things into a workspace they cannot edit
        _, viewer = self.member('v@example.com', 'viewer')
        self.assertIn(pid, [p['id'] for p in viewer.get('/api/projects').data['projects']])
        self.assertEqual(self.c.patch(f'/api/projects/{pid}/workspace', {'workspaceId': str(Workspace.objects.create(name='Foreign').id)}, format='json').status_code, 403)
        self.assertEqual(viewer.patch(f'/api/projects/{pid}/workspace', {'workspaceId': personal}, format='json').status_code, 403)
        self.assertEqual(self.c.patch(f'/api/projects/{pid}/workspace', {}, format='json').status_code, 403)

    def test_new_projects_land_in_the_chosen_workspace(self):
        pid = self.c.post('/api/projects', {'name': 'In Lab', 'workspaceId': self.ws_id}, format='json').data['id']
        self.assertEqual(Project.objects.get(pk=pid).workspace_id.hex, self.ws_id.replace('-', ''))
        stranger = Workspace.objects.create(name='Stranger').id
        self.assertEqual(self.c.post('/api/projects', {'name': 'x', 'workspaceId': str(stranger)}, format='json').status_code, 404)


class InvitationMailTests(ApiBase):
    def setUp(self):
        super().setUp()
        self.ws_id = self.c.post('/api/workspaces', {'name': 'Lab'}, format='json').data['workspace']['id']
        self.base = f'/api/workspaces/{self.ws_id}'

    def test_new_address_gets_a_sign_up_link_with_the_address_filled_in(self):
        from django.core import mail as outbox
        self.c.post(f'{self.base}/members', {'email': 'new@uni.edu', 'role': 'viewer'}, format='json')
        msg = outbox.outbox[-1]
        self.assertEqual(msg.to, ['new@uni.edu'])
        self.assertIn('invited you to Lab', msg.subject)
        self.assertIn('http://localhost:5173/register?email=new%40uni.edu&invited=1', msg.body)
        self.assertIn('as viewer', msg.body)

    def test_existing_account_is_added_and_told(self):
        from django.core import mail as outbox
        make_user('known@uni.edu')
        outbox.outbox.clear()
        self.c.post(f'{self.base}/members', {'email': 'known@uni.edu', 'role': 'editor'}, format='json')
        self.assertEqual(outbox.outbox[-1].to, ['known@uni.edu'])
        self.assertIn('added you to Lab', outbox.outbox[-1].subject)

    def test_resend_is_throttled_and_admin_only(self):
        from datetime import timedelta
        from django.core import mail as outbox
        from django.utils import timezone
        self.c.post(f'{self.base}/members', {'email': 'new@uni.edu', 'role': 'editor'}, format='json')
        sent = len(outbox.outbox)
        url = f'{self.base}/members/invite-new@uni.edu/resend'
        self.assertEqual(self.c.post(url).status_code, 429)
        WorkspaceInvite.objects.update(last_sent_at=timezone.now() - timedelta(minutes=11))
        self.assertTrue(self.c.post(url).data['ok'])
        self.assertEqual(len(outbox.outbox), sent + 1)
        editor = make_user('ed@uni.edu')
        Membership.objects.create(workspace_id=self.ws_id, user=editor, role=Membership.EDITOR)
        self.assertEqual(client_for(editor).post(url).status_code, 403)
        self.assertEqual(self.c.post(f'{self.base}/members/invite-nobody@uni.edu/resend').status_code, 404)

    def test_a_mail_that_cannot_be_delivered_is_flagged(self):
        import smtplib
        from unittest import mock
        from accounts.tasks import send_email
        with mock.patch('accounts.mail.deliver', side_effect=smtplib.SMTPServerDisconnected('down')), \
                mock.patch.object(send_email, 'max_retries', 0), self.assertLogs('accounts.tasks', 'WARNING'):
            res = self.c.post(f'{self.base}/members', {'email': 'new@uni.edu', 'role': 'editor'}, format='json')
        self.assertEqual(res.status_code, 201)  # the invitation stands even though its mail did not go out
        self.assertTrue(WorkspaceInvite.objects.get(email='new@uni.edu').send_failed)
        WorkspaceInvite.objects.update(last_sent_at=None)
        self.c.post(f'{self.base}/members/invite-new@uni.edu/resend')  # works this time
        self.assertFalse(WorkspaceInvite.objects.get(email='new@uni.edu').send_failed)
