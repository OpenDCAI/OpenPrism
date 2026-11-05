"""Synchronous DB side of collaboration (called from async code through database_sync_to_async)."""
import hashlib
import logging

import redis
from django.conf import settings
from django.db import connection, transaction
from pycrdt import Doc, Text

from projects import files as pfiles
from projects.models import Project, ProjectFile

from . import coord
from .models import CollabDoc

log = logging.getLogger(__name__)
_redis = None


def _publish(channel, kind, payload):
    """Tell every replica holding the room (fire-and-forget: the stored state is the truth, rooms merge it anyway)."""
    global _redis
    try:
        if _redis is None:
            _redis = redis.Redis.from_url(settings.REDIS_URL)
        _redis.publish(channel, coord.pack(kind, b'\x00' * coord.ORIGIN_LEN, payload))
    except Exception:
        log.exception('collab publish failed on %s', channel)


def _lock(project_id, path):
    """Transaction-scoped advisory lock on (project, path): serialises seeding and flushes across replicas."""
    digest = hashlib.sha1(f'{project_id}:{path}'.encode()).digest()
    key = int.from_bytes(digest[:8], 'big') & 0x7FFFFFFFFFFFFFFF
    with connection.cursor() as cur:
        cur.execute('SELECT pg_advisory_xact_lock(%s)', [key])


def _file_text(project, path):
    row = project.files.filter(path=path, kind=ProjectFile.TEXT).values_list('content', flat=True).first()
    return row  # None when the file does not exist (yet)


def diff_replace(text, new):
    """Rewrite a pycrdt Text to `new` by replacing only the differing middle (keeps other people's cursors sane)."""
    old = str(text)
    if old == new:
        return False
    prefix = 0
    limit = min(len(old), len(new))
    while prefix < limit and old[prefix] == new[prefix]:
        prefix += 1
    suffix = 0
    while suffix < limit - prefix and old[len(old) - 1 - suffix] == new[len(new) - 1 - suffix]:
        suffix += 1
    if len(old) - suffix > prefix:
        del text[prefix:len(old) - suffix]
    insert = new[prefix:len(new) - suffix]
    if insert:
        text.insert(prefix, insert)
    return True


def load(project_id, path):
    """(Yjs update, CollabDoc id) to start a room from, created exactly once however many replicas race to open the file.
    The room keeps the id: it is how a flush notices that the file was renamed or deleted (see `flush`).

    If the file's text changed outside collaboration since the last flush (REST edit, template apply, …) the
    stored state is brought in line with the file, as a normal CRDT edit.
    """
    with transaction.atomic():
        _lock(project_id, path)
        project = Project.objects.get(pk=project_id)
        file_text = _file_text(project, path)
        row = CollabDoc.objects.filter(project=project, path=path).first()
        doc = Doc()
        text = doc.get('content', type=Text)
        if row and row.state:
            doc.apply_update(bytes(row.state))
        changed = False
        if file_text is not None:
            changed = diff_replace(text, file_text)
        if row is None:
            row = CollabDoc(project=project, path=path)
            changed = True
        if changed:
            row.state = doc.get_update()
            row.save()
        return bytes(row.state), row.pk


OK, MOVED, GONE = 'ok', 'moved', 'gone'


def lock_paths(project_id, paths):
    """Take several files' advisory locks, in a fixed order, before changing any file row: a flush takes its lock and
    then writes its file row, so a rename/delete/restore that held a file row while waiting for the lock could
    deadlock with it."""
    for path in sorted(set(paths)):
        _lock(project_id, path)


def _row_locked(project_id, path, doc_id):
    """The room's CollabDoc, with the advisory lock of the path it now has (renames move it, see projects.files)."""
    row = CollabDoc.objects.filter(pk=doc_id, project_id=project_id).first()
    while row is not None and row.path != path:
        path = row.path
        _lock(project_id, path)  # always after the room's own path lock; nothing takes them in the other order
        row = CollabDoc.objects.filter(pk=doc_id, project_id=project_id).first()
    return row


def flush(project_id, path, doc_id, local_update):
    """Merge a room's state into its stored document, project the text into the file. Returns (status, merged, path):
    OK; MOVED when the file was renamed (merged into the moved document, text written at its new `path`); GONE when the
    file or project was deleted (nothing written, so a room left over never recreates a deleted file).

    Merging (rather than overwriting) is what keeps replicas convergent: whatever any replica persisted is
    folded in, and the caller applies the result back to its live doc.
    """
    with transaction.atomic():
        _lock(project_id, path)
        row = _row_locked(project_id, path, doc_id)
        if row is None:
            return GONE, None, None
        project = Project.objects.get(pk=project_id)
        doc = Doc()
        text = doc.get('content', type=Text)
        if row.state:
            doc.apply_update(bytes(row.state))
        doc.apply_update(local_update)
        merged = doc.get_update()
        new_text = str(text)
        current = _file_text(project, row.path)
        if current is None and row.path != path:
            pass  # renamed and then replaced by something that is not a text file: keep the state, write nothing
        elif new_text != current:
            pfiles.write_text(project, row.path, new_text, sync_live=False)
        if merged != bytes(row.state):
            row.state = merged
            row.save(update_fields=['state', 'updated_at'])
        return (OK if row.path == path else MOVED), merged, row.path


def closed_paths(project, paths):
    """After commit, tell the rooms of `paths` (renamed or deleted) to flush now: their flush finds out and closes."""
    channels = [coord.channel(coord.room_key(project.id, p)) for p in paths]
    transaction.on_commit(lambda: [_publish(c, coord.KIND_CLOSE, b'') for c in channels])


def external_write(project, path, content):
    """A text write that does not come from a live room (REST save, upload, template, restore, …): make it an edit of
    the file's Yjs state too, so an open room keeps it instead of overwriting it at its next flush.

    Called by projects.files inside the write's transaction, before the file row changes: the lock order (advisory lock,
    then the row) matches a flush, and a room loading meanwhile waits and then sees the new text. After commit the
    delta goes to the rooms as an update from another replica; if that message is lost, the stored state already has
    it and the room merges it at its next flush."""
    _lock(project.id, path)
    row = CollabDoc.objects.filter(project=project, path=path).first()
    if row is None or not row.state:
        return  # never opened live: a room that opens later seeds from the file
    doc = Doc()
    text = doc.get('content', type=Text)
    doc.apply_update(bytes(row.state))
    before = doc.get_state()
    if not diff_replace(text, content):
        return
    delta = doc.get_update(before)
    row.state = doc.get_update()
    row.save(update_fields=['state', 'updated_at'])
    channel = coord.doc_channel(row.pk)
    transaction.on_commit(lambda: _publish(channel, coord.KIND_UPDATE, delta))


def project_name(project_id):
    return Project.objects.filter(pk=project_id).values_list('name', flat=True).first()
