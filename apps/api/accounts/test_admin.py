"""The Django admin is reachable, styled and usable behind the proxies (v0.1.1, #79)."""
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
