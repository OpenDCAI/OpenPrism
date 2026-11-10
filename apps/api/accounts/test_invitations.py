"""Platform invitations (v0.1.2, #83)."""
import re
from datetime import timedelta
from unittest import mock

from django.core import mail as djmail
from django.test import TestCase, override_settings
from django.utils import timezone

from accounts import invitations
from accounts.models import PlatformInvite, User
from projects.models import Membership, Workspace


def link_token():
    body = djmail.outbox[-1].body
    return re.search(r'invite=(pi1\.[\w\-]+)', body).group(1)


class InvitationTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user('root@example.com', 'pw-Strong-123', name='Root', is_staff=True, is_superuser=True)
        djmail.outbox.clear()

    def test_create_stores_only_the_hash_and_mails_a_working_link(self):
        with self.captureOnCommitCallbacks(execute=True):
            invite, raw = invitations.create('New@Example.com', self.admin)
        self.assertEqual(invite.email, 'new@example.com')
        self.assertTrue(raw.startswith('pi1.'))
        self.assertNotIn(raw, invite.token_hash)
        self.assertFalse(PlatformInvite.objects.filter(token_hash=raw).exists())
        self.assertEqual(len(djmail.outbox), 1)
        self.assertEqual(djmail.outbox[0].to, ['new@example.com'])
        self.assertEqual(link_token(), raw)
        self.assertIn('email=new%40example.com', djmail.outbox[0].body)
        self.assertEqual(invitations.find_valid('new@example.com', raw), invite)
        self.assertEqual(invitations.status(invite), 'sent')

    def test_valid_for_its_own_address_only(self):
        _, raw = invitations.create('a@example.com', self.admin)
        self.assertIsNone(invitations.find_valid('b@example.com', raw))
        self.assertIsNone(invitations.find_valid('a@example.com', raw + 'x'))
        self.assertIsNone(invitations.find_valid('a@example.com', ''))
        self.assertIsNone(invitations.find_valid('a@example.com', None))
        self.assertIsNotNone(invitations.find_valid('A@example.com ', raw))

    def test_expires_after_seven_days_by_default(self):
        invite, raw = invitations.create('a@example.com', self.admin)
        self.assertAlmostEqual((invite.expires_at - timezone.now()).total_seconds(), 7 * 86400, delta=60)
        with mock.patch('django.utils.timezone.now', return_value=timezone.now() + timedelta(days=7, minutes=1)):
            self.assertIsNone(invitations.find_valid('a@example.com', raw))
            self.assertEqual(invitations.status(invite), 'expired')

    @override_settings(PLATFORM_INVITE_DAYS=2)
    def test_lifetime_is_configurable(self):
        invite, _ = invitations.create('a@example.com', self.admin)
        self.assertAlmostEqual((invite.expires_at - timezone.now()).total_seconds(), 2 * 86400, delta=60)

    def test_a_second_invitation_replaces_the_first(self):
        first, raw1 = invitations.create('a@example.com', self.admin)
        second, raw2 = invitations.create('a@example.com', self.admin)
        self.assertIsNone(invitations.find_valid('a@example.com', raw1))
        self.assertEqual(invitations.find_valid('a@example.com', raw2), second)
        first.refresh_from_db()
        self.assertEqual(invitations.status(first), 'revoked')

    def test_resend_rotates_the_link_and_extends_the_expiry(self):
        invite, raw1 = invitations.create('a@example.com', self.admin)
        PlatformInvite.objects.filter(pk=invite.pk).update(expires_at=timezone.now() + timedelta(hours=1), send_failed=True)
        djmail.outbox.clear()
        with self.captureOnCommitCallbacks(execute=True):
            raw2 = invitations.resend(invite)
        self.assertIsNone(invitations.find_valid('a@example.com', raw1))
        self.assertIsNotNone(invitations.find_valid('a@example.com', raw2))
        invite.refresh_from_db()
        self.assertGreater(invite.expires_at, timezone.now() + timedelta(days=6))
        self.assertFalse(invite.send_failed)  # cleared by the mail going out
        self.assertEqual(link_token(), raw2)

    def test_revoke_and_used(self):
        invite, raw = invitations.create('a@example.com', self.admin)
        invitations.revoke(invite)
        self.assertIsNone(invitations.find_valid('a@example.com', raw))
        self.assertEqual(invitations.status(invite), 'revoked')
        # a revoked invitation can be sent again
        raw2 = invitations.resend(invite)
        self.assertIsNotNone(invitations.find_valid('a@example.com', raw2))
        PlatformInvite.objects.filter(pk=invite.pk).update(used_at=timezone.now())
        invite.refresh_from_db()
        self.assertEqual(invitations.status(invite), 'used')
        self.assertIsNone(invitations.find_valid('a@example.com', raw2))
        with self.assertRaises(invitations.InviteError):
            invitations.resend(invite)
        with self.assertRaises(invitations.InviteError):
            invitations.revoke(invite)

    def test_existing_account_and_bad_addresses_are_refused(self):
        with self.assertRaisesMessage(invitations.InviteError, 'already has an account'):
            invitations.create('ROOT@example.com', self.admin)
        with self.assertRaisesMessage(invitations.InviteError, 'not an email address'):
            invitations.create('nope', self.admin)

    def test_workspace_and_role(self):
        ws = Workspace.objects.create(name='Lab', kind=Workspace.TEAM)
        invite, _ = invitations.create('a@example.com', self.admin, workspace=ws, role='viewer')
        self.assertEqual((invite.workspace, invite.role), (ws, 'viewer'))
        with self.assertRaisesMessage(invitations.InviteError, 'role'):
            invitations.create('b@example.com', self.admin, workspace=ws, role='owner')
        invite, _ = invitations.create('c@example.com', self.admin, workspace=ws)
        self.assertEqual(invite.role, Membership.EDITOR)
        invite, _ = invitations.create('d@example.com', self.admin, role='admin')  # no workspace: role is meaningless
        self.assertEqual(invite.role, '')

    def test_mail_failure_is_recorded_and_cleared_by_a_later_success(self):
        import smtplib
        from accounts import tasks
        with self.captureOnCommitCallbacks(execute=False):
            invite, _ = invitations.create('a@example.com', self.admin)
        tasks.send_email.push_request(retries=5)  # the last attempt
        try:
            with mock.patch('accounts.mail.deliver', side_effect=smtplib.SMTPException('down')):
                with self.assertRaises(smtplib.SMTPException):
                    tasks.send_email.run('a@example.com', 'platform_invite', {}, None, invite.pk)
        finally:
            tasks.send_email.pop_request()
        invite.refresh_from_db()
        self.assertTrue(invite.send_failed)
        self.assertEqual(invitations.status(invite), 'mail_failed')
        with mock.patch('accounts.mail.deliver'):
            tasks.send_email.run('a@example.com', 'platform_invite', {}, None, invite.pk)
        invite.refresh_from_db()
        self.assertFalse(invite.send_failed)
