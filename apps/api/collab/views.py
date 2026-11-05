"""Collaboration REST endpoints (port of routes/collab.js)."""
import time
import uuid

import redis
from django.conf import settings
from django.utils import timezone
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from projects.access import get_project

from . import coord, store, tokens
from .auth import IsUserOrGuest

FLUSH_WAIT_SECONDS = 5
EVICT_WAIT_SECONDS = 3


def _redis():
    return redis.Redis.from_url(settings.REDIS_URL)


@api_view(['POST'])
def create_invite(request, pk):
    """Signed-in members with write access can invite others as editors or viewers (default editor)."""
    project = get_project(request, pk, write=True)
    b = request.data if isinstance(request.data, dict) else {}
    try:
        token, invite = tokens.create_invite(project, request.user, b.get('role') or 'editor', b.get('ttlSeconds'))
    except ValueError as exc:
        return Response({'ok': False, 'error': str(exc)}, status=400)
    return Response({'ok': True, 'token': token, 'role': invite.role, 'expiresAt': invite.expires_at.isoformat()})


def invite_json(invite):
    by = invite.created_by
    return {'id': str(invite.id), 'role': invite.role, 'createdBy': (by.name or by.email) if by else None,
            'createdAt': invite.created_at.isoformat().replace('+00:00', 'Z'),
            'expiresAt': invite.expires_at.isoformat().replace('+00:00', 'Z')}


@api_view(['GET'])
def list_invites(request, pk):
    """Outstanding (unexpired) invite links of a project. Never the token: it is shown once, at creation."""
    project = get_project(request, pk, write=True)
    invites = project.invites.filter(expires_at__gt=timezone.now()).select_related('created_by').order_by('-created_at')
    return Response({'ok': True, 'invites': [invite_json(i) for i in invites]})


@api_view(['DELETE'])
def revoke_invite(request, pk, invite_id):
    """Revoke a link: its REST requests fail from now on, and its live connections are closed on every replica."""
    project = get_project(request, pk, write=True)
    deleted, _ = project.invites.filter(pk=invite_id).delete()
    if not deleted:
        return Response({'ok': False, 'error': 'Invite link not found.'}, status=404)
    _redis().publish(coord.project_channel(project.id),
                     coord.pack(coord.KIND_REVOKE, b'\x00' * coord.ORIGIN_LEN, str(invite_id).encode()))
    return Response({'ok': True})


@api_view(['POST'])
@authentication_classes([])
@permission_classes([AllowAny])
def resolve(request):
    """Used by the invite page before it has any credentials. POST {token}: the invite token is a full credential, so
    it never travels in an API URL (only in the link people share)."""
    invite = tokens.lookup((request.data or {}).get('token') if isinstance(request.data, dict) else None)
    if invite is None:
        return Response({'ok': False, 'error': 'Invalid token'}, status=401)
    return Response({'ok': True, 'projectId': str(invite.project_id), 'projectName': invite.project.name, 'role': invite.role})


def live_room(project, path):
    """True when some replica currently holds a live room for this file (REST writes to it would be overwritten)."""
    key = coord.room_key(project.id, path)
    return bool(_redis().zrangebyscore(coord.holders_key(key), coord.fresh_since(), '+inf'))


def evict_idle_room(project, path, wait=EVICT_WAIT_SECONDS):
    """Ask every replica holding this file's room to drop it if nobody is connected (it flushes first). A room with no
    clients lingers COLLAB_ROOM_EVICT_SECONDS and would keep serving its old text, so a write behind its back (restore)
    needs it gone. True when no room remains; False when someone is still connected."""
    key = coord.room_key(project.id, path)
    r = _redis()
    if not r.zrangebyscore(coord.holders_key(key), coord.fresh_since(), '+inf'):
        return True
    r.publish(coord.channel(key), coord.pack(coord.KIND_EVICT, b'\x00' * coord.ORIGIN_LEN))
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        if not live_room(project, path):
            return True
        time.sleep(0.1)
    return False


def flush_room(project, path):
    """Ask every replica holding the room to persist it; False if one did not answer in time. No room: nothing to do."""
    key = coord.room_key(project.id, path)
    r = _redis()
    holders = r.zrangebyscore(coord.holders_key(key), coord.fresh_since(), '+inf')
    if not holders:
        return True  # no live room: the database is already current
    reply = f'collab:flush-reply:{uuid.uuid4().hex}'
    r.publish(coord.channel(key), coord.pack(coord.KIND_FLUSH, b'\x00' * coord.ORIGIN_LEN, reply.encode()))
    deadline, acks = time.monotonic() + FLUSH_WAIT_SECONDS, 0
    while acks < len(holders) and time.monotonic() < deadline:
        if r.blpop(reply, timeout=max(1, int(deadline - time.monotonic()))) is None:
            break
        acks += 1
    r.delete(reply)
    return acks >= len(holders)


@api_view(['POST'])
@permission_classes([IsUserOrGuest])
def flush(request, pk):
    """Persist the live document now. Returns after every replica holding the room has flushed (bounded wait)."""
    project = get_project(request, pk, write=True)
    path = (request.data or {}).get('path')
    if not path:
        return Response({'ok': False, 'error': 'Missing path'})
    if not flush_room(project, path):
        return Response({'ok': False, 'error': 'Timed out waiting for the collaboration server to save.'}, status=504)
    return Response({'ok': True})


@api_view(['GET'])
@permission_classes([IsUserOrGuest])
def status(request, pk):
    project = get_project(request, pk)
    path = request.query_params.get('path')
    if not path:
        return Response({'ok': False, 'error': 'Missing path'})
    key = coord.room_key(project.id, path)
    r = _redis()
    if not r.zrangebyscore(coord.holders_key(key), coord.fresh_since(), '+inf'):
        return Response({'ok': True, 'diagnostics': None})
    conns = sum(int(v) for v in r.hvals(coord.conns_key(key)))
    error = r.get(coord.error_key(key))
    return Response({'ok': True, 'diagnostics': {'conns': conns, 'lastError': error.decode() if error else None}})
