"""One scoped AI setting for workspaces and projects (#78, part 1): resolution order, the key migration, the API."""
import importlib
import json
from unittest import mock

from django.apps import apps as django_apps
from django.db import connection
from django.test import override_settings
from rest_framework.test import APIClient

from ai import tasks as ai_tasks
from common.testing import FakeLLM
from jobs.models import Job
from projects.models import Membership, Project, Workspace
from projects.test_api import ApiBase, client_for, make_user

from . import aiprofiles, crypto
from .models import AiProfile, CredentialEvent, UserCredential, WorkspaceLlmConfig

K = {'project': 'sk-PROJECT-SECRET-1111', 'workspace': 'sk-WORKSPACE-SECRET-2222', 'other': 'sk-OTHER-SECRET-3333',
     'mineru': 'mineru-SECRET-4444'}


class Base(ApiBase):
    def setUp(self):
        super().setUp()
        for name in ('integrations.aiprofiles.assert_public_url',):
            p = mock.patch(name)    # the fakes listen on localhost; the guard has its own tests
            p.start()
            self.addCleanup(p.stop)
        self.pid = self.new_project()
        self.project = Project.objects.get(pk=self.pid)
        self.ws = self.project.workspace

    def fake(self):
        f = FakeLLM([{'content': 'ok'}] * 6)
        self.addCleanup(f.close)
        return f


@override_settings(LLM_ALLOW_PRIVATE_ENDPOINTS=True)
class ResolutionOrderTests(Base):
    """project > workspace > server, per profile, with Search and Vision following the AI model."""

    def setUp(self):
        super().setUp()
        sync = lambda job_id, secrets=None: ai_tasks.run_ai_job.run(job_id, secrets)
        p = mock.patch('ai.views.run_ai_job.delay', side_effect=sync)
        self.delay = p.start()
        self.addCleanup(p.stop)

    def ask(self, profile):
        return self.c.post('/api/llm', {'messages': [], 'projectId': self.pid, 'llmConfig': {'profile': profile}}, format='json')

    def source(self):
        return Job.objects.order_by('-created_at').first().params['keySource']

    def test_each_profile_walks_project_then_workspace_then_server(self):
        for profile in ('llm', 'search', 'vision'):
            with self.subTest(profile=profile):
                AiProfile.objects.all().delete()
                Job.objects.all().delete()
                ws_fake, proj_fake = self.fake(), self.fake()
                # nothing set anywhere: the server default
                self.ask(profile)
                self.assertEqual(self.source(), 'server')
                # workspace only
                aiprofiles.save(self.ws, self.user, profile, ws_fake.url, 'ws-model', K['workspace'])
                self.ask(profile)
                self.assertEqual(self.source(), 'workspace')
                self.assertEqual((len(ws_fake.requests), ws_fake.requests[-1]['auth']), (1, f"Bearer {K['workspace']}"))
                # the project overrides this profile
                aiprofiles.save(self.project, self.user, profile, proj_fake.url, 'proj-model', K['project'])
                self.ask(profile)
                self.assertEqual(self.source(), 'project')
                self.assertEqual((len(proj_fake.requests), proj_fake.requests[-1]['body']['model']), (1, 'proj-model'))
                self.assertEqual(len(ws_fake.requests), 1)       # the workspace was not used again
                # reset: back to the workspace
                aiprofiles.remove(self.project, self.user, profile)
                self.ask(profile)
                self.assertEqual(self.source(), 'workspace')

    def test_a_project_overrides_one_profile_and_inherits_the_rest(self):
        main, search = self.fake(), self.fake()
        aiprofiles.save(self.ws, self.user, 'llm', main.url, 'main', K['workspace'])
        aiprofiles.save(self.project, self.user, 'search', search.url, 'search-only', K['project'])
        self.ask('llm')
        self.ask('search')
        self.ask('vision')      # unset everywhere: follows the AI model
        self.assertEqual([r['body']['model'] for r in main.requests], ['main', 'main'])
        self.assertEqual([r['body']['model'] for r in search.requests], ['search-only'])

    def test_a_project_ai_model_is_what_search_and_vision_follow(self):
        ws, proj = self.fake(), self.fake()
        aiprofiles.save(self.ws, self.user, 'llm', ws.url, 'ws', K['workspace'])
        aiprofiles.save(self.project, self.user, 'llm', proj.url, 'proj', K['project'])
        self.ask('vision')
        self.assertEqual((len(proj.requests), len(ws.requests)), (1, 0))

    def test_a_request_key_stays_below_project_and_workspace_and_above_the_server(self):
        ws, own = self.fake(), self.fake()
        body = {'messages': [], 'projectId': self.pid, 'llmConfig': {'endpoint': own.url, 'apiKey': K['other']}}
        self.c.post('/api/llm', body, format='json')
        self.assertEqual((self.source(), len(own.requests)), ('browser', 1))
        aiprofiles.save(self.ws, self.user, 'llm', ws.url, 'ws', K['workspace'])
        self.c.post('/api/llm', body, format='json')
        self.assertEqual((self.source(), len(ws.requests), len(own.requests)), ('workspace', 1, 1))

    def test_only_members_who_can_write_use_workspace_and_project_settings(self):
        f = self.fake()
        aiprofiles.save(self.ws, self.user, 'llm', f.url, 'ws', K['workspace'])
        viewer = make_user('viewer@example.com')
        Membership.objects.create(workspace=self.ws, user=viewer, role='viewer')
        res = client_for(viewer).post('/api/llm', {'messages': [], 'projectId': self.pid}, format='json')
        self.assertEqual(f.requests, [])     # the viewer never reaches the shared key
        self.assertEqual(Job.objects.order_by('-created_at').first().params['keySource'] if res.status_code == 200 else 'server', 'server')

    def test_mineru_walks_project_then_workspace(self):
        self.assertIsNone(aiprofiles.usable(self.user, self.project, self.ws, 'mineru'))
        aiprofiles.save(self.ws, self.user, 'mineru', 'https://mineru.example.com/api', None, K['mineru'])
        public, key, level = aiprofiles.usable(self.user, self.project, self.ws, 'mineru')
        self.assertEqual((level, key, public['endpoint']), ('workspace', K['mineru'], 'https://mineru.example.com/api'))
        aiprofiles.save(self.project, self.user, 'mineru', 'https://mineru.project.example.com', None, K['project'])
        public, key, level = aiprofiles.usable(self.user, self.project, self.ws, 'mineru')
        self.assertEqual((level, key), ('project', K['project']))

    def test_effective_view_says_where_each_profile_comes_from(self):
        aiprofiles.save(self.ws, self.user, 'llm', 'https://a.example.com/v1', 'm', K['workspace'])
        aiprofiles.save(self.project, self.user, 'search', 'https://b.example.com/v1', 'm', K['project'])
        eff = aiprofiles.effective(self.project, self.ws)
        self.assertEqual((eff['llm']['source'], eff['search']['source'], eff['vision']['source'], eff['vision']['viaLlm']),
                         ('workspace', 'project', 'workspace', True))
        self.assertIsNone(eff['mineru'])
        self.assertNotIn(K['workspace'], json.dumps(eff))


class MigrationTests(Base):
    """Migration 0007 moves workspace providers and personal keys into AiProfile."""
    migration = importlib.import_module('integrations.migrations.0007_copy_keys_to_ai_profiles')

    def run_copy(self):
        self.migration.copy(django_apps, None)

    def test_workspace_providers_and_personal_keys_are_copied_once_with_the_same_ciphertext(self):
        team = Workspace.objects.create(name='Team')
        Membership.objects.create(workspace=team, user=self.user, role='owner')
        c1 = crypto.encrypt('team-secret')
        WorkspaceLlmConfig.objects.create(workspace=team, endpoint='https://t.example.com/v1/chat/completions', model='tm',
                                          api_key_encrypted=c1, last_four='cret', daily_limit=7, updated_by=self.user)
        personal = Workspace.objects.get(kind='personal', memberships__user=self.user)
        UserCredential.objects.create(user=self.user, profile='llm', model='mine', api_key_encrypted=crypto.encrypt('mine-secret'), last_four='cret')
        UserCredential.objects.create(user=self.user, profile='mineru', endpoint='https://m.example.com', api_key_encrypted=crypto.encrypt('mu-secret'), last_four='cret')
        self.run_copy()
        t = AiProfile.objects.get(workspace=team, profile='llm')
        self.assertEqual((bytes(t.api_key_encrypted), t.daily_limit, t.model), (bytes(c1), 7, 'tm'))
        self.assertEqual(crypto.decrypt(t.api_key_encrypted), 'team-secret')
        self.assertEqual(crypto.decrypt(AiProfile.objects.get(workspace=personal, profile='llm').api_key_encrypted), 'mine-secret')
        self.assertEqual(AiProfile.objects.get(workspace=personal, profile='mineru').endpoint, 'https://m.example.com')
        before = list(AiProfile.objects.order_by('id').values_list('id', 'api_key_encrypted'))
        self.run_copy()                                  # a second run changes nothing
        self.assertEqual(list(AiProfile.objects.order_by('id').values_list('id', 'api_key_encrypted')), before)

    def test_an_existing_workspace_setting_wins_over_a_personal_key_for_the_same_profile(self):
        personal = Workspace.objects.get(kind='personal', memberships__user=self.user)
        WorkspaceLlmConfig.objects.create(workspace=personal, api_key_encrypted=crypto.encrypt('ws-wins'), last_four='wins')
        UserCredential.objects.create(user=self.user, profile='llm', api_key_encrypted=crypto.encrypt('personal-loses'), last_four='ose')
        self.run_copy()
        self.assertEqual(crypto.decrypt(AiProfile.objects.get(workspace=personal, profile='llm').api_key_encrypted), 'ws-wins')

    def test_nothing_is_logged_or_recorded_by_the_copy(self):
        UserCredential.objects.create(user=self.user, profile='llm', api_key_encrypted=crypto.encrypt('quiet'), last_four='uiet')
        with self.assertNoLogs(level='DEBUG'):
            self.run_copy()
        self.assertEqual(CredentialEvent.objects.count(), 0)


class ApiTests(Base):
    def url(self, suffix=''):
        return f'/api/workspaces/{self.ws.id}/ai{suffix}'

    def put(self, profile, client=None, **body):
        return (client or self.c).put(self.url(f'/{profile}'), body, format='json')

    def test_set_replace_remove_each_profile_without_touching_the_others(self):
        res = self.put('llm', endpoint='https://a.example.com/v1', model='m', apiKey=K['workspace']).json()
        self.assertEqual(res['profiles']['llm']['lastFour'], '2222')
        self.assertFalse(res['profiles']['search']['configured'])
        self.put('search', endpoint='https://s.example.com/v1', model='sm', apiKey=K['other'])
        self.put('mineru', endpoint='https://mu.example.com/api', apiKey=K['mineru'])
        body = self.c.get(self.url()).json()
        self.assertEqual([p for p, v in body['profiles'].items() if v['configured']], ['llm', 'search', 'mineru'])
        self.put('llm', model='m2')                                       # the model alone needs no key
        self.assertEqual(self.c.get(self.url()).json()['profiles']['search']['model'], 'sm')
        self.assertEqual(self.put('llm', endpoint='https://z.example.com/v1').json()['error'],
                         'Enter the API key again to change the endpoint.')
        self.assertFalse(self.c.delete(self.url('/search')).json()['profiles']['search']['configured'])
        self.assertTrue(self.c.get(self.url()).json()['profiles']['llm']['configured'])
        self.assertEqual(self.put('nope', apiKey='x').status_code, 404)

    def test_only_admins_manage_and_members_see_only_what_exists(self):
        self.put('llm', endpoint='https://a.example.com/v1', model='m', apiKey=K['workspace'])
        editor = make_user('editor@example.com')
        Membership.objects.create(workspace=self.ws, user=editor, role='editor')
        c = client_for(editor)
        self.assertEqual(self.put('llm', c, apiKey='sk-x').status_code, 403)
        self.assertEqual(c.delete(self.url('/llm')).status_code, 403)
        body = c.get(self.url()).json()
        self.assertTrue(body['canUse'] and not body['canManage'])
        self.assertEqual(body['profiles']['llm'], {'configured': True, 'updatedAt': body['profiles']['llm']['updatedAt'], 'model': 'm'})
        self.assertEqual(client_for(make_user('out@example.com')).get(self.url()).status_code, 404)
        self.assertEqual(APIClient().get(self.url()).status_code, 401)

    def test_no_secret_is_returned_logged_or_left_in_a_job_or_event(self):
        res = self.put('llm', endpoint='https://a.example.com/v1', model='m', apiKey=K['workspace'])
        for body in (res.content, self.c.get(self.url()).content):
            self.assertNotIn(K['workspace'].encode(), body)
        with connection.cursor() as cur:
            cur.execute("SELECT encode(api_key_encrypted, 'escape') FROM integrations_aiprofile")
            self.assertNotIn(K['workspace'], json.dumps(cur.fetchall()))
        self.assertNotIn(K['workspace'], json.dumps(list(CredentialEvent.objects.values_list('detail', 'last_four'))))

    def test_profile_events_are_recorded_without_secrets(self):
        self.put('search', endpoint='https://s.example.com/v1', model='sm', apiKey=K['other'])
        self.c.delete(self.url('/search'))
        ev = list(CredentialEvent.objects.order_by('created_at').values_list('kind', 'action', 'detail'))
        self.assertEqual([(k, a) for k, a, _ in ev], [('ai_profile', 'set'), ('ai_profile', 'removed')])
        self.assertEqual(ev[0][2]['profile'], 'search')
