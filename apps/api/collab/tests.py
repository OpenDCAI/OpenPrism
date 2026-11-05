import asyncio
import json
from datetime import timedelta
from unittest import mock

from asgiref.sync import sync_to_async
from channels.db import database_sync_to_async
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.test import TransactionTestCase, override_settings
from django.utils import timezone
from pycrdt import (Awareness, Doc, Text, YMessageType, create_awareness_message, create_sync_message,
                    create_update_message, handle_sync_message, read_message)
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from accounts.serializers import RegisterSerializer
from projects import files
from projects.models import Membership, Project
from projects.test_api import client_for, make_user

from . import coord, tokens
from .models import CollabDoc, CollabInvite
from .rooms import RoomManager
from .routing import websocket_urlpatterns

FAST = dict(COLLAB_FLUSH_DEBOUNCE_MS=30, COLLAB_ROOM_EVICT_SECONDS=0.15, COLLAB_SYNC_INTERVAL_SECONDS=30)


def app_for(manager):
    """The websocket app, with a specific RoomManager injected (tests use several to simulate replicas)."""
    inner = URLRouter(websocket_urlpatterns)

    async def app(scope, receive, send):
        scope['collab_manager'] = manager
        await inner(scope, receive, send)
    return app


class Client:
    """A y-websocket client built on pycrdt that follows the same protocol as apps/frontend/src/collab/provider.ts."""

    def __init__(self, manager, project_id, path, token, name='anon'):
        self.doc = Doc()
        self.text = self.doc.get('content', type=Text)
        self.awareness = Awareness(self.doc)
        self.awareness.set_local_state_field('user', {'name': name})
        self.outgoing, self.applying, self.close = [], False, None
        self.doc.observe(self._on_doc)
        self.awareness.observe(self._on_awareness)
        url = f'/api/collab?projectId={project_id}&file={path}&token={token}'
        self.comm = WebsocketCommunicator(app_for(manager), url)

    def _on_doc(self, event):
        if not self.applying:
            self.outgoing.append(create_update_message(event.update))

    def _on_awareness(self, topic, payload):
        changes, origin = payload
        if topic == 'update' and origin != 'remote':
            ids = changes['added'] + changes['updated'] + changes['removed']
            self.outgoing.append(create_awareness_message(self.awareness.encode_awareness_update(ids)))

    async def connect(self):
        connected, _ = await self.comm.connect()
        assert connected
        await self.comm.send_to(bytes_data=create_sync_message(self.doc))  # step 1, as on ws.onopen
        self.awareness.set_local_state(self.awareness.get_local_state())   # re-announce our cursor, as on ws.onopen
        return self

    async def pump(self, quiet=0.15, rounds=40):
        """Exchange messages until the connection is quiet. Returns the close code if the server closed."""
        for _ in range(rounds):
            while self.outgoing:
                await self.comm.send_to(bytes_data=self.outgoing.pop(0))
            if await self.comm.receive_nothing(timeout=quiet):
                if not self.outgoing:
                    return self.close
                continue
            out = await self.comm.receive_output()
            if out['type'] == 'websocket.close':
                self.close = (out['code'], out.get('reason', ''))
                return self.close
            self._handle(out['bytes'])
        return self.close

    def _handle(self, data):
        if data[0] == YMessageType.SYNC:
            self.applying = True
            try:
                reply = handle_sync_message(data[1:], self.doc)
            finally:
                self.applying = False
            if reply:
                self.outgoing.append(reply)
        elif data[0] == YMessageType.AWARENESS:
            self.awareness.apply_awareness_update(read_message(data[1:]), 'remote')

    def insert(self, pos, s):
        self.text.insert(pos, s)

    def peers(self):
        return sorted(st.get('user', {}).get('name') for cid, st in self.awareness.states.items()
                      if cid != self.doc.client_id and st)

    async def disconnect(self):
        await self.comm.disconnect()


def url_token_for(credential, project_id):
    """The websocket takes a URL token (common.urltokens), as the browser mints with POST /api/url-token. Tests name the
    person by their invite token or access token; this mints for them. Anything else is passed through as is."""
    from common import urltokens
    from rest_framework_simplejwt.tokens import AccessToken
    from .auth import GuestUser
    if credential.startswith(tokens.PREFIX):
        invite = CollabInvite.objects.filter(token_hash=tokens.hash_token(credential)).first()
        return urltokens.mint(GuestUser(invite), urltokens.PROJECT, project_id)[0] if invite else credential
    try:
        user_id = AccessToken(credential)['user_id']
    except Exception:
        return credential
    from django.contrib.auth import get_user_model
    return urltokens.mint(get_user_model().objects.get(pk=user_id), urltokens.PROJECT, project_id)[0]


async def settle(*clients, rounds=3):
    for _ in range(rounds):
        for c in clients:
            await c.pump()


@override_settings(**FAST)
class CollabTestBase(TransactionTestCase):
    def setUp(self):
        self.user = make_user('owner@example.com')
        self.workspace = self.user.memberships.first().workspace
        self.project = Project.objects.create(workspace=self.workspace, name='Collab')
        self.pid = str(self.project.id)
        self.editor_token, _ = tokens.create_invite(self.project, self.user, 'editor')
        self.viewer_token, _ = tokens.create_invite(self.project, self.user, 'viewer')
        self.managers = []
        self.addCleanup(files.delete_project_files, self.project)

    def manager(self):
        m = RoomManager()
        self.managers.append(m)
        return m

    async def asyncTearDown(self):
        for m in self.managers:
            await m.close_all()

    async def db(self, fn, *args, **kwargs):
        return await database_sync_to_async(fn)(*args, **kwargs)

    async def jwt(self, user):
        return await self.db(lambda: str(RefreshToken.for_user(user).access_token))  # issuing a token writes to the blacklist table

    def file_text(self, path='main.tex'):
        return files.read_text(self.project, path)

    async def join(self, manager, token=None, path='main.tex', name='anon', project=None, raw=False):
        project = project or self.pid
        token = token or self.editor_token
        if not raw:
            token = await self.db(url_token_for, token, project)
        return await Client(manager, project, path, token, name).connect()


class SyncTests(CollabTestBase):
    async def test_clients_sync_converge_and_persist(self):
        m = self.manager()
        a, b = await self.join(m, name='alice'), None
        a.insert(0, 'Hello')
        await settle(a)
        b = await self.join(m, name='bob')
        await settle(a, b)
        self.assertEqual(str(b.text), 'Hello')                                   # late joiner gets existing content
        a.insert(0, '>> ')
        b.insert(len(str(b.text)), ' world')                                      # concurrent edits
        await settle(a, b)
        self.assertEqual(str(a.text), str(b.text))
        self.assertEqual(str(a.text), '>> Hello world')
        await asyncio.sleep(0.2)                                                  # debounce
        self.assertEqual(await self.db(self.file_text), '>> Hello world')         # projected into the project file
        self.assertTrue(await self.db(CollabDoc.objects.filter(project=self.project, path='main.tex').exists))
        await a.disconnect(), await b.disconnect()

    async def test_awareness_shared_and_removed_on_disconnect(self):
        m = self.manager()
        a, b = await self.join(m, name='alice'), await self.join(m, name='bob')
        await settle(a, b)
        self.assertEqual((a.peers(), b.peers()), (['bob'], ['alice']))
        await a.disconnect()
        await settle(b)
        self.assertEqual(b.peers(), [])                                           # alice's cursor disappears
        await b.disconnect()

    async def test_malformed_messages_do_not_break_the_room(self):
        m = self.manager()
        a, b = await self.join(m, name='a'), await self.join(m, name='b')
        for junk in (b'', b'\x00', b'\x00\x02\xff\xff\xff', b'\x01\x05\x01', b'\x09zzz'):
            await a.comm.send_input({'type': 'websocket.receive', 'bytes': junk})
        a.insert(0, 'still works')
        await settle(a, b)
        self.assertEqual(str(b.text), 'still works')
        await a.disconnect(), await b.disconnect()

    async def test_state_survives_room_eviction_and_external_edits_are_reconciled(self):
        m = self.manager()
        a = await self.join(m)
        a.insert(0, 'first session')
        await settle(a)
        await a.disconnect()
        await asyncio.sleep(0.6)                                                  # room evicts (final flush) once idle
        self.assertEqual(m.rooms, {})
        b = await self.join(m)
        await settle(b)
        self.assertEqual(str(b.text), 'first session')                            # restored from the stored Yjs state
        await b.disconnect()
        await asyncio.sleep(0.5)
        await self.db(files.write_text, self.project, 'main.tex', 'edited via REST while nobody was connected')
        c = await self.join(m)
        await settle(c)
        self.assertEqual(str(c.text), 'edited via REST while nobody was connected')  # file wins, applied as a normal edit
        c.insert(0, '[c] ')
        await settle(c)
        await asyncio.sleep(0.2)
        self.assertEqual(await self.db(self.file_text), '[c] edited via REST while nobody was connected')
        await c.disconnect()

    async def test_existing_file_text_seeds_the_document(self):
        await self.db(files.write_text, self.project, 'intro.tex', 'already here')
        m = self.manager()
        a = await self.join(m, path='intro.tex')
        await settle(a)
        self.assertEqual(str(a.text), 'already here')
        await a.disconnect()

    async def test_new_file_is_created_on_first_flush(self):
        m = self.manager()
        a = await self.join(m, path='new/notes.md')
        a.insert(0, 'brand new')
        await settle(a)
        await asyncio.sleep(0.2)
        self.assertEqual(await self.db(self.file_text, 'new/notes.md'), 'brand new')
        await a.disconnect()


class AuthTests(CollabTestBase):
    async def closes_with(self, manager, raw=False, **kw):
        project, token = kw.pop('project', self.pid), kw.pop('token', self.editor_token)
        if not raw and token:
            token = await self.db(url_token_for, token, project)
        c = Client(manager, project, kw.pop('path', 'main.tex'), token)
        connected, _ = await c.comm.connect()
        self.assertTrue(connected)
        out = await c.comm.receive_output()
        self.assertEqual(out['type'], 'websocket.close')
        return out['code']

    async def test_rejections(self):
        m = self.manager()
        other = await self.db(make_user, 'stranger@example.com')
        stranger_jwt = await self.jwt(other)
        other_project = await self.db(Project.objects.create, workspace=self.workspace, name='Other')
        wrong_token, _ = await self.db(tokens.create_invite, other_project, self.user, 'editor')
        expired_token, invite = await self.db(tokens.create_invite, self.project, self.user, 'editor')
        await self.db(CollabInvite.objects.filter(pk=invite.pk).update, expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(await self.closes_with(m, token=''), 1008)                       # no credentials
        self.assertEqual(await self.closes_with(m, token='op2.not-a-real-token'), 1008)
        self.assertEqual(await self.closes_with(m, token='garbage'), 1008)
        self.assertEqual(await self.closes_with(m, token=expired_token), 1008)            # expired invite
        self.assertEqual(await self.closes_with(m, token=wrong_token), 1008)              # invite for another project
        self.assertEqual(await self.closes_with(m, token=stranger_jwt), 1008)             # account without membership
        self.assertEqual(await self.closes_with(m, path='../escape.tex'), 1008)
        self.assertEqual(await self.closes_with(m, path='figs/a.png'), 1003)              # binary files are not collaborative
        self.assertEqual(await self.closes_with(m, project='00000000-0000-0000-0000-000000000000'), 1008)
        self.assertEqual(await self.closes_with(m, project='not-a-uuid'), 1008)
        self.assertEqual(m.rooms, {})                                                      # rejected clients never create rooms

    async def test_only_url_tokens_for_this_project_are_accepted(self):
        from common import urltokens
        m = self.manager()
        # full credentials in the URL are refused, even valid ones
        self.assertEqual(await self.closes_with(m, token=self.editor_token, raw=True), 1008)
        self.assertEqual(await self.closes_with(m, token=await self.jwt(self.user), raw=True), 1008)
        other = await self.db(Project.objects.create, workspace=self.workspace, name='Other')
        for_other = await self.db(lambda: urltokens.mint(self.user, urltokens.PROJECT, other.id)[0])
        self.assertEqual(await self.closes_with(m, token=for_other, raw=True), 1008)      # minted for another project
        for_import = await self.db(lambda: urltokens.mint(self.user, urltokens.IMPORT)[0])
        self.assertEqual(await self.closes_with(m, token=for_import, raw=True), 1008)     # wrong scope
        with override_settings(URL_TOKEN_SECONDS=1):
            stale = await self.db(lambda: urltokens.mint(self.user, urltokens.PROJECT, self.pid)[0])
            await asyncio.sleep(3.5)  # margin: the dev clock can step back about a second
            self.assertEqual(await self.closes_with(m, token=stale, raw=True), 1008)      # expired
        fresh = await self.db(lambda: urltokens.mint(self.user, urltokens.PROJECT, self.pid)[0])
        await self.db(Membership.objects.filter(user=self.user).delete)
        self.assertEqual(await self.closes_with(m, token=fresh, raw=True), 1008)          # removed after minting

    async def test_member_jwt_is_accepted(self):
        m = self.manager()
        a = await self.join(m, token=await self.jwt(self.user))
        a.insert(0, 'by owner')
        await settle(a)
        self.assertIsNone(a.close)
        await asyncio.sleep(0.2)
        self.assertEqual(await self.db(self.file_text), 'by owner')
        await a.disconnect()

    async def test_viewers_read_but_cannot_write(self):
        m = self.manager()
        editor, viewer = await self.join(m, name='ed'), await self.join(m, token=self.viewer_token, name='view')
        editor.insert(0, 'secret draft')
        await settle(editor, viewer)
        self.assertEqual(str(viewer.text), 'secret draft')                       # can read live changes
        self.assertEqual(editor.peers(), ['view'])                               # and show up with a cursor
        viewer.insert(0, 'VANDAL ')
        await settle(viewer, editor)
        self.assertEqual(str(editor.text), 'secret draft')                       # the write was ignored
        await asyncio.sleep(0.2)
        self.assertEqual(await self.db(self.file_text), 'secret draft')
        await editor.disconnect(), await viewer.disconnect()

    async def test_viewer_joining_with_local_edits_cannot_push_them(self):
        m = self.manager()
        viewer = Client(m, self.pid, 'main.tex', await self.db(url_token_for, self.viewer_token, self.pid), 'view')
        viewer.insert(0, 'local-only text')                                       # e.g. typed offline before connecting
        viewer.outgoing.clear()
        await viewer.connect()
        await settle(viewer)
        await asyncio.sleep(0.2)
        room = m.rooms[coord.room_key(self.pid, 'main.tex')]
        self.assertEqual(str(room.text), '')                                      # step 2 from a read-only client is dropped
        await viewer.disconnect()


class ReplicaTests(CollabTestBase):
    async def test_updates_and_awareness_cross_replicas(self):
        ma, mb = self.manager(), self.manager()
        a, b = await self.join(ma, name='on-A'), await self.join(mb, name='on-B')
        a.insert(0, 'typed on A')
        await settle(a, b)
        self.assertEqual(str(b.text), 'typed on A')
        b.insert(len(str(b.text)), ', and on B')
        a.insert(0, '* ')
        await settle(a, b)
        self.assertEqual(str(a.text), str(b.text))
        self.assertEqual(str(a.text), '* typed on A, and on B')
        self.assertEqual((a.peers(), b.peers()), (['on-B'], ['on-A']))             # cursors cross replicas
        await a.disconnect()
        await settle(b)
        self.assertEqual(b.peers(), [])
        await b.disconnect()

    @override_settings(COLLAB_FLUSH_DEBOUNCE_MS=60_000)   # nothing reaches the database during this test
    async def test_late_replica_gets_unflushed_edits_and_cursors(self):
        ma, mb = self.manager(), self.manager()
        a = await self.join(ma, name='alice')
        a.insert(0, 'only in replica A memory')
        await settle(a)
        self.assertEqual(await self.db(CollabDoc.objects.filter(project=self.project).count), 1)   # seeded, but empty
        b = await self.join(mb, name='bob')                    # replica B opens the room afterwards
        await settle(a, b)
        self.assertEqual(str(b.text), 'only in replica A memory')
        self.assertEqual(b.peers(), ['alice'])                 # alice's cursor announced before B existed
        self.assertEqual(a.peers(), ['bob'])
        await a.disconnect(), await b.disconnect()

    async def test_racing_replicas_seed_the_document_once(self):
        await self.db(files.write_text, self.project, 'main.tex', 'seed text')
        ma, mb = self.manager(), self.manager()
        ra, rb = await asyncio.gather(ma.get_room(self.pid, 'main.tex'), mb.get_room(self.pid, 'main.tex'))
        self.assertEqual((str(ra.text), str(rb.text)), ('seed text', 'seed text'))
        a, b = await self.join(ma), await self.join(mb)
        await settle(a, b)
        self.assertEqual((str(a.text), str(b.text)), ('seed text', 'seed text'))  # no duplicated content after merging
        await a.disconnect(), await b.disconnect()

    async def test_a_lost_message_is_healed_by_the_next_flush(self):
        ma, mb = self.manager(), self.manager()
        a, b = await self.join(ma), await self.join(mb)
        await settle(a, b)

        async def drop(*args, **kwargs):
            return None
        with mock.patch.object(ma, 'publish', drop):                               # replica A's publishes vanish
            a.insert(0, 'lost on the wire')
            await settle(a)
        await settle(b)
        self.assertEqual(str(b.text), '')                                          # B never heard about it
        await ma.rooms[coord.room_key(self.pid, 'main.tex')].flush()               # A persists…
        await mb.rooms[coord.room_key(self.pid, 'main.tex')].flush()               # …B merges it in its next sync
        await settle(b)
        self.assertEqual(str(b.text), 'lost on the wire')
        self.assertEqual(await self.db(self.file_text), 'lost on the wire')
        await a.disconnect(), await b.disconnect()

    async def test_flush_endpoint_waits_for_every_replica(self):
        ma, mb = self.manager(), self.manager()
        a, b = await self.join(ma), await self.join(mb)
        a.insert(0, 'save me now')
        await settle(a, b)
        api = await self.db(client_for, self.user)
        res = await sync_to_async(api.post, thread_sensitive=False)(f'/api/projects/{self.pid}/collab/flush', {'path': 'main.tex'}, format='json')
        self.assertEqual(res.data, {'ok': True})
        self.assertEqual(await self.db(self.file_text), 'save me now')            # persisted by the time it returned
        status = await sync_to_async(api.get, thread_sensitive=False)(f'/api/projects/{self.pid}/collab/status', {'path': 'main.tex'})
        self.assertEqual(status.data['diagnostics'], {'conns': 2, 'lastError': None})
        await a.disconnect(), await b.disconnect()
        await ma.close_all(), await mb.close_all()
        res = await sync_to_async(api.post, thread_sensitive=False)(f'/api/projects/{self.pid}/collab/flush', {'path': 'main.tex'}, format='json')
        self.assertEqual(res.data, {'ok': True})                                   # nothing live: returns immediately
        none = await sync_to_async(api.get, thread_sensitive=False)(f'/api/projects/{self.pid}/collab/status', {'path': 'main.tex'})
        self.assertIsNone(none.data['diagnostics'])

    async def test_flush_failure_is_reported_in_status(self):
        m = self.manager()
        a = await self.join(m)
        await settle(a)
        with mock.patch('collab.store.flush', side_effect=RuntimeError('disk full')):
            a.insert(0, 'x')
            await settle(a)
            await asyncio.sleep(0.2)
            status = await sync_to_async((await self.db(client_for, self.user)).get, thread_sensitive=False)(f'/api/projects/{self.pid}/collab/status', {'path': 'main.tex'})
        self.assertEqual(status.data['diagnostics']['lastError'], 'disk full')
        await a.disconnect()


class RestTests(CollabTestBase):
    """Invites and the guest credential, over plain HTTP."""

    def setUp(self):
        super().setUp()
        self.owner = client_for(self.user)

    def guest(self, token):
        c = APIClient()
        c.credentials(HTTP_AUTHORIZATION=f'Bearer {token}')
        return c

    def test_invite_create_and_resolve(self):
        res = self.owner.post(f'/api/projects/{self.pid}/collab/invite', {}, format='json')
        self.assertTrue(res.data['ok'])
        self.assertTrue(res.data['token'].startswith('op2.'))
        self.assertEqual(res.data['role'], 'editor')
        resolved = APIClient().post('/api/collab/resolve', {'token': res.data['token']}, format='json')
        self.assertEqual(resolved.data, {'ok': True, 'projectId': self.pid, 'projectName': 'Collab', 'role': 'editor'})
        self.assertEqual(APIClient().post('/api/collab/resolve', {'token': 'op2.nope'}, format='json').status_code, 401)
        self.assertEqual(APIClient().post('/api/collab/resolve', {}, format='json').status_code, 401)
        self.assertEqual(APIClient().get('/api/collab/resolve', {'token': res.data['token']}).status_code, 405)  # not in a URL
        self.assertEqual(self.owner.post(f'/api/projects/{self.pid}/collab/invite', {'role': 'admin'}, format='json').status_code, 400)
        raw = CollabInvite.objects.get(token_hash=tokens.hash_token(res.data['token']))
        self.assertNotIn(res.data['token'], json.dumps(raw.token_hash))             # only the hash is stored
        self.assertEqual(client_for(make_user('x@example.com')).post(f'/api/projects/{self.pid}/collab/invite', {}, format='json').status_code, 404)

    def test_guests_are_confined_to_their_project(self):
        other = Project.objects.create(workspace=self.workspace, name='Private')
        files.write_text(self.project, 'main.tex', 'shared')
        files.write_text(other, 'main.tex', 'private')
        g = self.guest(self.editor_token)
        self.assertEqual(g.get(f'/api/projects/{self.pid}/file', {'path': 'main.tex'}).data['content'], 'shared')
        self.assertEqual(g.get(f'/api/projects/{other.id}/file', {'path': 'main.tex'}).status_code, 404)
        self.assertEqual(g.put(f'/api/projects/{self.pid}/file', {'path': 'a.tex', 'content': 'x'}, format='json').status_code, 200)
        self.assertEqual([p['id'] for p in g.get('/api/projects').data['projects']], [self.pid])   # only their own project
        self.assertEqual(g.post('/api/projects', {'name': 'x'}, format='json').status_code, 403)
        for url in ('/api/templates', '/api/llm'):                                  # account-level endpoints
            self.assertEqual(g.get(url).status_code if url != '/api/llm' else g.post(url, {}, format='json').status_code, 403, url)
        self.assertEqual(g.delete(f'/api/projects/{self.pid}/permanent').status_code, 403)   # destructive project ops
        self.assertEqual(g.post(f'/api/projects/{self.pid}/rename-project', {'name': 'x'}, format='json').status_code, 403)
        self.assertEqual(g.post(f'/api/projects/{self.pid}/collab/invite', {}, format='json').status_code, 403)
        self.assertEqual(self.guest('op2.garbage').get(f'/api/projects/{self.pid}/tree').status_code, 401)

    def test_viewer_guest_is_read_only(self):
        files.write_text(self.project, 'main.tex', 'x')
        g = self.guest(self.viewer_token)
        self.assertEqual(g.get(f'/api/projects/{self.pid}/tree').status_code, 200)
        self.assertEqual(g.put(f'/api/projects/{self.pid}/file', {'path': 'main.tex', 'content': 'y'}, format='json').status_code, 403)
        self.assertEqual(g.post(f'/api/projects/{self.pid}/collab/flush', {'path': 'main.tex'}, format='json').status_code, 403)

    def test_guest_can_compile_and_read_only_its_own_jobs(self):
        files.write_text(self.project, 'main.tex', '\\documentclass{article}')
        g = self.guest(self.editor_token)
        with mock.patch('jobs.views.compile_project.delay'):
            res = g.post('/api/compile', {'projectId': self.pid}, format='json')
        self.assertTrue(res.data['ok'], res.data)
        self.assertEqual(g.get(f"/api/jobs/{res.data['jobId']}").status_code, 200)
        elsewhere = Project.objects.create(workspace=self.workspace, name='Elsewhere')
        files.write_text(elsewhere, 'main.tex', 'x')
        with mock.patch('jobs.views.compile_project.delay'):
            self.assertEqual(g.post('/api/compile', {'projectId': str(elsewhere.id)}, format='json').status_code, 404)
        own = self.owner.post('/api/compile', {'projectId': str(elsewhere.id)}, format='json')
        with mock.patch('jobs.views.compile_project.delay'):
            own = self.owner.post('/api/compile', {'projectId': str(elsewhere.id)}, format='json')
        self.assertEqual(g.get(f"/api/jobs/{own.data['jobId']}").status_code, 404)       # someone else's project's job

    def test_a_guest_mints_url_tokens_for_its_own_project_only(self):
        files.write_binary(self.project, 'a.png', b'\x89PNG')
        g = self.guest(self.viewer_token)
        token = g.post('/api/url-token', {'scope': 'project', 'projectId': self.pid}, format='json').data['token']
        self.assertEqual(APIClient().get(f'/api/projects/{self.pid}/blob', {'path': 'a.png', 'token': token}).status_code, 200)
        other = Project.objects.create(workspace=self.workspace, name='Private')
        self.assertEqual(g.post('/api/url-token', {'scope': 'project', 'projectId': str(other.id)}, format='json').status_code, 404)
        self.assertEqual(g.post('/api/url-token', {'scope': 'import'}, format='json').status_code, 403)
        # the invite token itself is a full credential: never accepted in a URL
        self.assertEqual(APIClient().get(f'/api/projects/{self.pid}/blob', {'path': 'a.png', 'token': self.viewer_token}).status_code, 401)
        self.assertEqual(APIClient().get(f'/api/projects/{self.pid}/blob', {'path': 'a.png', 'token': 'op2.bad'}).status_code, 401)
        # revoking the link stops its URL tokens at once
        CollabInvite.objects.filter(token_hash=tokens.hash_token(self.viewer_token)).delete()
        self.assertEqual(APIClient().get(f'/api/projects/{self.pid}/blob', {'path': 'a.png', 'token': token}).status_code, 401)

    def test_expired_invites_are_cleaned_up_and_unusable(self):
        token, invite = tokens.create_invite(self.project, self.user, 'viewer')
        CollabInvite.objects.filter(pk=invite.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.guest(token).get(f'/api/projects/{self.pid}/tree').status_code, 401)
        from .tasks import cleanup_expired_invites
        self.assertEqual(cleanup_expired_invites(), 1)
        self.assertFalse(CollabInvite.objects.filter(pk=invite.pk).exists())

    def test_rename_and_delete_drop_stale_yjs_state(self):
        files.write_text(self.project, 'a.tex', 'x')
        files.write_text(self.project, 'dir/b.tex', 'y')
        CollabDoc.objects.create(project=self.project, path='a.tex', state=b'')
        CollabDoc.objects.create(project=self.project, path='dir/b.tex', state=b'')
        files.rename(self.project, 'a.tex', 'c.tex')
        self.assertEqual(sorted(CollabDoc.objects.values_list('path', flat=True)), ['dir/b.tex'])
        files.delete(self.project, 'dir')
        self.assertEqual(CollabDoc.objects.count(), 0)


class InviteLinkTests(CollabTestBase):
    def api(self, user=None):
        from projects.test_api import client_for
        return client_for(user or self.user)

    async def wait_closed(self, client, timeout=5):
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            try:
                out = await client.comm.receive_output(timeout=0.5)
            except asyncio.TimeoutError:
                continue
            if out['type'] == 'websocket.close':
                return out['code']
        return None

    def test_list_shows_links_without_their_tokens(self):
        res = self.api().get(f'/api/projects/{self.pid}/collab/invites')
        self.assertEqual(sorted(i['role'] for i in res.data['invites']), ['editor', 'viewer'])
        self.assertTrue(all(set(i) == {'id', 'role', 'createdBy', 'createdAt', 'expiresAt'} for i in res.data['invites']))
        self.assertNotIn('op2.', json.dumps(res.data))
        viewer = make_user('v@example.com')
        Membership.objects.create(workspace=self.workspace, user=viewer, role=Membership.VIEWER)
        self.assertEqual(self.api(viewer).get(f'/api/projects/{self.pid}/collab/invites').status_code, 403)
        guest = APIClient()
        guest.credentials(HTTP_AUTHORIZATION=f'Bearer {self.editor_token}')
        self.assertEqual(guest.get(f'/api/projects/{self.pid}/collab/invites').status_code, 403)  # guests never manage links

    def test_revoked_link_stops_working_for_rest(self):
        invite = tokens.lookup(self.editor_token)
        guest = APIClient()
        guest.credentials(HTTP_AUTHORIZATION=f'Bearer {self.editor_token}')
        self.assertEqual(guest.get(f'/api/projects/{self.pid}/tree').status_code, 200)
        self.assertTrue(self.api().delete(f'/api/projects/{self.pid}/collab/invites/{invite.id}').data['ok'])
        self.assertEqual(guest.get(f'/api/projects/{self.pid}/tree').status_code, 401)
        self.assertEqual(self.api().delete(f'/api/projects/{self.pid}/collab/invites/{invite.id}').status_code, 404)

    async def test_revoking_closes_that_links_live_connections_on_every_replica(self):
        ma, mb = self.manager(), self.manager()
        revoked = await self.join(ma, name='guest-a')                                  # editor link, replica A
        also_revoked = await self.join(mb, name='guest-b')                             # same link, replica B
        member = await self.join(mb, token=await self.jwt(self.user), name='owner')    # an account: unaffected
        viewer = await self.join(ma, token=self.viewer_token, name='viewer')            # another link: unaffected
        await settle(revoked, also_revoked, member, viewer)
        invite = await self.db(tokens.lookup, self.editor_token)
        res = await self.db(lambda: self.api().delete(f'/api/projects/{self.pid}/collab/invites/{invite.id}'))
        self.assertTrue(res.data['ok'])
        self.assertEqual(await self.wait_closed(revoked), 1008)
        self.assertEqual(await self.wait_closed(also_revoked), 1008)
        member.insert(0, 'still here')
        await settle(member, viewer)
        self.assertEqual(str(viewer.text), 'still here')
        await member.disconnect()
        await viewer.disconnect()
