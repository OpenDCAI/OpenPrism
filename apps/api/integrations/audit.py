"""The credential event log (CredentialEvent). Call record() in the same transaction as the change it describes."""
from .models import CredentialEvent

PAGE = 50


def record(kind, action, actor, workspace=None, owner=None, last_four='', detail=None):
    return CredentialEvent.objects.create(
        kind=kind, action=action, actor=actor, actor_name=(actor.name or actor.email) if actor else '',
        workspace=workspace, owner=owner, last_four=last_four or '', detail=detail or {})


def event_json(e):
    return {'id': str(e.id), 'createdAt': e.created_at.isoformat().replace('+00:00', 'Z'), 'kind': e.kind,
            'action': e.action, 'lastFour': e.last_four, 'detail': e.detail, 'actorName': e.actor_name,
            'actor': {'id': str(e.actor_id), 'name': e.actor_name} if e.actor_id else None}


def page(queryset, before=None, limit=None):
    """Newest first; `before` is an ISO timestamp from the previous page's last event."""
    from django.utils.dateparse import parse_datetime
    try:
        limit = min(max(int(limit or PAGE), 1), 100)
    except (TypeError, ValueError):
        limit = PAGE
    qs = queryset.select_related(None).order_by('-created_at', '-id')
    when = parse_datetime(before) if before else None
    if when is not None:
        qs = qs.filter(created_at__lt=when)
    rows = list(qs[:limit + 1])
    return {'ok': True, 'events': [event_json(e) for e in rows[:limit]], 'hasMore': len(rows) > limit}
