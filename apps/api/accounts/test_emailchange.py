import re
from unittest.mock import patch

from allauth.account.models import EmailAddress
from django.core import mail as outbox
from django.core.cache import cache
from django.test import TestCase
from rest_framework.test import APIClient

from accounts import emailchange
from accounts.models import User
from projects.models import Membership, Workspace, WorkspaceInvite

PASSWORD = 'correct-horse-battery'


class EmailChangeTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user('ann@example.com', PASSWORD, name='Ann')
        self.client = APIClient()
        res = self.client.post('/api/auth/login', {'email': 'ann@example.com', 'password': PASSWORD}, format='json')
        self.refresh = res.cookies['openprism_refresh'].value
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")

    def ask(self, email='new@example.com', password=PASSWORD):
        with self.captureOnCommitCallbacks(execute=True):
            return self.client.post('/api/auth/email/change', {'email': email, 'password': password}, format='json')

    def token(self):
        mail = next(m for m in reversed(outbox.outbox) if m.to == ['new@example.com'])
        return re.search(r'/confirm-email\?token=(\S+)', mail.body).group(1)

    def test_asking_mails_both_addresses_and_changes_nothing_yet(self):
        res = self.ask()
        self.assertEqual(res.data['pending'], 'new@example.com')
        self.assertEqual(sorted(tuple(m.to) for m in outbox.outbox), [('ann@example.com',), ('new@example.com',)])
        self.assertEqual(User.objects.get(pk=self.user.pk).email, 'ann@example.com')
        self.assertEqual(self.client.get('/api/auth/email').data, {'ok': True, 'email': 'ann@example.com', 'pending': 'new@example.com'})

    def test_confirming_swaps_the_address_signs_everyone_out_and_tells_the_old_one(self):
        self.ask()
        res = APIClient().post('/api/auth/email/confirm', {'token': self.token()}, format='json')
        self.assertEqual(res.data, {'ok': True, 'email': 'new@example.com'})
        user = User.objects.get(pk=self.user.pk)
        self.assertEqual(user.email, 'new@example.com')
        self.assertIsNotNone(user.email_verified_at)
        self.assertEqual(list(EmailAddress.objects.filter(user=user).values_list('email', 'primary', 'verified')), [('new@example.com', True, True)])
        self.assertEqual(APIClient().post('/api/auth/login', {'email': 'ann@example.com', 'password': PASSWORD}, format='json').status_code, 401)
        self.assertEqual(APIClient().post('/api/auth/login', {'email': 'new@example.com', 'password': PASSWORD}, format='json').status_code, 200)
        self.assertEqual(APIClient().post('/api/auth/refresh', {'refresh': self.refresh}, format='json').status_code, 401)
        self.assertEqual(outbox.outbox[-1].to, ['ann@example.com'])
        self.assertIn('was changed', outbox.outbox[-1].subject)

    def test_a_link_works_once_and_dies_when_things_change(self):
        self.ask()
        token = self.token()
        APIClient().post('/api/auth/email/confirm', {'token': token}, format='json')
        self.assertEqual(APIClient().post('/api/auth/email/confirm', {'token': token}, format='json').status_code, 400)
        for bad in ('', 'garbage', token[:-2] + 'xx'):
            self.assertEqual(APIClient().post('/api/auth/email/confirm', {'token': bad}, format='json').status_code, 400)

    def test_an_expired_or_cancelled_or_replaced_link_changes_nothing(self):
        self.ask()
        old = self.token()
        with patch.object(emailchange, 'MAX_AGE', -1):
            self.assertEqual(APIClient().post('/api/auth/email/confirm', {'token': old}, format='json').status_code, 400)
        self.client.delete('/api/auth/email')
        self.assertEqual(APIClient().post('/api/auth/email/confirm', {'token': old}, format='json').status_code, 400)
        self.assertEqual(self.client.get('/api/auth/email').data['pending'], None)
        self.ask('other@example.com')
        self.assertEqual(APIClient().post('/api/auth/email/confirm', {'token': old}, format='json').status_code, 400)
        self.assertEqual(User.objects.get(pk=self.user.pk).email, 'ann@example.com')

    def test_refusals(self):
        self.assertEqual(self.ask(password='nope').status_code, 400)
        self.assertEqual(self.ask(email='not-an-address').status_code, 400)
        self.assertEqual(self.ask(email='ann@example.com').status_code, 400)
        User.objects.create_user('bob@example.com', PASSWORD)
        self.assertIn('already exists', self.ask(email='BOB@example.com').data['error'])
        self.assertEqual(len(outbox.outbox), 0)

    def test_a_taken_address_is_refused_even_if_taken_after_asking(self):
        self.ask()
        token = self.token()
        User.objects.create_user('new@example.com', PASSWORD)
        self.assertEqual(APIClient().post('/api/auth/email/confirm', {'token': token}, format='json').status_code, 400)
        self.assertEqual(User.objects.get(pk=self.user.pk).email, 'ann@example.com')

    def test_waiting_workspace_invitations_are_accepted_for_the_new_address(self):
        lab = Workspace.objects.create(name='Lab')
        WorkspaceInvite.objects.create(workspace=lab, email='new@example.com', role=Membership.EDITOR)
        self.ask()
        APIClient().post('/api/auth/email/confirm', {'token': self.token()}, format='json')
        self.assertTrue(Membership.objects.filter(workspace=lab, user=self.user, role=Membership.EDITOR).exists())
