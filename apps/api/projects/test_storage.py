"""The object-store client works with the cluster's MinIO (#164)."""
import base64
import hashlib

from botocore.awsrequest import AWSResponse
from django.test import SimpleTestCase, override_settings

from projects import storage


class FakeRaw:
    def stream(self, **_):
        yield b''


@override_settings(S3_ENDPOINT_URL='http://s3.invalid:9000', S3_BUCKET='b')
class DeleteObjectsHeaderTests(SimpleTestCase):
    """MinIO refuses DeleteObjects without Content-MD5 (MissingContentMD5); botocore 1.36+ no longer adds it."""

    def setUp(self):
        storage.get_client.cache_clear()
        self.addCleanup(storage.get_client.cache_clear)
        self.sent = []

        def capture(request, **_):
            self.sent.append(request)
            body = b'<?xml version="1.0"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></DeleteResult>'
            raw = FakeRaw()
            raw.stream = lambda **_: iter([body])
            return AWSResponse(request.url, 200, {'Content-Type': 'application/xml'}, raw)

        storage.get_client().meta.events.register_first('before-send.s3.DeleteObjects', capture)

    def test_delete_objects_carries_a_correct_content_md5(self):
        storage.delete_keys(['projects/p/1', 'projects/p/2'])
        self.assertEqual(len(self.sent), 1)
        req = self.sent[0]
        body = req.body if isinstance(req.body, bytes) else req.body.encode()
        self.assertEqual(req.headers['Content-MD5'].decode() if isinstance(req.headers['Content-MD5'], bytes) else req.headers['Content-MD5'],
                         base64.b64encode(hashlib.md5(body).digest()).decode())
        self.assertIn(b'projects/p/1', body)

    def test_large_deletes_are_batched_and_every_batch_has_the_header(self):
        storage.delete_keys(f'k/{i}' for i in range(2500))
        self.assertEqual(len(self.sent), 3)
        for req in self.sent:
            self.assertIn('Content-MD5', req.headers)

    def test_flexible_checksums_are_only_sent_when_required(self):
        cfg = storage.get_client().meta.config
        self.assertEqual((cfg.request_checksum_calculation, cfg.response_checksum_validation), ('when_required', 'when_required'))
