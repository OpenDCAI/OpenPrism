"""Rotating CREDENTIAL_ENCRYPTION_KEY and DJANGO_SECRET_KEY (#117): the runbook in deploy/helm/README.md, as tests."""
import base64
import io

from allauth.mfa.models import Authenticator
from django.core import signing
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings

from common import urltokens
from projects.models import Workspace
from projects.test_api import make_user

from . import crypto
from .models import UserCredential, WorkspaceLlmConfig, ZoteroConnection

OLD = base64.urlsafe_b64encode(b'o' * 32).decode()
NEW = base64.urlsafe_b64encode(b'n' * 32).decode()
THIRD = base64.urlsafe_b64encode(b't' * 32).decode()


def run(*args):
    out, err = io.StringIO(), io.StringIO()
    try:
        call_command('reencrypt_credentials', *args, stdout=out, stderr=err)
    finally:
        text = out.getvalue()
    return text


class EncryptionKeyRotationTests(TestCase):
    def setUp(self):
        self.user = make_user('rot@example.com')
        self.ws = Workspace.objects.filter(memberships__user=self.user).first()

    def seed_under(self, key):
        """Rows written while `key` was the only key."""
        with override_settings(CREDENTIAL_ENCRYPTION_KEY=key):
            ZoteroConnection.objects.create(user=self.user, zotero_user_id=1, api_key_encrypted=crypto.encrypt('zot-SECRET'),
                                            last_four='CRET')
            UserCredential.objects.create(user=self.user, profile='llm', api_key_encrypted=crypto.encrypt('user-SECRET'),
                                          last_four='CRET')
            WorkspaceLlmConfig.objects.create(workspace=self.ws, api_key_encrypted=crypto.encrypt('ws-SECRET'),
                                              last_four='CRET')
            mfa_secret = crypto.encrypt('TOTPSECRET').decode()
            Authenticator.objects.create(user=self.user, type=Authenticator.Type.TOTP, data={'secret': mfa_secret})
            Authenticator.objects.create(user=self.user, type=Authenticator.Type.RECOVERY_CODES,
                                         data={'seed': crypto.encrypt('SEED').decode(),
                                               'migrated_codes': [crypto.encrypt('code1').decode()]})

    def plaintexts(self):
        return [crypto.decrypt(ZoteroConnection.objects.get().api_key_encrypted),
                crypto.decrypt(UserCredential.objects.get().api_key_encrypted),
                crypto.decrypt(WorkspaceLlmConfig.objects.get().api_key_encrypted),
                crypto.decrypt(Authenticator.objects.get(type='totp').data['secret'].encode()),
                crypto.decrypt(Authenticator.objects.get(type='recovery_codes').data['seed'].encode())]

    def test_full_rotation_prepend_reencrypt_drop_old_key(self):
        self.seed_under(OLD)
        expected = ['zot-SECRET', 'user-SECRET', 'ws-SECRET', 'TOTPSECRET', 'SEED']

        # Step 1: the new key goes in front. Old values still open; nothing is rewritten yet.
        with override_settings(CREDENTIAL_ENCRYPTION_KEY=f'{NEW},{OLD}'):
            self.assertEqual(self.plaintexts(), expected)
            self.assertFalse(crypto.is_current(bytes(ZoteroConnection.objects.get().api_key_encrypted)))

            # Dry run reports and writes nothing.
            before = bytes(ZoteroConnection.objects.get().api_key_encrypted)
            self.assertIn('would rewrite 6', run())
            self.assertEqual(bytes(ZoteroConnection.objects.get().api_key_encrypted), before)

            # Step 2: re-encrypt.
            self.assertIn('rewrote 6', run('--apply'))
            self.assertEqual(self.plaintexts(), expected)
            self.assertTrue(crypto.is_current(bytes(ZoteroConnection.objects.get().api_key_encrypted)))
            # A second run finds nothing to do.
            self.assertIn('rewrote 0', run('--apply'))

        # Step 3: the old key is dropped. Everything still opens with the new key alone.
        with override_settings(CREDENTIAL_ENCRYPTION_KEY=NEW):
            self.assertEqual(self.plaintexts(), expected)

    def test_dropping_the_old_key_without_reencrypting_is_caught_and_loses_nothing(self):
        self.seed_under(OLD)
        with override_settings(CREDENTIAL_ENCRYPTION_KEY=NEW):
            before = bytes(ZoteroConnection.objects.get().api_key_encrypted)
            with self.assertRaises(CommandError):
                run('--apply')
            self.assertEqual(bytes(ZoteroConnection.objects.get().api_key_encrypted), before)  # left alone
        with override_settings(CREDENTIAL_ENCRYPTION_KEY=f'{NEW},{OLD}'):
            self.assertEqual(self.plaintexts()[0], 'zot-SECRET')                            # still recoverable

    def test_several_generations_of_keys(self):
        self.seed_under(OLD)
        with override_settings(CREDENTIAL_ENCRYPTION_KEY=f'{NEW},{OLD}'):
            run('--apply')
        with override_settings(CREDENTIAL_ENCRYPTION_KEY=f'{THIRD},{NEW}'):
            self.assertIn('rewrote 6', run('--apply'))
        with override_settings(CREDENTIAL_ENCRYPTION_KEY=THIRD):
            self.assertEqual(self.plaintexts()[0], 'zot-SECRET')

    def test_the_command_never_prints_a_secret(self):
        self.seed_under(OLD)
        with override_settings(CREDENTIAL_ENCRYPTION_KEY=f'{NEW},{OLD}'):
            text = run('--apply')
        for s in ('zot-SECRET', 'user-SECRET', 'ws-SECRET', 'TOTPSECRET', 'SEED', 'code1'):
            self.assertNotIn(s, text)

    def test_a_rotated_totp_secret_still_verifies_a_code(self):
        # The second factor must keep working through a rotation (it is the one a person cannot re-enter at once).
        secret = 'JBSWY3DPEHPK3PXP'
        with override_settings(CREDENTIAL_ENCRYPTION_KEY=OLD):
            Authenticator.objects.create(user=self.user, type=Authenticator.Type.TOTP,
                                         data={'secret': crypto.encrypt(secret).decode()})
        with override_settings(CREDENTIAL_ENCRYPTION_KEY=f'{NEW},{OLD}'):
            run('--apply')
        with override_settings(CREDENTIAL_ENCRYPTION_KEY=NEW):
            self.assertEqual(crypto.decrypt(Authenticator.objects.get(type='totp').data['secret'].encode()), secret)


class SecretKeyRotationTests(TestCase):
    """DJANGO_SECRET_KEY: the new key signs, the old one (DJANGO_SECRET_KEY_FALLBACKS) still verifies."""
    OLD_KEY = 'old-secret-key-' + 'x' * 30
    NEW_KEY = 'new-secret-key-' + 'y' * 30

    def test_signed_values_survive_a_rotation_with_the_old_key_as_fallback(self):
        with override_settings(SECRET_KEY=self.OLD_KEY, SECRET_KEY_FALLBACKS=[]):
            token = signing.dumps({'a': 1}, salt='t')
            ticket = signing.TimestampSigner(salt='mfa').sign('7:abc')
        with override_settings(SECRET_KEY=self.NEW_KEY, SECRET_KEY_FALLBACKS=[self.OLD_KEY]):
            self.assertEqual(signing.loads(token, salt='t'), {'a': 1})
            self.assertEqual(signing.TimestampSigner(salt='mfa').unsign(ticket), '7:abc')
        with override_settings(SECRET_KEY=self.NEW_KEY, SECRET_KEY_FALLBACKS=[]):    # fallback removed: old values die
            with self.assertRaises(signing.BadSignature):
                signing.loads(token, salt='t')

    def test_url_tokens_survive_a_rotation_with_the_old_key_as_fallback(self):
        user = make_user('url@example.com')
        with override_settings(SECRET_KEY=self.OLD_KEY, SECRET_KEY_FALLBACKS=[]):
            token, _ = urltokens.mint(user, urltokens.IMPORT)
        with override_settings(SECRET_KEY=self.NEW_KEY, SECRET_KEY_FALLBACKS=[self.OLD_KEY]):
            principal, claims = urltokens.verify(token)
            self.assertEqual(principal.pk, user.pk)
        with override_settings(SECRET_KEY=self.NEW_KEY, SECRET_KEY_FALLBACKS=[]):
            with self.assertRaises(urltokens.InvalidUrlToken):
                urltokens.verify(token)
