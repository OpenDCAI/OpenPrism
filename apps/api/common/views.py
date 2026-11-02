import redis
from django.conf import settings
from django.db import connection
from django.http import JsonResponse


def health(request):
    return JsonResponse({'ok': True, 'version': settings.VERSION})


def ready(request):
    """Readiness probe: Postgres, Redis and the S3 bucket must all be reachable."""
    checks = {}
    try:
        with connection.cursor() as cur:
            cur.execute('SELECT 1')
        checks['postgres'] = True
    except Exception as exc:
        checks['postgres'] = str(exc)
    try:
        redis.Redis.from_url(settings.REDIS_URL, socket_timeout=2).ping()
        checks['redis'] = True
    except Exception as exc:
        checks['redis'] = str(exc)
    try:
        from projects.storage import get_client
        get_client().head_bucket(Bucket=settings.S3_BUCKET)
        checks['s3'] = True
    except Exception as exc:
        checks['s3'] = str(exc)
    ok = all(v is True for v in checks.values())
    return JsonResponse({'ok': ok, 'version': settings.VERSION, 'checks': checks}, status=200 if ok else 503)
