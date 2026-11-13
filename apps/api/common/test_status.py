"""GET /api/status (#188)."""
from unittest import mock

from django.test import TestCase

from common import status

ALL_QUEUES = set(status.QUEUES)


class StatusTests(TestCase):
    def setUp(self):
        status.reset()
        self.addCleanup(status.reset)
        patcher = mock.patch.object(status, '_workers', return_value=ALL_QUEUES)
        self.workers = patcher.start()
        self.addCleanup(patcher.stop)

    def get(self):
        return self.client.get('/api/status')

    def test_all_up(self):
        r = self.get()
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body['ok'])
        self.assertEqual(body['services']['postgres'], 'up')
        self.assertEqual(body['services']['redis'], 'up')
        self.assertEqual(body['services']['s3'], 'up')
        self.assertEqual(body['services']['workers'], {q: 'up' for q in status.QUEUES})
        self.assertIn('version', body)
        self.assertEqual(r['Cache-Control'], 'no-store')

    def test_each_service_down_is_reported_without_details(self):
        secret = 'connection to storage.internal.example:5432 password=hunter2 refused'
        for name in ('_postgres', '_redis', '_s3'):
            status.reset()
            with mock.patch.object(status, name, side_effect=OSError(secret)):
                r = self.get()
            self.assertEqual(r.status_code, 503, name)
            body = r.json()
            self.assertEqual(body['services'][name[1:]], 'down')
            others = {'postgres', 'redis', 's3'} - {name[1:]}
            self.assertTrue(all(body['services'][o] == 'up' for o in others), name)
            self.assertNotIn('hunter2', r.content.decode())
            self.assertNotIn('storage.internal', r.content.decode())

    def test_a_queue_without_a_worker_is_down(self):
        self.workers.return_value = {'compile', 'transfer'}
        r = self.get()
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()['services']['workers'],
                         {'compile': 'up', 'transfer': 'up', 'ai': 'down', 'import': 'down'})

    def test_a_hanging_service_is_down_within_the_deadline(self):
        import threading, time
        release = threading.Event()
        self.addCleanup(release.set)
        with mock.patch.object(status, 'DEADLINE', 0.5), \
                mock.patch.object(status, '_s3', side_effect=lambda: release.wait(5)):
            t = time.monotonic()
            r = self.get()
        self.assertLess(time.monotonic() - t, 3)
        self.assertEqual(r.json()['services']['s3'], 'down')

    def test_cached_for_a_few_seconds(self):
        self.get()
        self.get()
        self.assertEqual(self.workers.call_count, 1)
        status.reset()
        self.get()
        self.assertEqual(self.workers.call_count, 2)
