"""Scoped URL tokens: the only credential `?token=` accepts (v0.0.8, #51)."""
import time
from unittest import mock

from django.test import override_settings
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from collab import tokens
from jobs.models import Job
from projects import files, storage
from projects.models import Membership, Project
from projects.test_api import ApiBase, client_for, make_user
from versions.models import ProjectVersion

from . import urltokens


class UrlTokenTests(ApiBase):
    def setUp(self):
        super().setUp()
        self.pid = self.new_project()
        self.project = Project.objects.get(pk=self.pid)
        files.write_binary(self.project, 'a.png', b'\x89PNG')
        self.other = self.new_project('Other')

    def mint(self, client=None, **body):
        return (client or self.c).post('/api/url-token', {'scope': 'project', 'projectId': self.pid, **body}, format='json')

    def blob(self, token, pid=None):
        return APIClient().get(f'/api/projects/{pid or self.pid}/blob', {'path': 'a.png', 'token': token}).status_code

    def test_minting(self):
        res = self.mint().data
        self.assertTrue(res['token'].startswith('ut1.'))
        self.assertTrue(res['expiresAt'].endswith('Z'))
        self.assertEqual(self.blob(res['token']), 200)
        self.assertEqual(APIClient().post('/api/url-token', {'scope': 'import'}, format='json').status_code, 401)
        self.assertEqual(self.mint(client_for(make_user('out@example.com'))).status_code, 404)  # not a member
        self.assertFalse(self.c.post('/api/url-token', {'scope': 'everything'}, format='json').data['ok'])
        # a URL token cannot mint another
        self.assertEqual(APIClient().post(f"/api/url-token?token={res['token']}", {'scope': 'import'}, format='json').status_code, 401)

    def test_a_token_opens_its_own_project_only_and_import_tokens_open_no_project(self):
        token = self.mint().data['token']
        self.assertEqual(self.blob(token, self.other), 404)
        self.assertEqual(APIClient().get(f'/api/projects/{self.other}/versions', {'token': token}).status_code, 401)  # header-only endpoint
        imp = self.c.post('/api/url-token', {'scope': 'import'}, format='json').data['token']
        self.assertEqual(self.blob(imp), 404)
        res = APIClient().get('/api/projects/import-arxiv-sse', {'arxivIdOrUrl': 'x', 'token': token})
        self.assertEqual(res.status_code, 403)  # a project token cannot start an import

    def test_every_url_endpoint_refuses_full_credentials(self):
        jwt = str(RefreshToken.for_user(self.user).access_token)
        invite, _ = tokens.create_invite(self.project, self.user, 'editor')
        version = ProjectVersion.objects.create(project=self.project, number=1, manifest=[], main_file='main.tex',
                                                engine='pdflatex', pdf_key=f'versions/{self.pid}/x.pdf')
        storage.put_bytes(version.pdf_key, b'%PDF-1.4', 'application/pdf')
        job = Job.objects.create(type=Job.COMPILE, user=self.user, project=self.project, status=Job.SUCCESS,
                                 result={'pdfKey': version.pdf_key})
        urls = [f'/api/projects/{self.pid}/blob?path=a.png', f'/api/projects/{self.pid}/versions/{version.id}/pdf',
                f'/api/jobs/{job.id}/pdf']
        good = self.mint().data['token']
        for url in urls:
            for bad in (jwt, invite):
                self.assertEqual(APIClient().get(f'{url}&token={bad}' if '?' in url else f'{url}?token={bad}').status_code, 401, (url, bad[:4]))
            self.assertEqual(APIClient().get(f'{url}&token={good}' if '?' in url else f'{url}?token={good}').status_code, 200, url)
        other_job = Job.objects.create(type=Job.COMPILE, user=self.user, project=Project.objects.get(pk=self.other),
                                       status=Job.SUCCESS, result={'pdfKey': version.pdf_key})
        self.assertEqual(APIClient().get(f'/api/jobs/{other_job.id}/pdf?token={good}').status_code, 404)
        self.assertEqual(APIClient().get('/api/projects/import-arxiv-sse', {'arxivIdOrUrl': 'x', 'token': jwt}).status_code, 401)

    def test_expiry(self):
        with override_settings(URL_TOKEN_SECONDS=1):
            token = self.mint().data['token']
            self.assertEqual(self.blob(token), 200)
            time.sleep(3.5)  # margin: the dev clock can step back about a second
            self.assertEqual(self.blob(token), 401)

    def test_removal_and_tampering(self):
        member = make_user('m@example.com')
        Membership.objects.create(workspace=self.project.workspace, user=member, role=Membership.VIEWER)
        token = self.mint(client_for(member)).data['token']
        self.assertEqual(self.blob(token), 200)
        Membership.objects.filter(user=member).delete()
        self.assertEqual(self.blob(token), 404)  # removed: the token no longer opens anything
        self.assertEqual(self.blob(token[:-2] + ('A' if token[-2] != 'A' else 'B') + token[-1]), 401)
        member.is_active = False
        member.save()
        with self.assertRaises(urltokens.InvalidUrlToken):
            urltokens.verify(token)
