from unittest.mock import patch

from allauth.mfa.models import Authenticator
from allauth.mfa.totp.internal import auth as totp
from django.core import mail as outbox
from django.core.cache import cache
from django.test import TestCase
from rest_framework.test import APIClient

from accounts import mfa
from accounts.models import User

PASSWORD = 'correct-horse-battery'


def code(secret, offset=0):
    """The TOTP code `offset` periods from now (the server accepts -1..1, each code once)."""
    counter = next(totp.yield_hotp_counters_from_time()) + totp.app_settings.TOTP_TOLERANCE + offset
    return totp.format_hotp_value(totp.hotp_value(secret, counter))


class MfaTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(email='ann@example.com', password=PASSWORD)
        self.client = APIClient()
        res = self.client.post('/api/auth/login', {'email': 'ann@example.com', 'password': PASSWORD}, format='json')
        self.old_refresh = res.cookies['openprism_refresh'].value
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")

    def enrol(self, offset=0):
        setup = self.client.post('/api/auth/mfa/totp/setup', {'password': PASSWORD}, format='json')
        res = self.client.post('/api/auth/mfa/totp/enable', {'setup': setup.data['setup'], 'code': code(setup.data['secret'], offset)}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        return setup.data['secret'], res.data['recoveryCodes']

    def password_login(self):
        return APIClient().post('/api/auth/login', {'email': 'ann@example.com', 'password': PASSWORD}, format='json')

    def test_setup_needs_the_password_and_enable_needs_a_right_code(self):
        self.assertEqual(self.client.post('/api/auth/mfa/totp/setup', {'password': 'nope'}, format='json').status_code, 400)
        setup = self.client.post('/api/auth/mfa/totp/setup', {'password': PASSWORD}, format='json')
        self.assertIn('<svg', setup.data['qrSvg'])
        self.assertIn('otpauth://totp/OpenPrism:ann%40example.com?secret=' + setup.data['secret'], setup.data['uri'])
        self.assertFalse(mfa.enabled(self.user))  # setup stores nothing
        bad = self.client.post('/api/auth/mfa/totp/enable', {'setup': setup.data['setup'], 'code': '000000'}, format='json')
        self.assertEqual(bad.status_code, 400)
        self.assertFalse(mfa.enabled(self.user))

    def test_a_setup_made_for_someone_else_is_refused(self):
        other = User.objects.create_user(email='bob@example.com', password=PASSWORD)
        setup = self.client.post('/api/auth/mfa/totp/setup', {'password': PASSWORD}, format='json')
        mine = APIClient()
        mine.force_authenticate(other)
        res = mine.post('/api/auth/mfa/totp/enable', {'setup': setup.data['setup'], 'code': code(setup.data['secret'])}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertFalse(mfa.enabled(other))

    def test_enabling_returns_recovery_codes_mails_and_signs_other_browsers_out(self):
        with self.captureOnCommitCallbacks(execute=True):
            secret, codes = self.enrol()
        self.assertEqual(len(codes), 10)
        self.assertTrue(self.client.get('/api/auth/me').data['user']['mfaEnabled'])
        self.assertEqual(self.client.get('/api/auth/mfa').data, {'ok': True, 'enabled': True, 'recoveryCodesLeft': 10})
        self.assertIn('turned on', outbox.outbox[-1].subject)
        old = APIClient().post('/api/auth/refresh', {'refresh': self.old_refresh}, format='json')
        self.assertEqual(old.status_code, 401)  # the refresh token from before cannot skip the new step

    def test_password_alone_gets_no_tokens_and_the_code_completes_sign_in(self):
        secret, _ = self.enrol()
        res = self.password_login()
        self.assertEqual((res.status_code, res.data['mfaRequired']), (200, True))
        self.assertNotIn('access', res.data)
        self.assertNotIn('openprism_refresh', res.cookies)
        client = APIClient()
        done = client.post('/api/auth/login/mfa', {'ticket': res.data['ticket'], 'code': code(secret, 1)}, format='json')
        self.assertEqual(done.status_code, 200, done.data)
        self.assertIn('openprism_refresh', done.cookies)
        self.assertNotIn('refresh', done.data)
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {done.data['access']}")
        self.assertEqual(client.get('/api/auth/me').status_code, 200)

    def test_a_used_code_and_a_used_ticket_do_not_work_again(self):
        secret, _ = self.enrol(offset=0)  # spends the code for this period
        first = self.password_login().data['ticket']
        self.assertEqual(APIClient().post('/api/auth/login/mfa', {'ticket': first, 'code': code(secret, 0)}, format='json').status_code, 400)
        ok = APIClient().post('/api/auth/login/mfa', {'ticket': first, 'code': code(secret, 1)}, format='json')
        self.assertEqual(ok.status_code, 200)
        again = APIClient().post('/api/auth/login/mfa', {'ticket': first, 'code': code(secret, -1)}, format='json')
        self.assertEqual(again.status_code, 400)
        self.assertIn('expired', again.data['error'])

    def test_a_recovery_code_works_once(self):
        _, codes = self.enrol()
        res = APIClient().post('/api/auth/login/mfa', {'ticket': self.password_login().data['ticket'], 'code': codes[0]}, format='json')
        self.assertEqual(res.status_code, 200)
        again = APIClient().post('/api/auth/login/mfa', {'ticket': self.password_login().data['ticket'], 'code': codes[0]}, format='json')
        self.assertEqual(again.status_code, 400)
        self.assertEqual(self.client.get('/api/auth/mfa').data['recoveryCodesLeft'], 9)

    def test_a_ticket_survives_only_a_few_wrong_codes_and_expires(self):
        secret, _ = self.enrol()
        ticket = self.password_login().data['ticket']
        for _ in range(mfa.TICKET_ATTEMPTS):
            self.assertEqual(APIClient().post('/api/auth/login/mfa', {'ticket': ticket, 'code': '111111'}, format='json').status_code, 400)
        res = APIClient().post('/api/auth/login/mfa', {'ticket': ticket, 'code': code(secret, 1)}, format='json')
        self.assertEqual(res.status_code, 400)  # even the right code: this sign-in is over
        fresh = self.password_login().data['ticket']
        with patch.object(mfa, 'TICKET_SECONDS', -1):
            self.assertEqual(APIClient().post('/api/auth/login/mfa', {'ticket': fresh, 'code': code(secret, 1)}, format='json').status_code, 400)
        self.assertEqual(APIClient().post('/api/auth/login/mfa', {'ticket': 'garbage', 'code': '1'}, format='json').status_code, 400)

    def test_guessing_across_tickets_locks_the_account(self):
        self.enrol()
        for _ in range(mfa.ADDRESS_ATTEMPTS):
            APIClient().post('/api/auth/login/mfa', {'ticket': self.password_login().data['ticket'], 'code': '111111'}, format='json')
        res = APIClient().post('/api/auth/login/mfa', {'ticket': self.password_login().data['ticket'], 'code': '111111'}, format='json')
        self.assertEqual(res.status_code, 429)

    def test_a_ticket_for_a_deactivated_account_is_refused(self):
        secret, _ = self.enrol()
        ticket = self.password_login().data['ticket']
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        self.assertEqual(APIClient().post('/api/auth/login/mfa', {'ticket': ticket, 'code': code(secret, 1)}, format='json').status_code, 400)

    def test_regenerating_replaces_the_recovery_codes(self):
        secret, codes = self.enrol()
        self.assertEqual(self.client.post('/api/auth/mfa/recovery-codes', {'password': PASSWORD, 'code': '000000'}, format='json').status_code, 400)
        res = self.client.post('/api/auth/mfa/recovery-codes', {'password': PASSWORD, 'code': code(secret, 1)}, format='json')
        self.assertEqual(res.status_code, 200)
        self.assertNotEqual(res.data['recoveryCodes'], codes)
        old = APIClient().post('/api/auth/login/mfa', {'ticket': self.password_login().data['ticket'], 'code': codes[0]}, format='json')
        self.assertEqual(old.status_code, 400)

    def test_disabling_needs_password_and_a_code_and_restores_plain_login(self):
        secret, codes = self.enrol()
        self.assertEqual(self.client.post('/api/auth/mfa/disable', {'password': 'nope', 'code': code(secret, 1)}, format='json').status_code, 400)
        self.assertEqual(self.client.post('/api/auth/mfa/disable', {'password': PASSWORD, 'code': '000000'}, format='json').status_code, 400)
        self.assertTrue(mfa.enabled(self.user))
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post('/api/auth/mfa/disable', {'password': PASSWORD, 'code': codes[0]}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertFalse(Authenticator.objects.filter(user=self.user).exists())
        self.assertIn('access', self.password_login().data)
        self.assertIn('turned off', outbox.outbox[-1].subject)

    def test_secrets_are_not_stored_in_the_clear(self):
        secret, _ = self.enrol()
        self.assertNotIn(secret, str(Authenticator.objects.get(user=self.user, type='totp').data))
