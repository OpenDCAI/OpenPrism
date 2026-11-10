import re

from django.core import mail as outbox
from django.core import signing
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from accounts.models import User
from accounts.verification import SALT, make_token
from projects.models import Membership, Workspace, WorkspaceInvite

PASSWORD = 'correct-horse-battery'


class VerificationTests(TestCase):
    def register(self, email='ann@example.com'):
        client = APIClient()
        res = client.post('/api/auth/register', {'email': email, 'password': PASSWORD}, format='json')
        if res.status_code == 201:
            client.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        return client, res

    def link_token(self):
        return re.search(r'/verify-email\?token=(\S+)', outbox.outbox[-1].body).group(1)

    def test_registration_mails_a_link_that_verifies_once(self):
        with self.captureOnCommitCallbacks(execute=True):
            client, res = self.register()
        self.assertFalse(res.data['user']['emailVerified'])
        self.assertEqual(outbox.outbox[-1].subject, 'Confirm your email address for OpenPrism')
        token = self.link_token()
        anon = APIClient()  # the link may be opened in another browser
        self.assertEqual(anon.post('/api/auth/verify-email', {'token': token}, format='json').data, {'ok': True, 'email': 'ann@example.com'})
        self.assertTrue(client.get('/api/auth/me').data['user']['emailVerified'])
        self.assertTrue(anon.post('/api/auth/verify-email', {'token': token}, format='json').data['ok'])  # harmless again

    def test_tampered_expired_and_wrong_address_links_are_refused(self):
        self.register()
        user = User.objects.get(email='ann@example.com')
        good = make_token(user)
        for bad in (good[:-2] + 'xx', 'garbage', '', signing.TimestampSigner(salt=SALT).sign(f'{user.pk}:other@example.com')):
            self.assertEqual(APIClient().post('/api/auth/verify-email', {'token': bad}, format='json').status_code, 400, bad)
        with self.settings(EMAIL_VERIFY_MAX_AGE=-1):
            res = APIClient().post('/api/auth/verify-email', {'token': good}, format='json')
        self.assertIn('expired', res.data['error'])
        self.assertIsNone(User.objects.get(pk=user.pk).email_verified_at)

    def test_resend(self):
        with self.captureOnCommitCallbacks(execute=True):
            client, _ = self.register()
        sent = len(outbox.outbox)
        self.assertEqual(client.post('/api/auth/verify-email/resend').data, {'ok': True})
        self.assertEqual(len(outbox.outbox), sent + 1)
        APIClient().post('/api/auth/verify-email', {'token': self.link_token()}, format='json')
        self.assertTrue(client.post('/api/auth/verify-email/resend').data['alreadyVerified'])

    def test_invitations_wait_for_verification(self):
        owner_client, _ = self.register('owner@example.com')
        lab = Workspace.objects.create(name='Lab')
        Membership.objects.create(workspace=lab, user=User.objects.get(email='owner@example.com'), role=Membership.OWNER)
        WorkspaceInvite.objects.create(workspace=lab, email='new@example.com', role=Membership.EDITOR)
        self.register('new@example.com')
        user = User.objects.get(email='new@example.com')
        self.assertFalse(Membership.objects.filter(workspace=lab, user=user).exists())
        APIClient().post('/api/auth/verify-email', {'token': make_token(user)}, format='json')
        self.assertEqual(Membership.objects.get(workspace=lab, user=user).role, Membership.EDITOR)
        self.assertFalse(WorkspaceInvite.objects.exists())

    @override_settings(REQUIRE_EMAIL_VERIFICATION=True)
    def test_required_verification_gates_everything_but_the_auth_endpoints(self):
        client, _ = self.register()
        refused = client.get('/api/projects')
        self.assertEqual(refused.status_code, 403)
        self.assertIn('Verify your email', refused.data['error'])
        self.assertEqual(client.get('/api/auth/me').status_code, 200)
        self.assertEqual(client.post('/api/auth/verify-email/resend').status_code, 200)
        APIClient().post('/api/auth/verify-email', {'token': make_token(User.objects.get(email='ann@example.com'))}, format='json')
        self.assertEqual(client.get('/api/projects').status_code, 200)

    @override_settings(REGISTRATION_MODE='invite')
    def test_invite_only_registration(self):
        _, res = self.register('stranger@example.com')
        self.assertEqual(res.status_code, 400)
        self.assertIn('invitation is not valid', res.data['error'])
        lab = Workspace.objects.create(name='Lab')
        WorkspaceInvite.objects.create(workspace=lab, email='guest@example.com', role=Membership.VIEWER)
        self.assertEqual(self.register('guest@example.com')[1].status_code, 201)
