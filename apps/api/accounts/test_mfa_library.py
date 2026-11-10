"""Spike (#88): allauth's second-factor code works as a library, with no Django session and with encrypted secrets."""
from allauth.mfa.models import Authenticator
from allauth.mfa.recovery_codes.internal.auth import RecoveryCodes
from allauth.mfa.totp.internal import auth as totp
from allauth.mfa.utils import is_mfa_enabled
from django.test import TestCase

from accounts.models import User


class AllauthAsLibraryTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(email='ann@example.com', password='correct-horse-battery')

    def code_now(self, secret):
        return totp.format_hotp_value(totp.hotp_value(secret, next(totp.yield_hotp_counters_from_time()) + totp.app_settings.TOTP_TOLERANCE))

    def test_totp_without_a_session_and_not_replayable(self):
        self.assertFalse(is_mfa_enabled(self.user))
        secret = totp.generate_totp_secret()
        factor = totp.TOTP.activate(self.user, secret)
        self.assertTrue(is_mfa_enabled(self.user))
        code = self.code_now(secret)
        self.assertTrue(factor.validate_code(code))
        self.assertFalse(factor.validate_code(code))  # the same code twice is refused

    def test_secrets_are_encrypted_at_rest(self):
        secret = totp.generate_totp_secret()
        totp.TOTP.activate(self.user, secret)
        codes = RecoveryCodes.activate(self.user)
        stored = [str(a.data) for a in Authenticator.objects.filter(user=self.user)]
        self.assertTrue(stored)
        for text in stored:
            self.assertNotIn(secret, text)
        seed = codes.instance.data['seed']
        self.assertNotRegex(seed, r'^[0-9a-f]{80}$')

    def test_recovery_codes_work_once(self):
        codes = RecoveryCodes.activate(self.user)
        code = codes.get_unused_codes()[0]
        self.assertTrue(RecoveryCodes(Authenticator.objects.get(user=self.user, type='recovery_codes')).validate_code(code))
        self.assertFalse(RecoveryCodes(Authenticator.objects.get(user=self.user, type='recovery_codes')).validate_code(code))
