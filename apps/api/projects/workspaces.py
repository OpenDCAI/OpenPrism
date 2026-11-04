"""Workspaces, members and invitations. Response shapes follow design/workspace.tsx so the UI needs no mapping."""
import hashlib
from datetime import timedelta
from urllib.parse import urlencode

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.response import Response

from .models import Membership, Project, Workspace, WorkspaceInvite

User = get_user_model()
PALETTE = ['#1f5fa3', '#1f7a8c', '#7a6a1f', '#8a4fa8', '#2f7d5b', '#a8563b']
PERSONAL_COLOR = '#5b6573'


def user_color(user_id):
    """Stable avatar colour derived from the id (accounts have none)."""
    return PALETTE[int(hashlib.md5(str(user_id).encode()).hexdigest(), 16) % len(PALETTE)]


def invite_id(email):
    return f'invite-{email}'


RESEND_AFTER = timedelta(minutes=10)  # an invitation mail can be sent again this long after the last one


def iso(dt):
    return dt.isoformat().replace('+00:00', 'Z') if dt else None


def _inviter(user):
    return user.name or user.email


def mail_invitation(invite, inviter):
    """Mail an address with no account: a sign-up link with the address filled in. Joining waits for verification."""
    from accounts import mail
    invite.last_sent_at = timezone.now()
    invite.save(update_fields=['last_sent_at'])
    link = mail.app_link('/register?' + urlencode({'email': invite.email, 'invited': '1'}))
    mail.send_template(invite.email, 'workspace_invite', {
        'inviter': _inviter(inviter), 'workspace': invite.workspace.name, 'role': invite.role, 'link': link}, invite_id=invite.pk)


def fail(message, status=400):
    return Response({'ok': False, 'error': message}, status=status)


def serialize(workspace):
    members, users = [], {}
    for m in workspace.memberships.select_related('user').order_by('id'):
        members.append({'userId': str(m.user_id), 'role': m.role.capitalize()})
        users[str(m.user_id)] = {'id': str(m.user_id), 'name': m.user.name or m.user.email.split('@')[0],
                                 'email': m.user.email, 'color': user_color(m.user_id)}
    for inv in workspace.invites.order_by('id'):
        uid = invite_id(inv.email)
        members.append({'userId': uid, 'role': inv.role.capitalize(), 'invited': True,
                        'invitedAt': iso(inv.created_at), 'lastSentAt': iso(inv.last_sent_at), 'sendFailed': inv.send_failed})
        users[uid] = {'id': uid, 'name': inv.email, 'email': inv.email, 'color': '#66707b'}
    return {'id': str(workspace.id), 'name': workspace.name, 'kind': workspace.kind.capitalize(),
            'color': workspace.color or PERSONAL_COLOR, 'members': members, 'users': users}


def membership_for(user, workspace_id):
    try:
        return Membership.objects.select_related('workspace').get(workspace_id=workspace_id, user=user)
    except (Membership.DoesNotExist, ValidationError):
        raise NotFound('Workspace not found')  # non-members cannot tell it exists


def require_admin(user, workspace_id):
    membership = membership_for(user, workspace_id)
    if membership.role not in Membership.ADMIN_ROLES:
        raise PermissionDenied('Only workspace owners and admins can do that.')
    return membership


def clean_role(value):
    role = str(value or '').lower()
    return role if role in Membership.ASSIGNABLE else None


def clean_name(request):
    return str((request.data or {}).get('name') or '').strip()[:200]


def _duplicate_name(user, name, exclude=None):
    qs = Workspace.objects.filter(memberships__user=user, name__iexact=name)
    return qs.exclude(pk=exclude).exists() if exclude else qs.exists()


def accept_pending_invites(user):
    """Called when the address is verified: invitations sent to it become memberships. Never at registration alone:
    anyone can register with any address, so only a verified one proves the invitation reached its owner."""
    for inv in WorkspaceInvite.objects.filter(email=user.email.lower()):
        Membership.objects.get_or_create(workspace=inv.workspace, user=user, defaults={'role': inv.role})
        inv.delete()


@api_view(['GET', 'POST'])
def collection(request):
    if request.method == 'GET':
        workspaces = Workspace.objects.filter(memberships__user=request.user).order_by('kind', 'created_at').distinct()
        return Response({'workspaces': [serialize(w) for w in workspaces]})
    name = clean_name(request)
    if not name:
        return fail('Enter a workspace name.')
    if _duplicate_name(request.user, name):
        return fail('You already have a workspace with that name.')
    with transaction.atomic():
        count = Workspace.objects.filter(memberships__user=request.user, kind=Workspace.TEAM).count()
        workspace = Workspace.objects.create(name=name, kind=Workspace.TEAM, color=PALETTE[count % len(PALETTE)])
        Membership.objects.create(workspace=workspace, user=request.user, role=Membership.OWNER)
    return Response({'ok': True, 'workspace': serialize(workspace)}, status=201)


@api_view(['PATCH'])
def detail(request, pk):
    membership = require_admin(request.user, pk)
    name = clean_name(request)
    if not name:
        return fail('Enter a workspace name.')
    if _duplicate_name(request.user, name, exclude=membership.workspace_id):
        return fail('You already have a workspace with that name.')
    membership.workspace.name = name
    membership.workspace.save(update_fields=['name'])
    return Response({'ok': True, 'workspace': serialize(membership.workspace)})


@api_view(['POST'])
def leave(request, pk):
    membership = membership_for(request.user, pk)
    workspace = membership.workspace
    if workspace.kind == Workspace.PERSONAL:
        return fail('You cannot leave your personal workspace.')
    if membership.role == Membership.OWNER and not workspace.memberships.filter(role=Membership.OWNER).exclude(pk=membership.pk).exists():
        return fail('You are the only owner. Make someone else an owner or delete the workspace first.')
    membership.delete()
    return Response({'ok': True})


@api_view(['POST'])
def invite_member(request, pk):
    membership = require_admin(request.user, pk)
    workspace = membership.workspace
    b = request.data if isinstance(request.data, dict) else {}
    email = str(b.get('email') or '').strip().lower()
    role = clean_role(b.get('role') or 'editor')
    if '@' not in email or len(email) > 254:
        return fail('Enter a full email address, like name@university.edu.')
    if role is None:
        return fail('Role must be admin, editor, commenter or viewer.')
    if membership.role == Membership.ADMIN and role == Membership.ADMIN:
        return fail('Only owners can add admins.', 403)
    existing = User.objects.filter(email=email).first()
    if existing:
        _, created = Membership.objects.get_or_create(workspace=workspace, user=existing, defaults={'role': role})
        if not created:
            return fail('That person is already in this workspace.', 409)
        from accounts import mail
        mail.send_template(existing.email, 'workspace_added', {
            'inviter': _inviter(request.user), 'workspace': workspace.name, 'role': role, 'link': mail.app_link('/projects')})
    else:
        invite, created = WorkspaceInvite.objects.get_or_create(workspace=workspace, email=email,
                                                                defaults={'role': role, 'invited_by': request.user})
        if not created:
            return fail('That person is already invited.', 409)
        mail_invitation(invite, request.user)
    return Response({'ok': True, 'workspace': serialize(workspace)}, status=201)


def _target(workspace, member_id):
    """Resolve a member id from the UI: a user uuid, or `invite-<email>` for a pending invitation."""
    if member_id.startswith('invite-'):
        inv = WorkspaceInvite.objects.filter(workspace=workspace, email=member_id[len('invite-'):]).first()
        return (None, inv) if inv else (None, None)
    try:
        return Membership.objects.filter(workspace=workspace, user_id=member_id).first(), None
    except (ValidationError, ValueError):
        return None, None


@api_view(['PATCH', 'DELETE'])
def member(request, pk, member_id):
    actor = require_admin(request.user, pk)
    workspace = actor.workspace
    target, invite = _target(workspace, member_id)
    if target is None and invite is None:
        return fail('Member not found.', 404)
    if target is not None and target.role == Membership.OWNER:
        return fail('Owners cannot be changed or removed here.', 403)
    if target is not None and target.user_id == request.user.id:
        return fail('Use "Leave workspace" to remove yourself.')
    if actor.role == Membership.ADMIN and target is not None and target.role == Membership.ADMIN:
        return fail('Only owners can change admins.', 403)
    if request.method == 'DELETE':
        (target or invite).delete()
    elif str((request.data or {}).get('role') or '').lower() == Membership.OWNER:
        # Ownership is shared, not moved: an owner makes another member an owner (then may leave or delete their
        # account). Owners cannot be demoted here, so this is only offered to owners and only for real members.
        if actor.role != Membership.OWNER:
            return fail('Only owners can make someone an owner.', 403)
        if target is None:
            return fail('Invite them first: only members can become owners.')
        target.role = Membership.OWNER
        target.save(update_fields=['role'])
    else:
        role = clean_role((request.data or {}).get('role'))
        if role is None:
            return fail('Role must be admin, editor, commenter or viewer.')
        if actor.role == Membership.ADMIN and role == Membership.ADMIN:
            return fail('Only owners can add admins.', 403)
        row = target or invite
        row.role = role
        row.save(update_fields=['role'])
    return Response({'ok': True, 'workspace': serialize(workspace)})


@api_view(['POST'])
def resend_invite(request, pk, member_id):
    """Send a pending invitation's mail again (owners/admins; at most once per RESEND_AFTER)."""
    workspace = require_admin(request.user, pk).workspace
    _, invite = _target(workspace, member_id)
    if invite is None:
        return fail('Invitation not found.', 404)
    if invite.last_sent_at and timezone.now() - invite.last_sent_at < RESEND_AFTER:
        return fail('The invitation was sent a few minutes ago. Try again later.', 429)
    mail_invitation(invite, request.user)
    return Response({'ok': True, 'workspace': serialize(workspace)})


@api_view(['PATCH'])
def move_project(request, pk):
    """Move a project to another workspace the caller can write to."""
    from .access import get_project
    project = get_project(request, pk, write=True)
    target_id = (request.data or {}).get('workspaceId')
    target = Membership.objects.filter(workspace_id=target_id, user=request.user, role__in=Membership.WRITE_ROLES).first() \
        if target_id else None
    if target is None:
        return fail('Choose a workspace you can edit.', 403)
    Project.objects.filter(pk=project.pk).update(workspace_id=target.workspace_id)
    project.refresh_from_db()
    from .views import project_meta
    return Response({'ok': True, 'project': project_meta(project)})
