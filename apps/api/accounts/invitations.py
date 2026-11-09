"""Platform invitations (v0.1.2, #83): a superadmin lets one email address register. The only code that touches
PlatformInvite. Only the SHA-256 of a token is stored; the raw token exists in the mailed link and in the return value
of create()/resend(). One live invitation per address: a new one (or a resend) replaces the earlier link."""
import hashlib
import secrets
from datetime import timedelta
from urllib.parse import urlencode

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from . import mail
from .models import PlatformInvite, User

PREFIX = 'pi1.'


class InviteError(Exception):
    """Something that cannot be done; the message is shown to the superadmin."""


def hash_token(raw):
    return hashlib.sha256(str(raw).encode()).hexdigest()


def _new_token():
    return PREFIX + secrets.token_urlsafe(32)


def status(invite, now=None):
    """sent | mail_failed | used | expired | revoked (what the admin lists)."""
    now = now or timezone.now()
    if invite.used_at:
        return 'used'
    if invite.revoked_at:
        return 'revoked'
    if invite.expires_at <= now:
        return 'expired'
    return 'mail_failed' if invite.send_failed else 'sent'


def _mail(invite, raw):
    from projects.workspaces import _inviter
    link = mail.app_link('/register?' + urlencode({'invite': raw, 'email': invite.email}))
    invite.last_sent_at = timezone.now()
    invite.save(update_fields=['last_sent_at'])
    mail.send_template(invite.email, 'platform_invite', {
        'inviter': _inviter(invite.invited_by) if invite.invited_by else 'A superadmin',
        'workspace': invite.workspace.name if invite.workspace else '', 'role': invite.role,
        'link': link, 'days': settings.PLATFORM_INVITE_DAYS}, platform_invite_id=invite.pk)


def _expiry():
    return timezone.now() + timedelta(days=settings.PLATFORM_INVITE_DAYS)


@transaction.atomic
def create(email, invited_by=None, workspace=None, role=None):
    """Invite `email`. Earlier unused invitations for the address stop working. Returns (invite, raw_token)."""
    from django.core.exceptions import ValidationError
    from django.core.validators import validate_email
    from projects.models import Membership
    email = str(email or '').strip().lower()
    try:
        validate_email(email)
    except ValidationError:
        raise InviteError(f'{email or "(empty)"} is not an email address.')
    if User.objects.filter(email=email).exists():
        raise InviteError(f'{email} already has an account.')
    if workspace is not None:
        role = role or Membership.EDITOR
        if role not in Membership.ASSIGNABLE:
            raise InviteError('Choose a role other than owner.')
    else:
        role = ''
    PlatformInvite.objects.filter(email=email, used_at__isnull=True, revoked_at__isnull=True).update(revoked_at=timezone.now())
    raw = _new_token()
    invite = PlatformInvite.objects.create(email=email, token_hash=hash_token(raw), invited_by=invited_by,
                                           expires_at=_expiry(), workspace=workspace, role=role)
    transaction.on_commit(lambda: _mail(invite, raw))
    return invite, raw


@transaction.atomic
def resend(invite):
    """New link, new expiry, mail again; the previous link stops working. Returns the raw token."""
    invite = PlatformInvite.objects.select_for_update().get(pk=invite.pk)
    if invite.used_at:
        raise InviteError(f'{invite.email} has already registered.')
    if User.objects.filter(email=invite.email).exists():
        raise InviteError(f'{invite.email} already has an account.')
    raw = _new_token()
    invite.token_hash, invite.expires_at, invite.revoked_at, invite.send_failed = hash_token(raw), _expiry(), None, False
    invite.save(update_fields=['token_hash', 'expires_at', 'revoked_at', 'send_failed'])
    PlatformInvite.objects.filter(email=invite.email, used_at__isnull=True, revoked_at__isnull=True).exclude(pk=invite.pk) \
        .update(revoked_at=timezone.now())
    transaction.on_commit(lambda: _mail(invite, raw))
    return raw


def revoke(invite):
    if invite.used_at:
        raise InviteError(f'{invite.email} has already registered.')
    if not invite.revoked_at:
        invite.revoked_at = timezone.now()
        invite.save(update_fields=['revoked_at'])


def find_valid(email, raw_token, *, lock=False):
    """The usable invitation for `email` that `raw_token` opens, or None. The same answer for every way of being wrong."""
    email = str(email or '').strip().lower()
    raw_token = str(raw_token or '')
    if not email or not raw_token.startswith(PREFIX):
        return None
    qs = PlatformInvite.objects.filter(token_hash=hash_token(raw_token), email=email, used_at__isnull=True,
                                       revoked_at__isnull=True, expires_at__gt=timezone.now())
    return (qs.select_for_update() if lock else qs).first()


def lock(invite):
    """Inside the registration transaction, before the account exists: lock `invite` and return it if it can still be
    used, else None (someone else just used, revoked or outlived it). Serialises two requests with the same link."""
    return PlatformInvite.objects.select_for_update().filter(
        pk=invite.pk, used_at__isnull=True, revoked_at__isnull=True, expires_at__gt=timezone.now()).first()


def use(invite, user):
    """Mark a locked invitation as used by the account it created."""
    invite.used_at, invite.user = timezone.now(), user
    invite.save(update_fields=['used_at', 'user'])
