"""The sign-up gate (v0.1.2, #84)."""
import threading
from datetime import timedelta

from django.core import mail as outbox
from django.core.cache import cache
from django.db import connection
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from accounts import invitations
from accounts.models import PlatformInvite, User
from projects.models import Membership, Workspace, WorkspaceInvite

PASSWORD = 'correct-horse-battery'


def register(email, invite=None, client=None):
    body = {'email': email, 'password': PASSWORD}
    if invite is not None:
        body['invite'] = invite
    return (client or APIClient()).post('/api/auth/register', body, format='json')


@override_settings(REGISTRATION_MODE='invite')
class GateTests(TestCase):
    def setUp(self):
        cache.clear()
        self.admin = User.objects.create_user('root@example.com', PASSWORD, is_staff=True, is_superuser=True)
        outbox.outbox.clear()

    def assertGeneric(self, res):
        self.assertEqual(res.status_code, 400, res.data)
        self.assertIn('invitation is not valid or has expired', res.data['error'])

    def test_no_invitation_is_refused(self):
        self.assertGeneric(register('stranger@example.com'))
        self.assertFalse(User.objects.filter(email='stranger@example.com').exists())

    def test_wrong_other_address_expired_revoked_and_used_look_the_same(self):
        _, raw = invitations.create('a@example.com', self.admin)
        self.assertGeneric(register('a@example.com', raw + 'x'))
        self.assertGeneric(register('b@example.com', raw))
        self.assertGeneric(register('a@example.com', 'not-a-token'))
        PlatformInvite.objects.update(expires_at=timezone.now() - timedelta(minutes=1))
        self.assertGeneric(register('a@example.com', raw))
        invite, raw2 = invitations.create('c@example.com', self.admin)
        invitations.revoke(invite)
        self.assertGeneric(register('c@example.com', raw2))

    def test_valid_invitation_creates_a_verified_account_and_is_used_once(self):
        _, raw = invitations.create('Ann@example.com', self.admin)
        with self.captureOnCommitCallbacks(execute=True):
            res = register('ann@example.com', raw)
        self.assertEqual(res.status_code, 201, res.data)
        self.assertTrue(res.data['user']['emailVerified'])
        user = User.objects.get(email='ann@example.com')
        invite = PlatformInvite.objects.get(email='ann@example.com')
        self.assertEqual(invite.user, user)
        self.assertIsNotNone(invite.used_at)
        self.assertTrue(Workspace.objects.filter(memberships__user=user, kind=Workspace.PERSONAL).exists())
        self.assertEqual([m.subject for m in outbox.outbox if 'Confirm' in m.subject], [])  # no verification mail
        self.assertGeneric(register('ann2@example.com', raw))
        self.assertGeneric(register('ann@example.com', raw))  # used: not even "already exists"

    def test_invitation_joins_the_workspace_with_its_role(self):
        ws = Workspace.objects.create(name='Lab', kind=Workspace.TEAM)
        _, raw = invitations.create('ann@example.com', self.admin, workspace=ws, role='viewer')
        self.assertEqual(register('ann@example.com', raw).status_code, 201)
        self.assertEqual(Membership.objects.get(workspace=ws, user__email='ann@example.com').role, 'viewer')

    def test_a_deleted_workspace_does_not_block_the_invitation(self):
        ws = Workspace.objects.create(name='Lab', kind=Workspace.TEAM)
        _, raw = invitations.create('ann@example.com', self.admin, workspace=ws, role='editor')
        ws.delete()
        self.assertEqual(register('ann@example.com', raw).status_code, 201)

    def test_workspace_invitation_still_opens_the_door(self):
        lab = Workspace.objects.create(name='Lab')
        WorkspaceInvite.objects.create(workspace=lab, email='guest@example.com', role=Membership.VIEWER)
        self.assertEqual(register('guest@example.com').status_code, 201)

    @override_settings(WORKSPACE_INVITES_ALLOW_SIGNUP=False)
    def test_workspace_invitation_can_be_switched_off(self):
        lab = Workspace.objects.create(name='Lab')
        WorkspaceInvite.objects.create(workspace=lab, email='guest@example.com', role=Membership.VIEWER)
        self.assertGeneric(register('guest@example.com'))
        _, raw = invitations.create('other@example.com', self.admin)
        self.assertEqual(register('other@example.com', raw).status_code, 201)

    def test_nothing_reveals_which_addresses_are_invited_or_registered(self):
        invitations.create('invited@example.com', self.admin)
        bodies = {register(e).data['error'] for e in ('invited@example.com', 'root@example.com', 'nobody@example.com')}
        self.assertEqual(len(bodies), 1)

    def test_attempts_are_limited_per_address_and_per_token(self):
        for _ in range(10):
            self.assertEqual(register('victim@example.com').status_code, 400)
        self.assertEqual(register('victim@example.com').status_code, 429)
        cache.clear()
        for i in range(10):
            self.assertEqual(register(f'guess{i}@example.com', 'pi1.guess').status_code, 400)
        self.assertEqual(register('guess99@example.com', 'pi1.guess').status_code, 429)

    def test_a_failure_after_the_account_is_created_leaves_the_invitation_usable(self):
        from unittest import mock
        _, raw = invitations.create('ann@example.com', self.admin)
        with mock.patch('accounts.verification.mark_verified', side_effect=RuntimeError('boom')):
            with self.assertRaises(RuntimeError):
                register('ann@example.com', raw, client=APIClient(raise_request_exception=True))
        self.assertFalse(User.objects.filter(email='ann@example.com').exists())
        self.assertIsNone(PlatformInvite.objects.get(email='ann@example.com').used_at)
        self.assertEqual(register('ann@example.com', raw).status_code, 201)

    def test_existing_accounts_still_sign_in(self):
        res = APIClient().post('/api/auth/login', {'email': 'root@example.com', 'password': PASSWORD}, format='json')
        self.assertEqual(res.status_code, 200)

    @override_settings(REGISTRATION_MODE='open')
    def test_open_mode_is_unchanged(self):
        cache.clear()
        self.assertEqual(register('anyone@example.com').status_code, 201)
        self.assertIn('already exists', register('anyone@example.com').data['error'])


@override_settings(REGISTRATION_MODE='invite')
class ConcurrentUseTests(TransactionTestCase):
    def test_one_link_cannot_create_two_accounts(self):
        cache.clear()
        admin = User.objects.create_user('root@example.com', PASSWORD, is_staff=True, is_superuser=True)
        _, raw = invitations.create('ann@example.com', admin)
        results = []
        barrier = threading.Barrier(2)

        def go(n):
            try:
                barrier.wait(5)
                results.append(register('ann@example.com', raw).status_code)
            finally:
                connection.close()

        threads = [threading.Thread(target=go, args=(i,)) for i in range(2)]
        [t.start() for t in threads]
        [t.join(20) for t in threads]
        self.assertEqual(sorted(results)[0], 201, results)
        self.assertEqual(User.objects.filter(email='ann@example.com').count(), 1)
        self.assertEqual(PlatformInvite.objects.filter(used_at__isnull=False).count(), 1)
