from datetime import timedelta

from django.core.cache import cache
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from accounts import signins
from accounts.models import LinkedIdentity, SignInEvent, User
from accounts.softkey import SoftKey
from accounts.test_mfa import code as totp_code
from allauth.mfa.totp.internal import auth as totp

PASSWORD = 'correct-horse-battery'


def passwordless_client(email='soc@example.com'):
    user = User.objects.create_user(email, None)   # a provider-created account: unusable password
    client = APIClient()
    client.force_authenticate(user)
    return user, client


class PasswordlessAccountTests(TestCase):
    def setUp(self):
        cache.clear()

    def test_the_session_reports_it_and_a_password_can_be_set_without_a_current_one(self):
        user, client = passwordless_client()
        self.assertFalse(client.get('/api/auth/me').data['user']['hasPassword'])
        res = client.post('/api/auth/password/change', {'password': 'a-brand-new-horse-9'}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        user.refresh_from_db()
        self.assertTrue(user.has_usable_password())
        self.assertTrue(client.get('/api/auth/me').data['user']['hasPassword'])
        self.assertEqual(client.post('/api/auth/password/change', {'password': 'another-horse-77'}, format='json').status_code, 400)  # now it needs the current one

    def test_sensitive_steps_ask_for_the_typed_email_instead_of_a_password(self):
        user, client = passwordless_client()
        self.assertEqual(client.post('/api/auth/mfa/totp/setup', {'password': 'whatever'}, format='json').status_code, 400)
        res = client.post('/api/auth/mfa/totp/setup', {'password': ' SOC@example.com '}, format='json')
        self.assertEqual(res.status_code, 200)

    def test_such_an_account_can_delete_itself_by_typing_its_email(self):
        user, client = passwordless_client()
        wrong = client.delete('/api/auth/me', {'password': 'nope'}, format='json')
        self.assertIn('email address', wrong.data['error'])
        self.assertTrue(User.objects.filter(pk=user.pk).exists())
        self.assertEqual(client.delete('/api/auth/me', {'password': user.email}, format='json').status_code, 200)
        self.assertFalse(User.objects.filter(pk=user.pk).exists())

    def test_the_last_passkey_cannot_go_but_two_can_and_a_password_makes_it_free(self):
        user, client = passwordless_client()
        keys = []
        for name in ('One', 'Two'):
            key = SoftKey()
            opts = client.post('/api/auth/passkeys/options', {'password': user.email}, format='json')
            res = client.post('/api/auth/passkeys', {'state': opts.data['state'], 'credential': key.create(opts.data['options']), 'name': name}, format='json')
            self.assertEqual(res.status_code, 201, res.data)
            keys.append(res.data['passkey']['id'])
        self.assertEqual(client.delete(f'/api/auth/passkeys/{keys[0]}', {'password': user.email}, format='json').status_code, 200)
        last = client.delete(f'/api/auth/passkeys/{keys[1]}', {'password': user.email}, format='json')
        self.assertEqual(last.status_code, 400)
        self.assertIn('only way to sign in', last.data['error'])
        client.post('/api/auth/password/change', {'password': 'a-brand-new-horse-9'}, format='json')
        self.assertEqual(client.delete(f'/api/auth/passkeys/{keys[1]}', {'password': 'a-brand-new-horse-9'}, format='json').status_code, 200)

    def test_a_linked_account_counts_as_a_way_in(self):
        user, client = passwordless_client()
        LinkedIdentity.objects.create(user=user, provider='google', subject='a')
        other = LinkedIdentity.objects.create(user=user, provider='orcid', subject='b')
        self.assertEqual(client.delete(f'/api/auth/social/{other.pk}', {'password': user.email}, format='json').status_code, 200)
        last = user.identities.get()
        self.assertEqual(client.delete(f'/api/auth/social/{last.pk}', {'password': user.email}, format='json').status_code, 400)


class SignInHistoryTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user('ann@example.com', PASSWORD)

    def methods(self, user=None):
        return list(SignInEvent.objects.filter(user=user or self.user).order_by('created_at').values_list('method', flat=True))

    def test_each_way_of_signing_in_is_recorded_once_and_a_failure_is_not(self):
        APIClient().post('/api/auth/login', {'email': 'ann@example.com', 'password': 'wrong-wrong'}, format='json')
        self.assertEqual(self.methods(), [])
        APIClient().post('/api/auth/login', {'email': 'ANN@example.com', 'password': PASSWORD}, format='json', HTTP_USER_AGENT='TestBrowser/1')
        self.assertEqual(self.methods(), ['password'])
        secret = totp.generate_totp_secret()
        totp.TOTP.activate(self.user, secret)
        step = APIClient().post('/api/auth/login', {'email': 'ann@example.com', 'password': PASSWORD}, format='json')
        self.assertEqual(self.methods(), ['password'])   # the password step alone is not a sign-in
        APIClient().post('/api/auth/login/mfa', {'ticket': step.data['ticket'], 'code': totp_code(secret)}, format='json')
        self.assertEqual(self.methods(), ['password', 'password+code'])

    def test_a_passkey_sign_in_is_recorded(self):
        client = APIClient()
        client.force_authenticate(self.user)
        key = SoftKey()
        opts = client.post('/api/auth/passkeys/options', {'password': PASSWORD}, format='json')
        client.post('/api/auth/passkeys', {'state': opts.data['state'], 'credential': key.create(opts.data['options']), 'name': 'x'}, format='json')
        anon = APIClient()
        o = anon.post('/api/auth/passkeys/login/options', format='json')
        anon.post('/api/auth/passkeys/login', {'state': o.data['state'], 'credential': key.get(o.data['options'])}, format='json')
        self.assertEqual(self.methods(), ['passkey'])

    def test_the_list_is_the_accounts_own_newest_first_with_the_address_cut_to_its_network(self):
        other = User.objects.create_user('bob@example.com', PASSWORD)
        APIClient().post('/api/auth/login', {'email': 'bob@example.com', 'password': PASSWORD}, format='json')
        for _ in range(25):
            APIClient().post('/api/auth/login', {'email': 'ann@example.com', 'password': PASSWORD}, format='json', REMOTE_ADDR='203.0.113.77')
        client = APIClient()
        client.force_authenticate(self.user)
        rows = client.get('/api/auth/sign-ins').data['signIns']
        self.assertEqual(len(rows), 20)
        self.assertTrue(all(r['network'] == '203.0.113.0/24' for r in rows))
        self.assertEqual(len(self.methods(other)), 1)

    def test_old_entries_are_pruned(self):
        old = SignInEvent.objects.create(user=self.user, method='password')
        SignInEvent.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(days=91))
        fresh = SignInEvent.objects.create(user=self.user, method='password')
        self.assertEqual(signins.prune(), 1)
        self.assertEqual(list(SignInEvent.objects.values_list('pk', flat=True)), [fresh.pk])

    def test_network_of(self):
        self.assertEqual(signins.network_of('2001:db8:1:2:3:4:5:6'), '2001:db8:1::/48')
        self.assertEqual(signins.network_of('garbage'), '')
