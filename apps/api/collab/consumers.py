"""The /api/collab websocket (y-websocket protocol: type 0 = sync, 1 = awareness)."""
import logging
from urllib.parse import parse_qs

from channels.generic.websocket import AsyncWebsocketConsumer
from django.conf import settings
from django.core.exceptions import ValidationError
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import AccessToken

from projects.models import Membership, Project
from projects.paths import InvalidPath, is_text_file, safe_path

from . import tokens
from .dbasync import db_async
from .rooms import Conn, default_manager

log = logging.getLogger(__name__)


class Reject(Exception):
    def __init__(self, code, reason):
        super().__init__(reason)
        self.code, self.reason = code, reason


@db_async
def authorize(token, project_param, raw_path):
    """Returns (project_id, path, can_write) or raises Reject(close_code, reason)."""
    try:
        path = safe_path(raw_path or '')
    except InvalidPath:
        raise Reject(1008, 'Invalid path')
    if not token:
        raise Reject(1008, 'Unauthorized')
    invite = tokens.lookup(token)
    if invite is not None:
        if project_param and str(invite.project_id) != project_param:
            raise Reject(1008, 'Project mismatch')
        project_id, can_write = str(invite.project_id), invite.role in ('editor', 'admin')
    else:
        try:
            user_id = AccessToken(token)['user_id']
        except (TokenError, KeyError):
            raise Reject(1008, 'Unauthorized')
        if not project_param:
            raise Reject(1008, 'Missing project or file')
        try:
            project = Project.objects.get(pk=project_param)
        except (Project.DoesNotExist, ValidationError):
            raise Reject(1008, 'Project not found')
        membership = Membership.objects.filter(workspace_id=project.workspace_id, user_id=user_id).first()
        if membership is None:
            raise Reject(1008, 'Project not found')  # same answer as a missing project
        if settings.REQUIRE_EMAIL_VERIFICATION and membership.user.email_verified_at is None:
            raise Reject(1008, 'Unauthorized')  # like every other API until the address is verified
        project_id, can_write = str(project.id), membership.role in Membership.WRITE_ROLES
    if not Project.objects.filter(pk=project_id).exists():
        raise Reject(1008, 'Project not found')
    if not is_text_file(path):
        raise Reject(1003, 'Binary file')
    return project_id, path, can_write


class CollabConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.conn = self.room = None
        query = parse_qs(self.scope.get('query_string', b'').decode())
        first = lambda name: (query.get(name) or [''])[0]
        self.manager = self.scope.get('collab_manager') or default_manager
        await self.accept()  # accept first so the browser sees a real close code instead of a failed handshake
        try:
            project_id, path, can_write = await authorize(first('token'), first('projectId'), first('file'))
            self.room = await self.manager.get_room(project_id, path)
        except Reject as exc:
            await self.close(code=exc.code, reason=exc.reason)
            return
        except Exception:
            log.exception('collab connect failed')
            await self.close(code=1011, reason='Server error')
            return
        self.conn = Conn(lambda data: self.send(bytes_data=data), can_write)
        self.room.add_conn(self.conn)

    async def receive(self, text_data=None, bytes_data=None):
        if bytes_data and self.room and self.conn:
            self.room.handle(self.conn, bytes_data)

    async def disconnect(self, code):
        if self.room and self.conn:
            self.room.remove_conn(self.conn)
