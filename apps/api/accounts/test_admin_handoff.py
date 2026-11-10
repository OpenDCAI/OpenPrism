"""One sign-in for the app and the admin (#94)."""
import time
from unittest.mock import patch

from allauth.mfa.models import Authenticator
from django.core.cache import cache
from django.test import Client, TestCase, override_settings
from rest_framework.test import APIClient

from accounts import adminhandoff
from accounts.models import User
from accounts.test_admin import PASSWORD
from accounts.test_admin_mfa import enrol


def app_client(user):
    client = APIClient()
    res = client.post('/api/auth/login', {'email': user.email, 'password': PASSWORD}, format='json')
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
    return client


class AdminHandoffTests(TestCase):
    def setUp(self):
        cache.clear()
        self.root = User.objects.create_superuser('root@example.com', PASSWORD)

    def code(self, user=None):
        return app_client(user or self.root).post('/api/auth/admin-handoff').data['code']

    def test_a_superadmin_goes_from_the_app_into_the_admin_with_no_second_login(self):
        browser = Client()
        self.assertEqual(browser.get('/admin/').status_code, 302)  # no admin session yet
        res = browser.post('/admin/handoff/', {'code': self.code()})
        self.assertEqual((res.status_code, res['Location']), (302, '/admin/'))
        self.assertEqual(browser.get('/admin/').status_code, 200)
        self.assertIn('openprism_admin', res.cookies)
        self.assertTrue(res.cookies['openprism_admin']['httponly'])
        self.assertEqual(res.cookies['openprism_admin']['samesite'], 'Strict')

    def test_the_code_works_once(self):
        code = self.code()
        self.assertEqual(Client().post('/admin/handoff/', {'code': code})['Location'], '/admin/')
        second = Client()
        self.assertEqual(second.post('/admin/handoff/', {'code': code})['Location'], '/admin/login/')
        self.assertEqual(second.get('/admin/').status_code, 302)

    def test_the_code_expires(self):
        with patch.object(adminhandoff, 'SECONDS', 1):
            code = self.code()
        time.sleep(1.6)
        self.assertEqual(Client().post('/admin/handoff/', {'code': code})['Location'], '/admin/login/')

    def test_only_the_hash_is_kept_and_junk_is_refused(self):
        code = self.code()
        self.assertIsNone(cache.get('admin-handoff:' + code))
        for junk in ('', 'x', 'a' * 500, code[:-1]):
            self.assertEqual(Client().post('/admin/handoff/', {'code': junk})['Location'], '/admin/login/')
        self.assertEqual(Client().get('/admin/handoff/').status_code, 405)

    def test_nobody_but_a_superadmin_gets_a_code(self):
        for user in (User.objects.create_user('ann@example.com', PASSWORD),
                     User.objects.create_user('staff@example.com', PASSWORD, is_staff=True)):
            self.assertEqual(app_client(user).post('/api/auth/admin-handoff').status_code, 403, user.email)
        self.assertEqual(APIClient().post('/api/auth/admin-handoff').status_code, 401)

    def test_a_demoted_account_cannot_redeem_a_code_it_already_had(self):
        code = self.code()
        User.objects.filter(pk=self.root.pk).update(is_superuser=False)
        self.assertEqual(Client().post('/admin/handoff/', {'code': code})['Location'], '/admin/login/')

    @override_settings(SUPERADMIN_REQUIRE_MFA=True)
    def test_a_required_second_factor_is_not_skipped(self):
        self.assertEqual(app_client(self.root).post('/api/auth/admin-handoff').status_code, 403)
        enrol(self.root)
        from accounts import mfa
        from accounts.test_mfa import code as totp_code
        # sign in with the factor, as the app would
        client = APIClient()
        ticket = client.post('/api/auth/login', {'email': self.root.email, 'password': PASSWORD}, format='json').data['ticket']
        factor = Authenticator.objects.get(user=self.root, type='totp')
        from allauth.mfa.utils import decrypt
        done = client.post('/api/auth/login/mfa', {'ticket': ticket, 'code': totp_code(decrypt(factor.data['secret']))}, format='json')
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {done.data['access']}")
        code = client.post('/api/auth/admin-handoff').data['code']
        mfa.remove(self.root)  # reset between asking and arriving
        self.assertEqual(Client().post('/admin/handoff/', {'code': code})['Location'], '/admin/login/')

    def test_the_app_reports_who_may_see_the_admin_link(self):
        self.assertTrue(app_client(self.root).get('/api/auth/me').data['user']['isSuperuser'])
        self.assertFalse(app_client(User.objects.create_user('ann@example.com', PASSWORD)).get('/api/auth/me').data['user']['isSuperuser'])
