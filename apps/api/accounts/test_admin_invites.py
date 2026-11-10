"""Managing platform invitations in the admin (v0.1.2, #85)."""
import re

from django.contrib.admin.models import ADDITION, CHANGE, LogEntry
from django.core import mail as outbox
from django.test import Client, TestCase, override_settings
from django.urls import reverse
from rest_framework.test import APIClient

from accounts import invitations
from accounts.admin import parse_addresses
from accounts.models import PlatformInvite, User
from projects.models import Membership, Workspace

PW = 'correct-horse-battery'


class ParseTests(TestCase):
    def test_lists_csv_and_noise(self):
        self.assertEqual(parse_addresses('Email\n"A@x.org", b@x.org;c@x.org  A@x.org\n\n<d@x.org>'),
                         ['a@x.org', 'b@x.org', 'c@x.org', 'd@x.org'])
        self.assertEqual(parse_addresses(''), [])


class AdminInviteTests(TestCase):
    def setUp(self):
        self.root = User.objects.create_superuser('root@example.com', PW)
        self.client = Client()
        self.client.force_login(self.root)
        self.invite_url = reverse('admin:accounts_platforminvite_invite')
        outbox.outbox.clear()

    def invite(self, emails, **extra):
        with self.captureOnCommitCallbacks(execute=True):
            return self.client.post(self.invite_url, {'emails': emails, **extra})

    def test_invites_a_list_reports_bad_and_duplicate_addresses_and_mails_each(self):
        res = self.invite('a@example.org\nb@example.org, root@example.com, nope, a@example.org')
        self.assertEqual(res.status_code, 200)
        self.assertContains(res, 'already has an account')
        self.assertContains(res, 'not an email address')
        self.assertEqual(sorted(PlatformInvite.objects.values_list('email', flat=True)), ['a@example.org', 'b@example.org'])
        self.assertEqual(sorted(m.to[0] for m in outbox.outbox), ['a@example.org', 'b@example.org'])
        self.assertEqual(LogEntry.objects.filter(action_flag=ADDITION, user=self.root).count(), 2)
        listing = self.client.get(reverse('admin:accounts_platforminvite_changelist'))
        self.assertContains(listing, 'Sent')
        self.assertContains(listing, 'Invite people')

    def test_workspace_and_role_are_applied(self):
        ws = Workspace.objects.create(name='Lab', kind=Workspace.TEAM)
        self.invite('a@example.org', workspace=str(ws.pk), role='viewer')
        invite = PlatformInvite.objects.get()
        self.assertEqual((invite.workspace, invite.role), (ws, 'viewer'))
        self.assertIn('Lab', outbox.outbox[0].body)

    def test_too_many_or_none(self):
        self.assertContains(self.invite(' , ; '), 'Enter at least one email address')
        self.assertContains(self.invite('\n'.join(f'u{i}@example.org' for i in range(201))), 'At most 200')
        self.assertEqual(PlatformInvite.objects.count(), 0)

    def test_resend_and_revoke_actions_change_the_link_and_are_logged(self):
        self.invite('a@example.org')
        old = re.search(r'invite=(pi1\.[\w\-]+)', outbox.outbox[-1].body).group(1)
        invite = PlatformInvite.objects.get()
        url = reverse('admin:accounts_platforminvite_changelist')
        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(url, {'action': 'resend', '_selected_action': [str(invite.pk)]})
        new = re.search(r'invite=(pi1\.[\w\-]+)', outbox.outbox[-1].body).group(1)
        self.assertNotEqual(old, new)
        self.assertIsNone(invitations.find_valid('a@example.org', old))
        self.assertIsNotNone(invitations.find_valid('a@example.org', new))
        self.client.post(url, {'action': 'revoke', '_selected_action': [str(invite.pk)]})
        self.assertIsNone(invitations.find_valid('a@example.org', new))
        self.assertContains(self.client.get(url), 'Revoked')
        self.assertEqual(LogEntry.objects.filter(action_flag=CHANGE, user=self.root).count(), 2)

    @override_settings(REGISTRATION_MODE='invite')
    def test_used_invitations_cannot_be_resent_or_revoked(self):
        invite, raw = invitations.create('a@example.org', self.root)
        self.assertEqual(APIClient().post('/api/auth/register', {'email': 'a@example.org', 'password': PW, 'invite': raw},
                                          format='json').status_code, 201)
        url = reverse('admin:accounts_platforminvite_changelist')
        for action in ('resend', 'revoke'):
            res = self.client.post(url, {'action': action, '_selected_action': [str(invite.pk)]}, follow=True)
            self.assertContains(res, 'already registered')
        self.assertContains(self.client.get(url), 'Used')

    def test_a_mail_that_never_went_out_shows_as_failed(self):
        invite, _ = invitations.create('a@example.org', self.root)
        PlatformInvite.objects.filter(pk=invite.pk).update(send_failed=True)
        self.assertContains(self.client.get(reverse('admin:accounts_platforminvite_changelist')), 'Mail failed')

    def test_invitations_cannot_be_added_edited_or_deleted_directly(self):
        invite, _ = invitations.create('a@example.org', self.root)
        self.assertEqual(self.client.get(reverse('admin:accounts_platforminvite_add')).status_code, 403)
        self.assertEqual(self.client.post(reverse('admin:accounts_platforminvite_change', args=[invite.pk]), {}).status_code, 403)
        self.assertEqual(self.client.post(reverse('admin:accounts_platforminvite_delete', args=[invite.pk]), {'post': 'yes'}).status_code, 403)
        self.assertTrue(PlatformInvite.objects.filter(pk=invite.pk).exists())

    def test_staff_without_superuser_and_anonymous_get_nothing(self):
        staff = User.objects.create_user('staff@example.com', PW, is_staff=True)
        for who in (staff, None):
            c = Client()
            if who:
                c.force_login(who)
            for url in (self.invite_url, reverse('admin:accounts_platforminvite_changelist')):
                res = c.get(url)
                self.assertEqual(res.status_code, 302, (who, url))
                self.assertIn('/admin/login/', res['Location'])
            self.assertEqual(c.post(self.invite_url, {'emails': 'x@example.org'}).status_code, 302)
        self.assertEqual(PlatformInvite.objects.count(), 0)
