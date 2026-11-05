"""The refresh token lives in an httpOnly cookie; the access token is the only token in a body (v0.0.8, #52)."""
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

COOKIE, PASSWORD = 'openprism_refresh', 'correct-horse-battery'
OK = {'HTTP_X_OPENPRISM_REFRESH': '1'}


class RefreshCookieTests(TestCase):
    def setUp(self):
        self.browser = APIClient()  # keeps cookies, like a browser
        self.res = self.browser.post('/api/auth/register', {'email': 'ann@example.com', 'password': PASSWORD}, format='json')

    def cookie(self, res=None):
        return (res or self.res).cookies[COOKIE]

    def test_sign_in_sets_a_strict_httponly_cookie_and_no_refresh_in_the_body(self):
        for res in (self.res, self.browser.post('/api/auth/login', {'email': 'ann@example.com', 'password': PASSWORD}, format='json')):
            self.assertIn('access', res.data)
            self.assertNotIn('refresh', res.data)
            c = self.cookie(res)
            self.assertTrue(c['httponly'])
            self.assertEqual((c['samesite'], c['path']), ('Strict', '/api/auth'))
            self.assertGreater(int(c['max-age']), 86400)

    @override_settings(REFRESH_COOKIE_SECURE=True)
    def test_secure_outside_debug(self):
        res = APIClient().post('/api/auth/register', {'email': 'bob@example.com', 'password': PASSWORD}, format='json')
        self.assertTrue(res.cookies[COOKIE]['secure'])

    def test_refresh_with_the_cookie_rotates_it(self):
        old = self.cookie().value
        res = self.browser.post('/api/auth/refresh', **OK)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(set(res.data), {'ok', 'access'})
        new = self.cookie(res).value
        self.assertNotEqual(new, old)
        self.assertEqual(APIClient().post('/api/auth/refresh', {'refresh': old}, format='json').status_code, 401)  # old is dead
        self.assertEqual(self.browser.post('/api/auth/refresh', **OK).status_code, 200)  # the browser holds the new one

    def test_csrf_checks(self):
        self.assertEqual(self.browser.post('/api/auth/refresh').status_code, 403)  # no custom header
        self.assertEqual(self.browser.post('/api/auth/refresh', HTTP_ORIGIN='https://evil.example', **OK).status_code, 403)
        self.assertEqual(self.browser.post('/api/auth/logout', HTTP_ORIGIN='https://evil.example', **OK).status_code, 403)
        self.assertEqual(self.browser.post('/api/auth/refresh', HTTP_ORIGIN='http://localhost:5173', **OK).status_code, 200)
        with override_settings(TRUSTED_ORIGINS=['http://localhost:5173', 'http://localhost:8080']):
            self.assertEqual(self.browser.post('/api/auth/refresh', HTTP_ORIGIN='http://localhost:8080', **OK).status_code, 200)

    def test_logout_revokes_and_clears_the_cookie(self):
        old = self.cookie().value
        res = self.browser.post('/api/auth/logout', **OK)
        self.assertTrue(res.data['ok'])
        self.assertEqual(self.cookie(res).value, '')  # deleted
        self.assertEqual(APIClient().post('/api/auth/refresh', {'refresh': old}, format='json').status_code, 401)
        self.assertEqual(self.browser.post('/api/auth/refresh', **OK).status_code, 401)  # nothing left to refresh with

    def test_a_dead_cookie_is_refused(self):
        self.browser.cookies[COOKIE] = 'garbage'
        res = self.browser.post('/api/auth/refresh', **OK)
        self.assertEqual(res.status_code, 401)
        self.assertNotIn(COOKIE, res.cookies)  # left alone: the client retries once (a clock step can refuse a good one)

    def test_api_clients_can_still_refresh_with_the_body(self):
        api = APIClient()
        token = self.cookie().value
        res = api.post('/api/auth/refresh', {'refresh': token}, format='json')
        self.assertEqual(res.status_code, 200)
        self.assertIn('refresh', res.data)  # answered in the body, as before

    def test_password_change_moves_this_browser_to_a_new_cookie(self):
        self.browser.credentials(HTTP_AUTHORIZATION=f"Bearer {self.res.data['access']}")
        res = self.browser.post('/api/auth/password/change', {'current': PASSWORD, 'password': 'new-horse-battery-9'}, format='json')
        self.assertNotIn('refresh', res.data)
        self.assertEqual(self.browser.post('/api/auth/refresh', **OK).status_code, 200)

    def test_deleting_the_account_clears_the_cookie(self):
        self.browser.credentials(HTTP_AUTHORIZATION=f"Bearer {self.res.data['access']}")
        res = self.browser.delete('/api/auth/me', {'password': PASSWORD}, format='json')
        self.assertEqual(self.cookie(res).value, '')

    def test_a_browser_moves_an_old_stored_refresh_token_into_the_cookie(self):
        from rest_framework_simplejwt.tokens import RefreshToken
        from accounts.models import User
        stored = str(RefreshToken.for_user(User.objects.get(email='ann@example.com')))
        fresh = APIClient()  # a browser with no cookie yet, only the old localStorage entry
        res = fresh.post('/api/auth/refresh', {'refresh': stored}, format='json', **OK)
        self.assertEqual(set(res.data), {'ok', 'access'})
        self.assertTrue(self.cookie(res).value)
        self.assertEqual(fresh.post('/api/auth/refresh', **OK).status_code, 200)
        self.assertEqual(APIClient().post('/api/auth/refresh', {'refresh': stored}, format='json').status_code, 401)  # rotated
