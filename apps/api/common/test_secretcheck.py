import base64
import os
import subprocess
import sys
from pathlib import Path

from django.test import SimpleTestCase

from common import secretcheck

GOOD_SECRET = 'q7Lk2mXv9RtYw4Pz8NbC3dFh6JgS1aEu5oIxVn0TrMc'
GOOD_FERNET = base64.urlsafe_b64encode(os.urandom(32)).decode()


class SecretCheckTests(SimpleTestCase):
    def test_good_values_pass(self):
        self.assertEqual(secretcheck.problems(GOOD_SECRET, GOOD_FERNET), [])

    def test_every_shipped_placeholder_is_refused(self):
        for p in secretcheck.KNOWN_PLACEHOLDERS:
            with self.subTest(p=p):
                self.assertTrue(secretcheck.problems(p, GOOD_FERNET) or secretcheck.problems(GOOD_SECRET, p))

    def test_weak_or_missing_values_are_refused(self):
        self.assertTrue(secretcheck.problems('short', GOOD_FERNET))
        self.assertTrue(secretcheck.problems('a' * 64, GOOD_FERNET))          # no variety
        self.assertTrue(secretcheck.problems('', GOOD_FERNET))
        self.assertTrue(secretcheck.problems(GOOD_SECRET, ''))
        self.assertTrue(secretcheck.problems(GOOD_SECRET, 'not-base64-and-not-32-bytes'))

    def test_every_key_in_a_rotation_list_is_checked(self):
        self.assertEqual(secretcheck.problems(GOOD_SECRET, f'{GOOD_FERNET},{GOOD_FERNET}'), [])
        bad = secretcheck.problems(GOOD_SECRET, f'{GOOD_FERNET},b3BlbnByaXNtLWRldi1rZXktbm90LXNlY3JldC0wMTI=')
        self.assertEqual(len(bad), 1)
        self.assertIn('#2', bad[0])

    def test_messages_never_contain_the_secret(self):
        secret = 'dev-insecure-change-me'
        self.assertNotIn(secret, ' '.join(secretcheck.problems(secret, GOOD_FERNET)))

    def test_the_script_exits_non_zero_on_placeholders_and_zero_on_good_values(self):
        script = Path(secretcheck.__file__)
        env = {'PATH': os.environ.get('PATH', '')}
        bad = subprocess.run([sys.executable, str(script)], env={**env, 'DJANGO_SECRET_KEY': 'dev-insecure-change-me',
                             'CREDENTIAL_ENCRYPTION_KEY': GOOD_FERNET}, capture_output=True, text=True)
        self.assertEqual(bad.returncode, 1)
        self.assertNotIn('dev-insecure-change-me', bad.stdout + bad.stderr.replace('DJANGO_SECRET_KEY', ''))
        good = subprocess.run([sys.executable, str(script)], env={**env, 'DJANGO_SECRET_KEY': GOOD_SECRET,
                              'CREDENTIAL_ENCRYPTION_KEY': GOOD_FERNET}, capture_output=True, text=True)
        self.assertEqual(good.returncode, 0, good.stdout)
