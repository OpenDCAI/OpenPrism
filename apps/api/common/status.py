"""`GET /api/status` (#188): which services the app depends on are up, for people, the sign-in page and monitoring.

Public, so it says only `up` or `down`: no error text, host or credential. Every check runs in parallel with a short
deadline, so a service that hangs costs at most DEADLINE seconds. The answer is cached in this process (not in Redis,
which may be the thing that is down) for CACHE_SECONDS, so the endpoint cannot flood the workers with pings."""
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime, timezone

import redis
from django.conf import settings
from django.db import connection, close_old_connections

QUEUES = ('compile', 'transfer', 'ai', 'import')
DEADLINE = 3.0
CACHE_SECONDS = 10

_lock = threading.Lock()
_cached = None   # (monotonic time, result)
_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix='status')


def _postgres():
    try:
        with connection.cursor() as cur:
            cur.execute('SELECT 1')
    finally:
        close_old_connections()   # a pool thread must not keep its connection (#182)
        connection.close()
    return True


def _redis():
    return redis.Redis.from_url(settings.REDIS_URL, socket_timeout=2, socket_connect_timeout=2).ping()


def _s3():
    from projects.storage import get_client
    get_client().head_bucket(Bucket=settings.S3_BUCKET)
    return True


def _workers():
    """The queues at least one live worker consumes."""
    from config.celery import app
    answer = app.control.inspect(timeout=1.5).active_queues() or {}
    return {q['name'] for queues in answer.values() for q in queues}


def check():
    futures = {name: _pool.submit(fn) for name, fn in
               (('postgres', _postgres), ('redis', _redis), ('s3', _s3), ('workers', _workers))}
    wait(futures.values(), timeout=DEADLINE)

    def result(name):
        f = futures[name]
        if not f.done() or f.exception() is not None:
            return None
        return f.result()

    services = {name: 'up' if result(name) else 'down' for name in ('postgres', 'redis', 's3')}
    live = result('workers') or set()
    services['workers'] = {q: 'up' if q in live else 'down' for q in QUEUES}
    ok = all(v == 'up' for v in (services['postgres'], services['redis'], services['s3'],
                                  *services['workers'].values()))
    return {'ok': ok, 'version': settings.VERSION, 'services': services,
            'checkedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}


def cached():
    global _cached
    with _lock:
        if _cached and time.monotonic() - _cached[0] < CACHE_SECONDS:
            return _cached[1]
        result = check()
        _cached = (time.monotonic(), result)
        return result


def reset():
    global _cached
    _cached = None
