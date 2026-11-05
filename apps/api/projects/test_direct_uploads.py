"""Direct uploads: binary files PUT straight to S3 with presigned URLs (v0.0.8, #53). Real Garage: the URLs are signed
for S3_PUBLIC_ENDPOINT_URL, so the tests send them to the internal endpoint with the public Host header."""
import urllib.error
import urllib.request
from datetime import timedelta
from urllib.parse import urlparse

from django.conf import settings
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from collab import tokens

from . import files, storage
from .models import Membership, PendingUpload, Project
from .tasks import cleanup_pending_uploads
from .test_api import ApiBase, client_for, make_user

PNG = b'\x89PNG' + b'x' * 1000


def put(url, data, content_type):
    """PUT to a presigned URL as a browser would (via the internal endpoint, with the public Host)."""
    u = urlparse(url)
    req = urllib.request.Request(f'{settings.S3_ENDPOINT_URL}{u.path}?{u.query}', data=data, method='PUT',
                                 headers={'Host': u.netloc, 'Content-Type': content_type})
    return urllib.request.urlopen(req).status


@override_settings(S3_DIRECT_UPLOADS=True)
class DirectUploadTests(ApiBase):
    def setUp(self):
        super().setUp()
        self.pid = self.new_project()
        self.project = Project.objects.get(pk=self.pid)
        self.base = f'/api/projects/{self.pid}'

    def start(self, items, client=None):
        return (client or self.c).post(f'{self.base}/uploads', {'files': items}, format='json')

    def complete(self, ids, client=None):
        return (client or self.c).post(f'{self.base}/uploads/complete', {'uploadIds': ids}, format='json').data

    def test_binary_goes_straight_to_storage_text_through_the_api(self):
        plan = self.start([{'path': 'figs/a.png', 'size': len(PNG), 'contentType': 'image/png'},
                           {'path': 'main.tex', 'size': 3, 'contentType': 'text/x-tex'}]).data
        self.assertTrue(plan['direct'])
        binary, text = plan['files']
        self.assertEqual(text, {'path': 'main.tex', 'direct': False})
        self.assertEqual(urlparse(binary['url']).netloc, urlparse(settings.S3_PUBLIC_ENDPOINT_URL).netloc)
        self.assertEqual(put(binary['url'], PNG, 'image/png'), 200)
        self.assertFalse(self.project.files.filter(path='figs/a.png').exists())  # nothing until complete
        done = self.complete([binary['uploadId']])
        self.assertEqual(done, {'ok': True, 'files': ['figs/a.png'], 'failed': []})
        self.assertEqual(files.read_bytes(self.project, 'figs/a.png'), PNG)
        self.assertEqual(self.project.files.get(path='figs/a.png').size, len(PNG))
        self.assertFalse(PendingUpload.objects.exists())

    def test_replacing_a_file_deletes_the_old_object(self):
        old = files.write_binary(self.project, 'a.png', b'old').s3_key
        plan = self.start([{'path': 'a.png', 'size': len(PNG), 'contentType': 'image/png'}]).data['files'][0]
        put(plan['url'], PNG, 'image/png')
        self.complete([plan['uploadId']])
        self.assertEqual(files.read_bytes(self.project, 'a.png'), PNG)
        with self.assertRaises(Exception):
            storage.get_bytes(old)

    def test_a_put_that_does_not_match_the_declared_size_is_refused(self):
        plan = self.start([{'path': 'a.png', 'size': 10, 'contentType': 'image/png'}]).data['files'][0]
        put(plan['url'], PNG, 'image/png')  # larger than declared
        done = self.complete([plan['uploadId']])
        self.assertEqual((done['ok'], done['files'], done['failed'][0]['path']), (False, [], 'a.png'))
        self.assertFalse(self.project.files.filter(path='a.png').exists())
        key = f"projects/{self.pid}/"
        self.assertFalse(any(True for _ in storage.get_client().list_objects_v2(Bucket=settings.S3_BUCKET, Prefix=key).get('Contents', [])))
        missing = self.start([{'path': 'b.png', 'size': 5, 'contentType': 'image/png'}]).data['files'][0]
        self.assertFalse(self.complete([missing['uploadId']])['ok'])  # never PUT

    def test_validation_and_permissions(self):
        files.write_text(self.project, 'notes.tex', 'x')
        # like the multipart upload, paths are sanitised leniently: '../x.png' becomes 'x.png'
        self.assertEqual(self.start([{'path': '../x.png', 'size': 1}]).data['files'][0]['path'], 'x.png')
        PendingUpload.objects.all().delete()
        for items, error in (([], 'Nothing to upload'), ([{'path': '', 'size': 1}], 'Invalid path'),
                             ([{'path': 'a.png', 'size': settings.MAX_UPLOAD_BYTES + 1}], 'larger than'),
                             ([{'path': 'notes.tex/a.png', 'size': 1}], 'is a file'), ([{'path': 'a.png'}], 'size')):
            res = self.start(items).data
            self.assertFalse(res['ok'], items)
            self.assertIn(error, res['error'])
        self.assertFalse(PendingUpload.objects.exists())  # a bad batch hands out nothing
        viewer = make_user('v@example.com')
        Membership.objects.create(workspace=self.project.workspace, user=viewer, role=Membership.VIEWER)
        self.assertEqual(self.start([{'path': 'a.png', 'size': 1}], client_for(viewer)).status_code, 403)
        self.assertEqual(self.start([{'path': 'a.png', 'size': 1}], client_for(make_user('o@example.com'))).status_code, 404)

    def test_an_editor_guest_may_upload_and_uploads_are_per_person(self):
        token, _ = tokens.create_invite(self.project, self.user, 'editor')
        guest = APIClient()
        guest.credentials(HTTP_AUTHORIZATION=f'Bearer {token}')
        plan = self.start([{'path': 'g.png', 'size': len(PNG), 'contentType': 'image/png'}], guest).data['files'][0]
        put(plan['url'], PNG, 'image/png')
        self.assertEqual(self.complete([plan['uploadId']])['files'], [])  # someone else cannot complete it
        self.assertEqual(self.complete([plan['uploadId']], guest)['files'], ['g.png'])

    def test_abandoned_uploads_are_cleaned_up(self):
        plan = self.start([{'path': 'a.png', 'size': len(PNG), 'contentType': 'image/png'}]).data['files'][0]
        put(plan['url'], PNG, 'image/png')
        PendingUpload.objects.update(created_at=timezone.now() - timedelta(hours=2))
        self.assertEqual(cleanup_pending_uploads(), 1)
        self.assertFalse(PendingUpload.objects.exists())
        self.assertFalse(self.project.files.filter(path='a.png').exists())
        with self.assertRaises(urllib.error.HTTPError):  # the object went with it, and the URL no longer leads anywhere
            u = urlparse(plan['url'])
            urllib.request.urlopen(urllib.request.Request(f'{settings.S3_ENDPOINT_URL}{u.path}', headers={'Host': u.netloc}))

    @override_settings(S3_DIRECT_UPLOADS=False)
    def test_off_means_the_old_endpoint(self):
        self.assertEqual(self.start([{'path': 'a.png', 'size': 1}]).data, {'ok': True, 'direct': False})
