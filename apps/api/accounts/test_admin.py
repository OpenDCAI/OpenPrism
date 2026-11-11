"""The Django admin is reachable, styled and usable behind the proxies (#79), and for superusers only (#80)."""
import uuid

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings

PASSWORD = 'correct-horse-battery'


class AdminReachabilityTests(TestCase):
    def test_login_page_is_served_and_links_its_stylesheet(self):
        res = Client().get('/admin/login/')
        self.assertEqual(res.status_code, 200)
        self.assertIn(b'/static/admin/css/base.css', res.content)

    def test_static_files_are_served_by_the_api(self):
        res = Client().get('/static/admin/css/base.css')
        self.assertEqual(res.status_code, 200)
        self.assertIn('text/css', res['Content-Type'])
        self.assertEqual(Client().get('/static/admin/js/nonexistent.js').status_code, 404)

    @override_settings(CSRF_TRUSTED_ORIGINS=['https://openprism.example'], ALLOWED_HOSTS=['openprism.example'])
    def test_login_post_from_the_public_origin_passes_csrf_behind_a_tls_proxy(self):
        """nginx/Caddy terminate TLS, so the api sees http but the browser's Origin is https."""
        get_user_model().objects.create_superuser('root@example.com', PASSWORD)
        client = Client(enforce_csrf_checks=True)
        page = client.get('/admin/login/', HTTP_HOST='openprism.example', HTTP_X_FORWARDED_PROTO='https')
        token = page.cookies['csrftoken'].value
        res = client.post('/admin/login/', {'username': 'root@example.com', 'password': PASSWORD,
                                            'csrfmiddlewaretoken': token, 'next': '/admin/'},
                          HTTP_HOST='openprism.example', HTTP_ORIGIN='https://openprism.example',
                          HTTP_X_FORWARDED_PROTO='https')
        self.assertEqual(res.status_code, 302)
        self.assertEqual(res['Location'], '/admin/')

    def test_the_app_and_its_routes_are_unchanged(self):
        self.assertEqual(Client().get('/healthz').status_code, 200)
        self.assertEqual(Client().get('/api/auth/me').status_code, 401)


def login(client, email, password=PASSWORD, ip='203.0.113.7'):
    page = client.get('/admin/login/', REMOTE_ADDR=ip)
    return client.post('/admin/login/', {'username': email, 'password': password, 'next': '/admin/',
                                         'csrfmiddlewaretoken': page.cookies['csrftoken'].value}, REMOTE_ADDR=ip)


class AdminAccessTests(TestCase):
    """Only active superusers use the admin (#80); the app's JWT API never accepts the admin's session."""

    def setUp(self):
        User = get_user_model()
        self.root = User.objects.create_superuser('root@example.com', PASSWORD)
        self.staff = User.objects.create_user('staff@example.com', PASSWORD, is_staff=True)
        self.plain = User.objects.create_user('plain@example.com', PASSWORD)
        # one address per test: the login limit is counted in the shared cache and outlives a test run
        self.ip = '198.51.100.%d' % (uuid.uuid4().int % 250 + 1)

    def test_a_superuser_logs_in_and_reaches_the_index(self):
        client = Client()
        res = login(client, 'root@example.com', ip=self.ip)
        self.assertEqual((res.status_code, res['Location']), (302, '/admin/'))
        self.assertEqual(client.get('/admin/').status_code, 200)

    def test_staff_without_superuser_and_ordinary_accounts_cannot_log_in(self):
        for email in ('staff@example.com', 'plain@example.com'):
            client = Client()
            res = login(client, email, ip=self.ip)
            self.assertEqual(res.status_code, 200, email)  # the form again, with its error
            self.assertContains(res, 'Please enter the correct')
            self.assertEqual(client.get('/admin/').status_code, 302, email)

    def test_demoting_a_logged_in_superuser_ends_their_access_at_once(self):
        client = Client()
        login(client, 'root@example.com', ip=self.ip)
        self.root.is_superuser = False
        self.root.save()
        self.assertEqual(client.get('/admin/').status_code, 302)

    def test_a_logged_in_staff_session_gets_no_admin_pages(self):
        client = Client()
        client.force_login(self.staff)
        self.assertEqual(client.get('/admin/').status_code, 302)  # to the login form, not the index
        client.force_login(self.plain)
        self.assertEqual(client.get('/admin/auth/group/').status_code, 302)
        self.assertEqual(Client().get('/admin/').status_code, 302)

    def test_the_admin_session_cookie_is_its_own_and_hardened(self):
        with override_settings(SESSION_COOKIE_SECURE=True, CSRF_COOKIE_SECURE=True):
            client = Client()
            res = login(client, 'root@example.com', ip=self.ip)
        cookie = res.cookies['openprism_admin']
        self.assertEqual((cookie['httponly'], cookie['samesite'], cookie['secure']), (True, 'Strict', True))
        self.assertEqual(int(cookie['max-age']), 8 * 3600)
        csrf = Client().get('/admin/login/').cookies['csrftoken']
        self.assertEqual((csrf['httponly'], csrf['samesite']), (True, 'Strict'))

    def test_the_admin_session_does_not_authenticate_the_api(self):
        client = Client()
        login(client, 'root@example.com', ip=self.ip)
        self.assertEqual(client.get('/api/projects').status_code, 401)
        self.assertEqual(client.get('/api/auth/me').status_code, 401)

    @override_settings(ADMIN_LOGIN_RATE_PER_15_MIN=3)
    def test_login_attempts_are_limited_per_address(self):
        statuses = [login(Client(), 'root@example.com', 'wrong-password', ip=self.ip).status_code for _ in range(4)]
        self.assertEqual(statuses, [200, 200, 200, 429])
        res = login(Client(), 'root@example.com', 'wrong-password', ip=self.ip)
        self.assertEqual(res.status_code, 429)
        self.assertGreater(int(res['Retry-After']), 0)
        other = '192.0.2.%d' % (uuid.uuid4().int % 250 + 1)
        self.assertEqual(login(Client(), 'root@example.com', ip=other).status_code, 302)  # others are not affected


class AdminPasswordChangeTests(TestCase):
    """#103: changing the password on the admin's own page signs the account out of the app and mails the notice."""

    def setUp(self):
        from django.core import mail as outbox
        self.outbox = outbox.outbox
        self.root = get_user_model().objects.create_superuser('root@example.com', PASSWORD)
        self.ip = '198.51.100.%d' % (uuid.uuid4().int % 250 + 1)

    def test_it_revokes_refresh_tokens_and_sends_the_notice(self):
        from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
        from rest_framework_simplejwt.tokens import RefreshToken
        RefreshToken.for_user(self.root)
        RefreshToken.for_user(self.root)
        self.assertEqual(OutstandingToken.objects.filter(user=self.root).count(), 2)
        client = Client()
        login(client, 'root@example.com', ip=self.ip)
        self.outbox.clear()
        res = client.post('/admin/password_change/', {'old_password': PASSWORD, 'new_password1': 'a-new-long-passphrase-9',
                                                      'new_password2': 'a-new-long-passphrase-9'}, REMOTE_ADDR=self.ip)
        self.assertEqual((res.status_code, res['Location']), (302, '/admin/password_change/done/'))
        self.root.refresh_from_db()
        self.assertTrue(self.root.check_password('a-new-long-passphrase-9'))
        self.assertEqual(BlacklistedToken.objects.filter(token__user=self.root).count(), 2)
        self.assertEqual([m.to[0] for m in self.outbox], ['root@example.com'])
        self.assertEqual(client.get('/admin/', REMOTE_ADDR=self.ip).status_code, 200)  # this admin session stays

    def test_a_refused_change_revokes_and_mails_nothing(self):
        from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken
        from rest_framework_simplejwt.tokens import RefreshToken
        RefreshToken.for_user(self.root)
        client = Client()
        login(client, 'root@example.com', ip=self.ip)
        self.outbox.clear()
        res = client.post('/admin/password_change/', {'old_password': 'not-it', 'new_password1': 'a-new-long-passphrase-9',
                                                      'new_password2': 'a-new-long-passphrase-9'}, REMOTE_ADDR=self.ip)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(BlacklistedToken.objects.count(), 0)
        self.assertEqual(self.outbox, [])
