"""Collaboration invite tokens: random bearer secrets, stored only as a SHA-256 hash."""
import hashlib
import secrets
from datetime import timedelta

from django.conf import settings
from django.utils import timezone

from .models import CollabInvite

PREFIX = 'op2.'
ROLES = ('editor', 'commenter', 'viewer')  # commenter links read and comment, like viewers who can comment
MAX_TTL_SECONDS = 7 * 24 * 3600


def hash_token(token):
    return hashlib.sha256(token.encode()).hexdigest()


def create_invite(project, user, role='editor', ttl_seconds=None):
    """Returns (raw_token, invite). The raw token is shown once; only its hash is stored."""
    if role not in ROLES:
        raise ValueError('role must be editor, commenter or viewer')
    ttl = min(int(ttl_seconds or settings.COLLAB_INVITE_TTL_SECONDS), MAX_TTL_SECONDS)
    token = PREFIX + secrets.token_urlsafe(32)
    invite = CollabInvite.objects.create(project=project, token_hash=hash_token(token), role=role, created_by=user,
                                         expires_at=timezone.now() + timedelta(seconds=ttl))
    return token, invite


def lookup(token):
    """The unexpired invite for `token`, or None."""
    if not isinstance(token, str) or not token.startswith(PREFIX):
        return None
    return (CollabInvite.objects.select_related('project')
            .filter(token_hash=hash_token(token), expires_at__gt=timezone.now()).first())
