"""Superadmins and two-factor authentication in the Django admin (#93)."""
from django.contrib.admin.models import LogEntry
from django.core import mail as outbox
from django.core.cache import cache
from django.test import Client, TestCase, override_settings
from django.urls import reverse
from rest_framework.test import APIClient

from accounts import mfa
from accounts.models import User
from accounts.test_admin import PASSWORD
from accounts.test_mfa import code
from allauth.mfa.totp.internal import auth as totp


def admin_login(client, email, code_=''):
    page = client.get('/admin/login/')
    return client.post('/admin/login/', {'username': email, 'password': PASSWORD, 'code': code_, 'next': '/admin/',
                                         'csrfmiddlewaretoken': page.cookies['csrftoken'].value})


def enrol(user):
    secret = totp.generate_totp_secret()
    totp.TOTP.activate(user, secret)
    return secret


class AdminTwoFactorTests(TestCase):
    def setUp(self):
        cache.clear()
        self.root = User.objects.create_superuser('root@example.com', PASSWORD)

    def test_a_factor_is_asked_for_even_when_it_is_not_required(self):
        secret = enrol(self.root)
        self.assertEqual(admin_login(Client(), 'root@example.com').status_code, 200)         # no code: refused
        self.assertEqual(admin_login(Client(), 'root@example.com', '000000').status_code, 200)
        self.assertEqual(admin_login(Client(), 'root@example.com', code(secret)).status_code, 302)

    @override_settings(SUPERADMIN_REQUIRE_MFA=True)
    def test_a_superadmin_without_a_factor_is_told_to_enrol(self):
        res = admin_login(Client(), 'root@example.com')
        self.assertEqual(res.status_code, 200)
        self.assertContains(res, 'Turn on two-factor authentication in the app')

    @override_settings(SUPERADMIN_REQUIRE_MFA=True)
    def test_with_a_factor_the_code_opens_the_admin_and_a_session_without_one_is_ended(self):
        secret = enrol(self.root)
        client = Client()
        self.assertEqual(admin_login(client, 'root@example.com', code(secret)).status_code, 302)
        self.assertEqual(client.get('/admin/').status_code, 200)
        mfa.remove(self.root)  # e.g. reset by another superadmin while this session is open
        self.assertEqual(client.get('/admin/').status_code, 302)

    def test_a_wrong_code_does_not_say_whether_the_password_was_right(self):
        enrol(self.root)
        res = admin_login(Client(), 'root@example.com', '000000')
        self.assertContains(res, 'Enter the code from your authenticator app')

    def test_a_staff_account_gets_the_ordinary_error_with_or_without_a_code(self):
        User.objects.create_user('staff@example.com', PASSWORD, is_staff=True)
        res = admin_login(Client(), 'staff@example.com', '123456')
        self.assertContains(res, 'correct')
        self.assertNotContains(res, 'authenticator')


class AdminResetTests(TestCase):
    def setUp(self):
        cache.clear()
        self.root = User.objects.create_superuser('root@example.com', PASSWORD)
        self.user = User.objects.create_user('ann@example.com', PASSWORD)
        enrol(self.user)
        self.client = Client()
        self.client.force_login(self.root)

    def reset(self, *users):
        return self.client.post(reverse('admin:accounts_user_changelist'),
                                {'action': 'reset_two_factor', '_selected_action': [str(u.pk) for u in users]}, follow=True)

    def test_the_reset_removes_the_factor_signs_the_user_out_logs_and_mails(self):
        refresh = APIClient()
        # a refresh token issued before the reset
        from rest_framework_simplejwt.tokens import RefreshToken
        token = str(RefreshToken.for_user(self.user))
        with self.captureOnCommitCallbacks(execute=True):
            res = self.reset(self.user)
        self.assertContains(res, '1 account(s) reset')
        self.assertFalse(mfa.enabled(self.user))
        self.assertEqual(refresh.post('/api/auth/refresh', {'refresh': token}, format='json').status_code, 401)
        entry = LogEntry.objects.get(object_id=str(self.user.pk))
        self.assertEqual((entry.user, entry.change_message), (self.root, 'Two-factor authentication reset.'))
        self.assertIn('reset', outbox.outbox[-1].subject)
        self.assertEqual(outbox.outbox[-1].to, ['ann@example.com'])

    def test_a_superadmin_cannot_reset_their_own(self):
        enrol(self.root)
        res = self.reset(self.root)
        self.assertContains(res, 'Not your own')
        self.assertTrue(mfa.enabled(self.root))
