"""The registered admin models show what a superadmin needs and never a credential (v0.1.1, #81)."""
import datetime

from django.contrib import admin
from django.contrib.admin.models import CHANGE, LogEntry
from django.contrib.contenttypes.models import ContentType
from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from django.urls import reverse
from django.utils import timezone

from collab.models import CollabDoc, CollabInvite
from integrations.models import CredentialEvent, LlmUsage, UserCredential, WorkspaceLlmConfig, ZoteroConnection
from jobs.models import Job
from projects.models import Membership, Project, ProjectFile, Workspace, WorkspaceInvite
from templates_app.models import Template
from accounts.models import PlatformInvite
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
from rest_framework_simplejwt.tokens import RefreshToken
from versions.models import ProjectVersion

User = get_user_model()
SECRETS = ['ZOTERO-CIPHER-SECRET', 'USERKEY-CIPHER-SECRET', 'WSKEY-CIPHER-SECRET', 'JOBPARAM-SECRET', 'JOBRESULT-SECRET',
           'JOBLOG-SECRET', 'TOKENHASH-SECRET', 'L4ZZ', 'EVENTDETAIL-SECRET', 'FILE-CONTENT-SECRET', 'MANIFEST-SECRET', 'PLATFORMTOKEN-SECRET']


class AdminModelTests(TestCase):
    def setUp(self):
        self.root = User.objects.create_superuser('root@example.com', 'correct-horse-battery')
        self.ann = User.objects.create_user('ann@example.com', 'correct-horse-battery', name='Ann')
        ws = self.ws = Workspace.objects.create(name='Lab')
        Membership.objects.create(workspace=ws, user=self.ann, role=Membership.OWNER)
        WorkspaceInvite.objects.create(workspace=ws, email='new@example.com', invited_by=self.ann)
        project = self.project = Project.objects.create(workspace=ws, name='Paper', created_by=self.ann)
        ProjectFile.objects.create(project=project, path='main.tex', content='FILE-CONTENT-SECRET')
        Job.objects.create(type=Job.COMPILE, user=self.ann, project=project, params={'apiKey': 'JOBPARAM-SECRET'},
                           result={'body': 'JOBRESULT-SECRET'}, progress_log=['JOBLOG-SECRET'], error='boom')
        CollabInvite.objects.create(project=project, token_hash='TOKENHASH-SECRET', created_by=self.ann,
                                    expires_at=timezone.now() + datetime.timedelta(days=1))
        CollabDoc.objects.create(project=project, path='main.tex', state=b'FILE-CONTENT-SECRET')
        ZoteroConnection.objects.create(user=self.ann, zotero_user_id=1, api_key_encrypted=b'ZOTERO-CIPHER-SECRET', last_four='L4ZZ')
        UserCredential.objects.create(user=self.ann, profile='llm', api_key_encrypted=b'USERKEY-CIPHER-SECRET', last_four='L4ZZ')
        WorkspaceLlmConfig.objects.create(workspace=ws, api_key_encrypted=b'WSKEY-CIPHER-SECRET', last_four='L4ZZ')
        CredentialEvent.objects.create(actor=self.ann, actor_name='Ann', workspace=ws, kind='workspace_llm', action='set',
                                       last_four='L4ZZ', detail={'model': 'EVENTDETAIL-SECRET'})
        LlmUsage.objects.create(day=timezone.now().date(), user=self.ann, workspace=ws, source='server', count=3)
        PlatformInvite.objects.create(email='invited@example.com', token_hash='PLATFORMTOKEN-SECRET', invited_by=self.root,
                                      expires_at=timezone.now() + datetime.timedelta(days=7))
        Template.objects.create(id='tpl', label='Template')
        ProjectVersion.objects.create(project=project, number=1, main_file='main.tex', engine='pdflatex', manifest_hash='h',
                                      manifest=[{'path': 'MANIFEST-SECRET'}], created_by=self.ann)
        LogEntry.objects.create(user=self.root, content_type=ContentType.objects.get_for_model(User), object_id=str(self.ann.pk),
                                object_repr='ann', action_flag=CHANGE, change_message='seed')
        self.refresh = str(RefreshToken.for_user(self.ann))  # simplejwt keeps every refresh token it issues
        self.client = Client()
        self.client.force_login(self.root)

    def leaks(self, res):
        body = res.content.decode()
        return [s for s in SECRETS + [self.refresh] if s in body]

    def registered(self):
        return [(m, a) for m, a in admin.site._registry.items() if m._meta.app_label != 'auth']

    def test_every_list_and_detail_page_loads_and_shows_no_secret(self):
        pages = 0
        for model, _ in self.registered():
            info = (model._meta.app_label, model._meta.model_name)
            urls = [reverse('admin:%s_%s_changelist' % info)]
            urls += [reverse('admin:%s_%s_change' % info, args=[o.pk]) for o in model.objects.all()]
            for url in urls:
                res = self.client.get(url)
                self.assertEqual(res.status_code, 200, url)
                self.assertEqual(self.leaks(res), [], url)
                pages += 1
        self.assertGreater(pages, 15)
        for url in ('/admin/', '/admin/accounts/user/?q=ann', '/admin/jobs/job/?q=ann', '/admin/projects/project/?q=Paper'):
            res = self.client.get(url)
            self.assertEqual(res.status_code, 200, url)
            self.assertEqual(self.leaks(res), [], url)

    def test_models_that_hold_credentials_or_file_contents_are_not_registered(self):
        for model in (ZoteroConnection, UserCredential, WorkspaceLlmConfig, ProjectFile, CollabDoc, OutstandingToken,
                      BlacklistedToken):
            self.assertFalse(admin.site.is_registered(model), model.__name__)

    def test_read_only_models_have_no_add_change_or_delete(self):
        for model, ma in self.registered():
            if model is User:
                continue
            info = (model._meta.app_label, model._meta.model_name)
            obj = model.objects.first()
            self.assertEqual(self.client.get(reverse('admin:%s_%s_add' % info)).status_code, 403, model.__name__)
            self.assertEqual(self.client.post(reverse('admin:%s_%s_change' % info, args=[obj.pk]), {}).status_code, 403, model.__name__)
            self.assertEqual(self.client.post(reverse('admin:%s_%s_delete' % info, args=[obj.pk]), {'post': 'yes'}).status_code, 403, model.__name__)

    def test_accounts_workspaces_and_projects_cannot_be_deleted_even_in_bulk(self):
        for model, pk in ((User, self.ann.pk), (Workspace, self.ws.pk), (Project, self.project.pk)):
            info = (model._meta.app_label, model._meta.model_name)
            self.client.post(reverse('admin:%s_%s_delete' % info, args=[pk]), {'post': 'yes'})
            self.client.post(reverse('admin:%s_%s_changelist' % info),
                             {'action': 'delete_selected', '_selected_action': [str(pk)], 'post': 'yes'})
            self.assertTrue(model.objects.filter(pk=pk).exists(), model.__name__)

    def test_a_superadmin_edits_account_flags_and_the_change_is_logged(self):
        url = reverse('admin:accounts_user_change', args=[self.ann.pk])
        page = self.client.get(url)
        self.assertNotContains(page, 'name="password"')
        self.assertNotContains(page, 'pbkdf2')
        res = self.client.post(url, {'name': 'Ann B', 'is_staff': 'on'})  # unchecked boxes: is_active -> False
        self.assertEqual(res.status_code, 302)
        self.ann.refresh_from_db()
        self.assertEqual((self.ann.name, self.ann.is_active, self.ann.is_staff, self.ann.email), ('Ann B', False, True, 'ann@example.com'))
        entry = LogEntry.objects.exclude(change_message='seed').get(object_id=str(self.ann.pk))
        self.assertEqual((entry.action_flag, entry.user_id), (CHANGE, self.root.pk))
        listing = self.client.get(reverse('admin:admin_logentry_changelist'))
        self.assertContains(listing, 'ann@example.com')

    def test_mark_email_verified_action(self):
        res = self.client.post(reverse('admin:accounts_user_changelist'),
                               {'action': 'mark_email_verified', '_selected_action': [str(self.ann.pk)]})
        self.assertEqual(res.status_code, 302)
        self.ann.refresh_from_db()
        self.assertIsNotNone(self.ann.email_verified_at)
