from django.conf import settings
from django.test import SimpleTestCase


class VersionTests(SimpleTestCase):
    def test_healthz_reports_the_version_file(self):
        body = self.client.get('/healthz').json()
        self.assertEqual(body, {'ok': True, 'version': settings.VERSION})
        self.assertRegex(settings.VERSION, r'^\d+\.\d+\.\d+$')
