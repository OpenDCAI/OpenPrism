from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from projects.models import Membership


class AuthTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def register(self, email='a@example.com', password='correct-horse-battery'):
        return self.client.post('/api/auth/register', {'email': email, 'password': password, 'name': 'Ann'}, format='json')

    def test_register_creates_user_and_personal_workspace(self):
        res = self.register()
        self.assertEqual(res.status_code, 201)
        self.assertTrue(res.data['ok'])
        self.assertIn('access', res.data)
        self.assertEqual(Membership.objects.filter(user__email='a@example.com', role='owner').count(), 1)

    def test_duplicate_email_uses_ok_error_shape(self):
        self.register()
        res = self.register(email='A@example.com')
        self.assertEqual(res.status_code, 400)
        self.assertFalse(res.data['ok'])
        self.assertIn('already exists', res.data['error'])

    def test_weak_password_rejected(self):
        self.assertEqual(self.register(password='123').status_code, 400)

    def test_login_then_me(self):
        self.register()
        login = self.client.post('/api/auth/login', {'email': 'a@example.com', 'password': 'correct-horse-battery'}, format='json')
        self.assertEqual(login.status_code, 200)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {login.data['access']}")
        me = self.client.get('/api/auth/me')
        self.assertEqual(me.data['user']['email'], 'a@example.com')

    def test_me_requires_auth_with_ok_error_shape(self):
        res = self.client.get('/api/auth/me')
        self.assertEqual(res.status_code, 401)
        self.assertFalse(res.data['ok'])


class SessionTests(TestCase):
    """Login casing, token rotation, logout and rate limiting."""

    def setUp(self):
        from django.core.cache import cache
        cache.clear()
        self.addCleanup(cache.clear)
        self.client = APIClient()
        self.client.post('/api/auth/register', {'email': 'Mixed@Example.com', 'password': 'correct-horse-battery'}, format='json')

    def login(self, email='mixed@example.com'):
        return self.client.post('/api/auth/login', {'email': email, 'password': 'correct-horse-battery'}, format='json')

    def test_login_ignores_email_case(self):
        for variant in ('mixed@example.com', 'MIXED@EXAMPLE.COM', ' Mixed@Example.com '):
            self.assertEqual(self.login(variant).status_code, 200, variant)
        self.assertEqual(self.client.post('/api/auth/login', {'email': 'mixed@example.com', 'password': 'wrong'}, format='json').status_code, 401)

    def test_registration_gives_a_personal_workspace(self):
        access = self.login().data['access']
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {access}')
        workspaces = self.client.get('/api/workspaces').data['workspaces']
        self.assertEqual([(w['name'], w['kind']) for w in workspaces], [('Personal', 'Personal')])

    def test_refresh_rotates_and_revokes_the_old_token(self):
        old = self.login().cookies['openprism_refresh'].value  # browsers get it only as an httpOnly cookie
        new = self.client.post('/api/auth/refresh', {'refresh': old}, format='json').data
        self.assertIn('access', new)
        self.assertNotEqual(new['refresh'], old)                                   # rotated
        self.assertEqual(self.client.post('/api/auth/refresh', {'refresh': old}, format='json').status_code, 401)  # old one is dead
        self.assertEqual(self.client.post('/api/auth/refresh', {'refresh': new['refresh']}, format='json').status_code, 200)

    def test_logout_revokes_the_refresh_token(self):
        refresh = self.login().cookies['openprism_refresh'].value
        self.assertTrue(self.client.post('/api/auth/logout', {'refresh': refresh}, format='json').data['ok'])
        self.assertEqual(self.client.post('/api/auth/refresh', {'refresh': refresh}, format='json').status_code, 401)
        self.assertTrue(self.client.post('/api/auth/logout', {'refresh': 'garbage'}, format='json').data['ok'])  # idempotent

    def test_update_profile_name(self):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {self.login().data['access']}")
        self.assertEqual(self.client.patch('/api/auth/me', {'name': '  Ada  '}, format='json').data['user']['name'], 'Ada')
        self.assertEqual(self.client.patch('/api/auth/me', {'name': ' '}, format='json').status_code, 400)

    def test_login_attempts_are_rate_limited(self):
        from unittest import mock
        from django.core.cache import cache
        from rest_framework.throttling import ScopedRateThrottle
        cache.clear()  # setUp's registration shares the 'auth' scope; start counting from zero
        with mock.patch.object(ScopedRateThrottle, 'THROTTLE_RATES', {'auth': '3/min'}):
            codes = [self.client.post('/api/auth/login', {'email': 'mixed@example.com', 'password': 'bad'}, format='json').status_code
                     for _ in range(5)]
        self.assertEqual(codes, [401, 401, 401, 429, 429])


class BehindProxyTests(TestCase):
    """Rate limits must key on the real client, not on the reverse proxy that every request arrives through."""

    def attempt(self, client_ip):
        return APIClient().post('/api/auth/login', {'email': 'x@example.com', 'password': 'bad'}, format='json',
                                HTTP_X_FORWARDED_FOR=client_ip, REMOTE_ADDR='10.0.0.1').status_code  # 10.0.0.1 = the proxy

    def run_scenario(self, proxies):
        from unittest import mock
        from django.conf import settings
        from django.core.cache import cache
        from rest_framework.throttling import ScopedRateThrottle
        cache.clear()
        self.addCleanup(cache.clear)
        with override_settings(REST_FRAMEWORK={**settings.REST_FRAMEWORK, 'NUM_PROXIES': proxies}), \
                mock.patch.object(ScopedRateThrottle, 'THROTTLE_RATES', {'auth': '2/min'}):
            first = [self.attempt('203.0.113.1') for _ in range(3)]
            second = self.attempt('203.0.113.2')
        return first, second

    def test_with_a_trusted_proxy_each_client_has_its_own_budget(self):
        first, second = self.run_scenario(proxies=1)
        self.assertEqual(first, [401, 401, 429])
        self.assertEqual(second, 401)  # a different person is not locked out by the first one's failures

    def test_without_proxy_awareness_everyone_shares_the_proxy_budget(self):
        first, second = self.run_scenario(proxies=0)
        self.assertEqual(second, 429)  # the failure mode TRUSTED_PROXY_COUNT exists to prevent
