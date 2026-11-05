"""Fixed-window per-minute request limits, counted in the shared (Redis) cache so every API replica sees the same count."""
import time

from django.core.cache import cache
from rest_framework.exceptions import Throttled


def hit(scope, ident, per_minute):
    """Count one request for `ident` in `scope`. Returns 0 while within `per_minute`, else the seconds until the
    window resets (for Retry-After)."""
    now = time.time()
    window = int(now // 60)
    key = f'rate:{scope}:{ident}:{window}'
    cache.add(key, 0, 90)
    try:
        count = cache.incr(key)
    except ValueError:  # expired between add and incr
        cache.add(key, 1, 90)
        count = 1
    return 0 if count <= per_minute else max(1, int((window + 1) * 60 - now) + 1)


def ident_for(user):
    """Accounts are counted per user, invite-link guests per invite."""
    return f'invite:{user.invite_id}' if getattr(user, 'is_guest', False) else f'user:{user.id}'


def enforce(scope, user, per_minute):
    """Raise 429 {ok:false,error} with Retry-After when `user` is over the limit."""
    wait = hit(scope, ident_for(user), per_minute)
    if wait:
        raise Throttled(wait=wait, detail='Too many requests: try again in a minute.')
