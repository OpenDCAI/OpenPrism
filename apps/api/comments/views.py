"""Comment threads on a project's text files.

Who: accounts with a role in COMMENT_ROLES (owner, admin, editor, commenter) and invite-link guests whose link is
`editor` or `commenter` may comment, reply and resolve; viewers (and viewer links) read only. Authors edit or delete
their own comments; people who can write the project may delete any thread. Non-members get 404 (get_project)."""
from django.db import transaction
from django.utils import timezone
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.response import Response

from collab.auth import IsUserOrGuest
from projects import files as pfiles
from projects.access import get_project
from projects.models import Membership
from projects.paths import InvalidPath, is_text_file, safe_path

from . import anchor
from .models import Comment, CommentThread

MAX_BODY = 5000
MAX_QUOTE = 2000


def fail(message, status=400):
    return Response({'ok': False, 'error': message}, status=status)


def iso(dt):
    return dt.isoformat().replace('+00:00', 'Z') if dt else None


def is_guest(user):
    return getattr(user, 'is_guest', False)


def access(request, project):
    """(can_comment, can_moderate) for the caller on `project` (already known to be visible to them)."""
    user = request.user
    if is_guest(user):
        return user.role in ('editor', 'admin', 'commenter'), user.can_write
    role = Membership.objects.filter(workspace_id=project.workspace_id, user=user).values_list('role', flat=True).first()
    return role in Membership.COMMENT_ROLES, role in Membership.WRITE_ROLES


def author_of(request):
    user = request.user
    if is_guest(user):
        return {'author': None, 'guest_invite_id': user.invite_id, 'author_name': 'Guest'}
    return {'author': user, 'guest_invite_id': '', 'author_name': user.name or user.email.split('@')[0]}


def is_mine(request, comment):
    user = request.user
    if is_guest(user):
        return bool(comment.guest_invite_id) and comment.guest_invite_id == user.invite_id
    return comment.author_id is not None and comment.author_id == user.id


def comment_json(request, c):
    return {'id': str(c.id), 'author': c.author_name, 'guest': bool(c.guest_invite_id), 'body': c.body,
            'createdAt': iso(c.created_at), 'editedAt': iso(c.edited_at), 'mine': is_mine(request, c)}


def thread_json(request, t, texts):
    text = texts.get(t.path)
    found = anchor.locate(text, t.quote, t.prefix, t.suffix, t.anchor_from) if text is not None else None
    return {'id': str(t.id), 'path': t.path, 'quote': t.quote, 'prefix': t.prefix, 'suffix': t.suffix,
            'anchor': {'from': found[0], 'to': found[1]} if found else None, 'orphaned': found is None,
            'hint': {'from': t.anchor_from, 'to': t.anchor_to},
            'resolved': t.resolved, 'resolvedBy': t.resolved_by_name or None, 'resolvedAt': iso(t.resolved_at),
            'createdAt': iso(t.created_at), 'comments': [comment_json(request, c) for c in t.comments.all()]}


def _texts(project, paths):
    out = {}
    for path in set(paths):
        try:
            out[path] = pfiles.read_text(project, path)
        except (pfiles.FileNotFound, IsADirectoryError, ValueError):
            out[path] = None
    return out


def _body(request):
    body = str((request.data or {}).get('body') or '').strip()
    if not body:
        return None, 'Write a comment first.'
    if len(body) > MAX_BODY:
        return None, f'Comments are limited to {MAX_BODY} characters.'
    return body, None


def _thread(project, thread_id):
    try:
        return project.comment_threads.get(pk=thread_id)
    except (CommentThread.DoesNotExist, ValueError, Exception):
        raise NotFound('Comment not found')


@api_view(['GET', 'POST'])
@permission_classes([IsUserOrGuest])
def threads(request, pk):
    project = get_project(request, pk)
    can_comment, can_moderate = access(request, project)
    if request.method == 'GET':
        qs = project.comment_threads.prefetch_related('comments').order_by('path', 'anchor_from', 'created_at')
        if request.query_params.get('path'):
            qs = qs.filter(path=request.query_params['path'])
        items = list(qs)
        texts = _texts(project, [t.path for t in items])
        return Response({'ok': True, 'canComment': can_comment, 'canModerate': can_moderate,
                         'threads': [thread_json(request, t, texts) for t in items]})
    if not can_comment:
        raise PermissionDenied('You can read comments here but not write them.')
    b = request.data if isinstance(request.data, dict) else {}
    try:
        path = safe_path(b.get('path'))
    except (InvalidPath, TypeError):
        return fail('Invalid file path.')
    if not is_text_file(path):
        return fail('Comments can only be added to text files.')
    quote = str(b.get('quote') or '')
    if not quote or len(quote) > MAX_QUOTE:
        return fail(f'Select between 1 and {MAX_QUOTE} characters to comment on.')
    try:
        start, end = int(b.get('from')), int(b.get('to'))
    except (TypeError, ValueError):
        return fail('from and to must be numbers.')
    if start < 0 or end - start != len(quote):
        return fail('from/to do not match the quoted text.')
    body, error = _body(request)
    if error:
        return fail(error)
    with transaction.atomic():
        thread = CommentThread.objects.create(
            project=project, path=path, anchor_from=start, anchor_to=end, quote=quote,
            prefix=str(b.get('prefix') or '')[-anchor.CONTEXT:], suffix=str(b.get('suffix') or '')[:anchor.CONTEXT])
        Comment.objects.create(thread=thread, body=body, **author_of(request))
    return Response({'ok': True, 'thread': thread_json(request, thread, _texts(project, [path]))}, status=201)


@api_view(['PATCH', 'DELETE'])
@permission_classes([IsUserOrGuest])
def thread_detail(request, pk, thread_id):
    project = get_project(request, pk)
    can_comment, can_moderate = access(request, project)
    thread = _thread(project, thread_id)
    if request.method == 'DELETE':
        first = thread.comments.first()
        if not (can_moderate or (can_comment and first is not None and is_mine(request, first))):
            raise PermissionDenied('Only the person who started the thread, or an editor, can delete it.')
        thread.delete()
        return Response({'ok': True})
    if not can_comment:
        raise PermissionDenied('You can read comments here but not write them.')
    resolved = bool((request.data or {}).get('resolved'))
    thread.resolved = resolved
    thread.resolved_by_name = author_of(request)['author_name'] if resolved else ''
    thread.resolved_at = timezone.now() if resolved else None
    thread.save(update_fields=['resolved', 'resolved_by_name', 'resolved_at', 'updated_at'])
    return Response({'ok': True, 'thread': thread_json(request, thread, _texts(project, [thread.path]))})


@api_view(['POST'])
@permission_classes([IsUserOrGuest])
def replies(request, pk, thread_id):
    project = get_project(request, pk)
    can_comment, _ = access(request, project)
    if not can_comment:
        raise PermissionDenied('You can read comments here but not write them.')
    thread = _thread(project, thread_id)
    body, error = _body(request)
    if error:
        return fail(error)
    Comment.objects.create(thread=thread, body=body, **author_of(request))
    thread.save(update_fields=['updated_at'])
    return Response({'ok': True, 'thread': thread_json(request, thread, _texts(project, [thread.path]))}, status=201)


@api_view(['PATCH', 'DELETE'])
@permission_classes([IsUserOrGuest])
def reply_detail(request, pk, thread_id, comment_id):
    project = get_project(request, pk)
    can_comment, can_moderate = access(request, project)
    thread = _thread(project, thread_id)
    try:
        comment = thread.comments.get(pk=comment_id)
    except (Comment.DoesNotExist, ValueError, Exception):
        raise NotFound('Comment not found')
    mine = can_comment and is_mine(request, comment)
    if request.method == 'DELETE':
        if not (mine or can_moderate):
            raise PermissionDenied('You can only delete your own comments.')
        comment.delete()
        if not thread.comments.exists():
            thread.delete()  # nothing left to discuss
            return Response({'ok': True, 'thread': None})
    else:
        if not mine:
            raise PermissionDenied('You can only edit your own comments.')
        body, error = _body(request)
        if error:
            return fail(error)
        comment.body, comment.edited_at = body, timezone.now()
        comment.save(update_fields=['body', 'edited_at'])
    return Response({'ok': True, 'thread': thread_json(request, thread, _texts(project, [thread.path]))})
