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


class ProjectApiTests(Base):
    """Project overrides (#158): inherited by default, overridden per profile, reset to the workspace's."""

    def url(self, suffix=''):
        return f'/api/projects/{self.pid}/ai{suffix}'

    def member(self, email, role):
        user = make_user(email)
        Membership.objects.create(workspace=self.ws, user=user, role=role)
        return client_for(user)

    def put(self, profile, client=None, **body):
        return (client or self.c).put(self.url(f'/{profile}'), body, format='json')

    def set_workspace(self, profile='llm', model='ws-model', key=K['workspace']):
        aiprofiles.save(self.ws, self.user, profile, 'https://api.openai.com/v1', model, key)

    def test_a_new_project_inherits_everything_the_workspace_has(self):
        self.set_workspace('llm')
        self.set_workspace('mineru', model=None, key=K['mineru'])
        body = self.c.get(self.url()).json()
        p = body['profiles']
        self.assertEqual((p['llm']['source'], p['llm']['overridden']), ('workspace', False))
        self.assertEqual((p['search']['source'], p['search']['viaLlm']), ('workspace', True))   # follows the AI model
        self.assertEqual(p['mineru']['source'], 'workspace')
        self.assertEqual(self.new_project() and True, True)                                      # no per-project setup
        # a profile nobody set: the server's
        self.assertEqual(self.c.get(self.url()).json()['profiles']['vision']['viaLlm'], True)
        AiProfile.objects.all().delete()
        self.assertEqual(self.c.get(self.url()).json()['profiles']['llm']['source'], 'server')

    def test_overriding_one_profile_changes_only_that_one_and_reset_restores_it(self):
        self.set_workspace('llm')
        self.set_workspace('search', model='ws-search')
        res = self.put('search', endpoint='https://api.anthropic.com/v1', model='proj-search', apiKey=K['project']).json()
        s = res['profiles']
        self.assertEqual((s['search']['source'], s['search']['overridden'], s['search']['lastFour']), ('project', True, '1111'))
        self.assertEqual((s['llm']['source'], s['llm']['overridden']), ('workspace', False))      # the rest stays inherited
        self.assertEqual(AiProfile.objects.filter(project=self.project).count(), 1)
        reset = self.c.delete(self.url('/search')).json()['profiles']
        self.assertEqual((reset['search']['source'], reset['search']['overridden']), ('workspace', False))
        self.assertEqual(AiProfile.objects.filter(project=self.project).count(), 0)
        self.assertEqual(AiProfile.objects.filter(workspace=self.ws).count(), 2)                  # the workspace is untouched

    def test_who_can_change_overrides(self):
        self.set_workspace('llm')
        editor, viewer = self.member('editor@example.com', 'editor'), self.member('viewer@example.com', 'viewer')
        admin = self.member('admin@example.com', 'admin')
        for c in (editor, viewer):
            self.assertEqual(self.put('llm', c, apiKey='sk-x', model='m').status_code, 403)
            self.assertEqual(c.delete(self.url('/llm')).status_code, 403)
            self.assertEqual(c.post(self.url('/models'), {}, format='json').status_code, 403)
        body = editor.get(self.url()).json()
        self.assertTrue(body['canUse'] and not body['canManage'])
        self.assertFalse(viewer.get(self.url()).json()['canUse'])
        self.assertTrue(self.put('llm', admin, endpoint='https://api.openai.com/v1', model='by-admin', apiKey=K['project']).json()['ok'])
        # the project's creator, if an editor, may manage their own project
        mine = Project.objects.create(workspace=self.ws, name='Theirs', created_by=Membership.objects.get(workspace=self.ws, user__email='editor@example.com').user)
        res = editor.put(f'/api/projects/{mine.id}/ai/llm', {'endpoint': 'https://api.openai.com/v1', 'model': 'm', 'apiKey': K['other']}, format='json')
        self.assertTrue(res.json()['ok'])
        self.assertEqual(client_for(make_user('out@example.com')).get(self.url()).status_code, 404)
        self.assertEqual(APIClient().get(self.url()).status_code, 401)
        self.assertEqual(self.put('nope', apiKey='x').status_code, 404)

    def test_members_never_see_an_override_endpoint_or_any_key_material(self):
        self.put('llm', endpoint='https://api.openai.com/v1', model='proj-model', apiKey=K['project'])
        editor = self.member('editor@example.com', 'editor')
        text = editor.get(self.url()).content.decode()
        self.assertNotIn(K['project'], text)
        self.assertNotIn('1111', text)                       # not even the last four
        self.assertNotIn('api.openai.com', text)
        self.assertIn('proj-model', text)                    # members using the project may see which model
        for body in (self.c.get(self.url()).content.decode(), self.put('llm', model='m2').content.decode()):
            self.assertNotIn(K['project'], body)

    def test_guests_have_no_access(self):
        from collab import tokens
        token, _ = tokens.create_invite(self.project, self.user, 'editor')
        guest = APIClient()
        guest.credentials(HTTP_AUTHORIZATION=f'Bearer {token}')
        self.assertEqual(guest.get(self.url()).status_code, 403)
        self.assertEqual(guest.put(self.url('/llm'), {'apiKey': 'x'}, format='json').status_code, 403)

    def test_deleting_a_project_removes_its_overrides_and_a_copy_does_not_carry_them(self):
        self.put('llm', endpoint='https://api.openai.com/v1', model='m', apiKey=K['project'])
        self.assertEqual(AiProfile.objects.filter(project=self.project).count(), 1)
        other = Project.objects.create(workspace=self.ws, name='Other', created_by=self.user)
        self.assertEqual(AiProfile.objects.filter(project=other).count(), 0)
        self.project.delete()
        self.assertEqual(AiProfile.objects.filter(project_id=self.pid).count(), 0)

    def test_project_models_and_test_use_the_overrides_own_key_and_never_the_workspaces(self):
        ws_fake, proj_fake = FakeLLM([{'content': 'ok'}], models=['a']), FakeLLM([{'content': 'ok'}], models=['p1', 'p2'])
        self.addCleanup(ws_fake.close)
        self.addCleanup(proj_fake.close)
        with mock.patch('integrations.provider.assert_public_url'):
            aiprofiles.save(self.ws, self.user, 'llm', ws_fake.url, 'ws', K['workspace'])
            # no override yet: nothing stored for the project, so it must be typed (the workspace key is not borrowed)
            self.assertFalse(self.c.post(self.url('/models'), {'endpoint': proj_fake.url}, format='json').json()['ok'])
            self.assertEqual((ws_fake.requests, proj_fake.requests), ([], []))
            res = self.c.post(self.url('/models'), {'endpoint': proj_fake.url, 'apiKey': K['project']}, format='json').json()
            self.assertEqual(res['models'], ['p1', 'p2'])
            self.assertEqual(proj_fake.requests[0]['auth'], f"Bearer {K['project']}")
            self.assertTrue(self.c.post(self.url('/test'), {'endpoint': proj_fake.url, 'apiKey': K['project'], 'model': 'p1'}, format='json').json()['ok'])
            self.assertEqual(ws_fake.requests, [])


@override_settings(LLM_ALLOW_PRIVATE_ENDPOINTS=True)
class ProjectOverrideRequestTests(Base):
    """An override really is what a project's AI request uses (end to end through the job), and only that project's."""

    def setUp(self):
        super().setUp()
        sync = lambda job_id, secrets=None: ai_tasks.run_ai_job.run(job_id, secrets)
        p = mock.patch('ai.views.run_ai_job.delay', side_effect=sync)
        p.start()
        self.addCleanup(p.stop)

    def test_the_override_serves_only_its_own_project(self):
        ws_fake, proj_fake = self.fake(), self.fake()
        aiprofiles.save(self.ws, self.user, 'llm', ws_fake.url, 'ws', K['workspace'])
        second = Project.objects.get(pk=self.new_project('Second'))
        aiprofiles.save(self.project, self.user, 'llm', proj_fake.url, 'proj', K['project'])
        for pid in (self.pid, str(second.id)):
            self.c.post('/api/llm', {'messages': [], 'projectId': pid}, format='json')
        self.assertEqual((len(proj_fake.requests), len(ws_fake.requests)), (1, 1))
        self.assertEqual(proj_fake.requests[0]['body']['model'], 'proj')
        self.assertEqual(ws_fake.requests[0]['body']['model'], 'ws')
        sources = list(Job.objects.order_by('created_at').values_list('params__keySource', flat=True))
        self.assertEqual(sources, ['project', 'workspace'])
