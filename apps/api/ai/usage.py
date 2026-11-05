"""Who pays for an AI job and whether they may: the key-source decision, the server-key policy (SERVER_LLM_KEY_USERS),
the per-user daily quota on the server key, the per-workspace daily limit, and the usage counts (integrations.LlmUsage).

Views call resolve() to pick the key, then charge() just before they create the Job, so a refused request never queues
anything. Counts are requests (jobs), not tokens."""
from datetime import datetime, time as dtime, timedelta

from django.conf import settings
from django.db import connection
from django.db.models import F, Sum
from django.utils import timezone
from rest_framework.exceptions import APIException, PermissionDenied

from integrations.models import LlmUsage, WorkspaceLlmConfig

OWN_KEY_HINT = 'Add your own key in Settings.'


class LimitReached(APIException):
    status_code = 429

    def __init__(self, detail, wait):
        super().__init__(detail)
        self.wait = wait  # DRF's handler turns this into Retry-After


def today():
    return timezone.now().date()  # UTC (USE_TZ)


def _seconds_to_midnight():
    now = timezone.now()
    midnight = datetime.combine(now.date() + timedelta(days=1), dtime.min, tzinfo=now.tzinfo)
    return max(1, int((midnight - now).total_seconds()))


def resolve(request, workspace, public, secrets):
    """(public, secrets, source): the workspace's provider replaces the browser's whole config (endpoint, model and key
    belong together) when it has one and the user may use it; else the request's config if it carries a key (API
    clients); else the user's saved key for `public['profile']` (llm, search, vision; the UI's way) with its own
    endpoint and model; else the worker's OPENPRISM_LLM_* defaults, and then nothing of the request's config is kept
    (the worker never sends its key to a request's endpoint either)."""
    from integrations import userkeys
    from integrations.llmconfig import workspace_llm_for
    public = dict(public)
    profile = public.pop('profile', '')
    found = workspace_llm_for(workspace, request.user)
    if found:
        return found[0], found[1], LlmUsage.WORKSPACE
    if secrets.get('apiKey'):
        return public, secrets, LlmUsage.BROWSER
    saved = userkeys.resolve(request.user, profile)
    if saved:
        return saved[0], {'apiKey': saved[1]}, LlmUsage.USER
    return {}, {'apiKey': ''}, LlmUsage.SERVER


def may_use_server_key(user):
    policy = settings.SERVER_LLM_KEY_USERS
    if policy == 'all':
        return True
    if policy == 'verified':
        return bool(getattr(user, 'email_verified_at', None))
    if policy == 'staff':
        return bool(user.is_staff)
    return False


def _bump(user_id, workspace_id, source):
    """Count one job, atomically (one upsert, so concurrent first requests of the day cannot collide)."""
    table = LlmUsage._meta.db_table
    with connection.cursor() as cur:
        cur.execute(
            f'INSERT INTO {table} (day, user_id, workspace_id, source, count) VALUES (%s, %s, %s, %s, 1) '
            f'ON CONFLICT ON CONSTRAINT llm_usage_unique_row DO UPDATE SET count = {table}.count + 1',
            [today(), user_id, workspace_id, source])


def _unbump(user_id, workspace_id, source):
    LlmUsage.objects.filter(day=today(), user_id=user_id, workspace_id=workspace_id, source=source, count__gt=0) \
        .update(count=F('count') - 1)


def _count(**filters):
    return LlmUsage.objects.filter(day=today(), **filters).aggregate(n=Sum('count'))['n'] or 0


def charge(request, source, workspace):
    """Apply the policy and the daily limits for one job paid by `source`, and count it. Raises 403/429."""
    user, workspace_id = request.user, workspace.id if workspace is not None else None
    if source == LlmUsage.SERVER and not may_use_server_key(user):
        raise PermissionDenied(f"The server's AI key is not available to your account. {OWN_KEY_HINT}")
    _bump(user.id, workspace_id, source)  # count first, then check: concurrent requests cannot both slip under
    if source == LlmUsage.SERVER and settings.SERVER_LLM_DAILY_QUOTA and \
            _count(user=user, source=LlmUsage.SERVER) > settings.SERVER_LLM_DAILY_QUOTA:
        _unbump(user.id, workspace_id, source)
        raise LimitReached(f"You have used today's AI requests on the server's key. {OWN_KEY_HINT}", _seconds_to_midnight())
    if source == LlmUsage.WORKSPACE:
        limit = WorkspaceLlmConfig.objects.filter(workspace_id=workspace_id).values_list('daily_limit', flat=True).first()
        if limit and _count(workspace_id=workspace_id, source=LlmUsage.WORKSPACE) > limit:
            _unbump(user.id, workspace_id, source)
            raise LimitReached("This workspace's daily AI limit is used up.", _seconds_to_midnight())


def workspace_usage(workspace_id):
    """Jobs paid by the workspace's provider: {today, last30Days} (the 30 days include today)."""
    rows = LlmUsage.objects.filter(workspace_id=workspace_id, source=LlmUsage.WORKSPACE)
    since = today() - timedelta(days=29)
    return {'today': rows.filter(day=today()).aggregate(n=Sum('count'))['n'] or 0,
            'last30Days': rows.filter(day__gte=since).aggregate(n=Sum('count'))['n'] or 0}
