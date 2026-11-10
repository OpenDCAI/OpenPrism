from django.core import mail as outbox
from django.core.cache import cache
from django.test import TestCase
from rest_framework.test import APIClient

from accounts import passkeys
from accounts.models import User
from accounts.softkey import SoftKey
from accounts.test_mfa import code as totp_code
from allauth.mfa.totp.internal import auth as totp

PASSWORD = 'correct-horse-battery'


class PasskeyTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user('ann@example.com', PASSWORD)
        self.client = APIClient()
        res = self.client.post('/api/auth/login', {'email': 'ann@example.com', 'password': PASSWORD}, format='json')
        self.refresh = res.cookies['openprism_refresh'].value
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        self.key = SoftKey()

    def add(self, key=None, name='Laptop'):
        key = key or self.key
        opts = self.client.post('/api/auth/passkeys/options', {'password': PASSWORD}, format='json')
        self.assertEqual(opts.status_code, 200, opts.data)
        return self.client.post('/api/auth/passkeys', {'state': opts.data['state'], 'credential': key.create(opts.data['options']), 'name': name}, format='json')

    def sign_in(self, key=None, **kw):
        anon = APIClient()
        opts = anon.post('/api/auth/passkeys/login/options', format='json')
        res = anon.post('/api/auth/passkeys/login', {'state': opts.data['state'], 'credential': (key or self.key).get(opts.data['options'], **kw)}, format='json')
        return anon, res, opts

    def test_register_list_rename_and_remove(self):
        with self.captureOnCommitCallbacks(execute=True):
            res = self.add()
        self.assertEqual(res.status_code, 201, res.data)
        self.assertIn('passkey was just added', outbox.outbox[-1].body)
        listed = self.client.get('/api/auth/passkeys').data['passkeys']
        self.assertEqual([p['name'] for p in listed], ['Laptop'])
        pid = listed[0]['id']
        self.assertEqual(self.client.patch(f'/api/auth/passkeys/{pid}', {'name': '  Work   laptop '}, format='json').data['passkey']['name'], 'Work laptop')
        self.assertEqual(self.client.delete(f'/api/auth/passkeys/{pid}', {'password': 'nope'}, format='json').status_code, 400)
        res = self.client.delete(f'/api/auth/passkeys/{pid}', {'password': PASSWORD}, format='json')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(self.client.get('/api/auth/passkeys').data['passkeys'], [])
        self.assertEqual(APIClient().post('/api/auth/refresh', {'refresh': self.refresh}, format='json').status_code, 401)

    def test_sign_in_needs_no_password_and_sets_no_django_session(self):
        self.add()
        anon, res, _ = self.sign_in()
        self.assertEqual(res.status_code, 200, res.data)
        self.assertIn('access', res.data)
        self.assertIn('openprism_refresh', res.cookies)
        self.assertNotIn('openprism_admin', res.cookies)
        anon.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        self.assertEqual(anon.get('/api/auth/me').data['user']['email'], 'ann@example.com')
        self.assertTrue(self.client.get('/api/auth/passkeys').data['passkeys'][0]['lastUsedAt'])

    def test_a_passkey_skips_the_totp_step(self):
        secret = totp.generate_totp_secret()
        totp.TOTP.activate(self.user, secret)
        self.add()
        self.assertEqual(self.sign_in()[1].status_code, 200)

    def test_replayed_wrong_and_unknown_assertions_are_refused(self):
        self.add()
        anon, res, opts = self.sign_in()
        again = anon.post('/api/auth/passkeys/login', {'state': opts.data['state'], 'credential': self.key.get(opts.data['options'])}, format='json')
        self.assertEqual(again.status_code, 400)                      # the state works once
        self.assertEqual(self.sign_in(SoftKey())[1].status_code, 400)  # a key that was never registered (no user handle)
        stranger = SoftKey()
        stranger.user_handle = self.key.user_handle                    # claims to be ann, different key
        self.assertEqual(self.sign_in(stranger)[1].status_code, 400)
        self.assertEqual(self.sign_in(user_handle=False)[1].status_code, 400)
        self.assertEqual(APIClient().post('/api/auth/passkeys/login', {'state': 'x', 'credential': {}}, format='json').status_code, 400)

    def test_a_wrong_origin_is_refused_and_so_is_a_deactivated_account(self):
        self.add()
        self.assertEqual(self.sign_in(SoftKey(origin='https://evil.example'))[1].status_code, 400)
        self.key.origin = 'http://localhost:5173'
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        self.assertEqual(self.sign_in()[1].status_code, 400)

    def test_registration_needs_the_password_and_a_state_made_for_you(self):
        self.assertEqual(self.client.post('/api/auth/passkeys/options', {'password': 'nope'}, format='json').status_code, 400)
        opts = self.client.post('/api/auth/passkeys/options', {'password': PASSWORD}, format='json')
        credential = self.key.create(opts.data['options'])
        other = User.objects.create_user('bob@example.com', PASSWORD)
        theirs = APIClient()
        theirs.force_authenticate(other)
        res = theirs.post('/api/auth/passkeys', {'state': opts.data['state'], 'credential': credential, 'name': 'x'}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self.client.post('/api/auth/passkeys', {'state': opts.data['state'], 'credential': credential}, format='json').status_code, 400)  # already spent

    def test_a_non_discoverable_credential_is_refused(self):
        opts = self.client.post('/api/auth/passkeys/options', {'password': PASSWORD}, format='json')
        credential = self.key.create(opts.data['options'])
        credential['clientExtensionResults'] = {'credProps': {'rk': False}}
        self.assertEqual(self.client.post('/api/auth/passkeys', {'state': opts.data['state'], 'credential': credential}, format='json').status_code, 400)

    def test_removing_someone_elses_passkey_finds_nothing(self):
        self.add()
        other = User.objects.create_user('bob@example.com', PASSWORD)
        theirs = APIClient()
        theirs.force_authenticate(other)
        pid = self.client.get('/api/auth/passkeys').data['passkeys'][0]['id']
        self.assertEqual(theirs.delete(f'/api/auth/passkeys/{pid}', {'password': PASSWORD}, format='json').status_code, 404)
        self.assertEqual(theirs.patch(f'/api/auth/passkeys/{pid}', {'name': 'x'}, format='json').status_code, 404)

    def test_turning_the_code_factor_off_keeps_the_passkeys(self):
        from accounts import mfa
        totp.TOTP.activate(self.user, totp.generate_totp_secret())
        self.add()
        mfa.remove(self.user)
        self.assertFalse(mfa.enabled(self.user))
        self.assertEqual(len(self.client.get('/api/auth/passkeys').data['passkeys']), 1)
