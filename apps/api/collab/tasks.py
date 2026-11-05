import logging
import time

import redis
from celery import shared_task
from django.conf import settings
from django.utils import timezone
from pycrdt import Doc

from . import coord, store
from .models import CollabDoc, CollabInvite

log = logging.getLogger(__name__)


@shared_task(name='collab.tasks.cleanup_expired_invites')
def cleanup_expired_invites():
    deleted, _ = CollabInvite.objects.filter(expires_at__lt=timezone.now()).delete()
    return deleted


@shared_task(name='collab.tasks.recover_update_logs', ignore_result=True)
def recover_update_logs():
    """Save the edits a dead replica logged but never flushed (#56), even if nobody opens the file again. A replica is
    dead when it has not sent a heartbeat for HOLDER_FRESH_SECONDS (live ones beat at least every sync interval).
    Returns the number of logs recovered."""
    r = redis.Redis.from_url(settings.REDIS_URL)
    alive_since = time.time() - coord.HOLDER_FRESH_SECONDS
    recovered = 0
    for raw_id in r.smembers(coord.LOGGED):
        doc_id = int(raw_id)
        owners = r.smembers(coord.log_owners_key(doc_id))
        for raw_owner in owners:
            owner = raw_owner.decode()
            key = coord.log_key(doc_id, owner)
            seen = r.zscore(coord.INSTANCES, owner)
            if seen is not None and seen >= alive_since:
                continue  # its replica is alive and will flush (and trim) the log itself
            updates = r.lrange(key, 0, -1)
            row = CollabDoc.objects.filter(pk=doc_id).values('project_id', 'path', 'state').first()
            if updates and row:
                doc = Doc()  # the stored state first: logged edits may build on text that was already saved
                if row['state']:
                    doc.apply_update(bytes(row['state']))
                for update in updates:
                    doc.apply_update(update)
                try:
                    store.flush(row['project_id'], row['path'], doc_id, doc.get_update())
                except Exception:
                    log.exception('could not recover the collab log of document %s', doc_id)
                    continue
                recovered += 1
            r.delete(key)
            r.srem(coord.log_owners_key(doc_id), owner)
        if not r.exists(coord.log_owners_key(doc_id)):
            r.srem(coord.LOGGED, raw_id)
    r.zremrangebyscore(coord.INSTANCES, 0, time.time() - coord.LOG_TTL_SECONDS)  # their logs have expired anyway
    return recovered
