"""Direct uploads: the browser PUTs binary project files straight to S3 with presigned URLs, so file bytes never pass
through the API. Text files (stored in Postgres, small) keep using the multipart upload endpoint.

1. start() validates every path and size and returns, per binary file, a presigned PUT URL for a fresh random key,
   recorded as a PendingUpload. 2. The browser PUTs each file. 3. complete() checks each object's size with a HEAD
   (an object missing or not the size declared is deleted and reported as failed) and registers the file through
   projects.files, as an ordinary upload would. cleanup_pending() removes uploads never completed (row and object)."""
import uuid
from datetime import timedelta

from botocore.exceptions import ClientError
from django.conf import settings
from django.utils import timezone

from . import files, storage
from .models import PendingUpload
from .paths import InvalidPath, is_text_file, safe_path, sanitize_upload_path

MAX_FILES = 500
PUT_EXPIRES = 15 * 60
PENDING_MAX_AGE = timedelta(hours=1)


class UploadError(ValueError):
    """A message that is safe to show to the user."""


def _owner(principal):
    if getattr(principal, 'is_guest', False):
        return {'user': None, 'invite_id': principal.invite_id}
    return {'user': principal, 'invite_id': None}


def _clean(project, item):
    item = item if isinstance(item, dict) else {}
    try:
        path = safe_path(sanitize_upload_path(str(item.get('path') or '')))
    except InvalidPath:
        raise UploadError(f"Invalid path: {item.get('path')}") from None
    try:
        size = int(item.get('size'))
    except (TypeError, ValueError):
        raise UploadError(f'{path}: the size is missing.') from None
    if size < 0 or size > settings.MAX_UPLOAD_BYTES:
        raise UploadError(f'{path} is larger than {settings.MAX_UPLOAD_BYTES // (1024 * 1024)} MB.')
    try:
        files.assert_can_create(project, path)
    except IsADirectoryError as exc:
        raise UploadError(str(exc)) from None
    return path, size, str(item.get('contentType') or '')[:200] or 'application/octet-stream'


def start(project, principal, items):
    """Plan an upload: [{path, direct: False}] for text files, [{path, direct: True, uploadId, url, headers}] for the
    rest. Everything is validated before any URL is handed out."""
    if not isinstance(items, list) or not items:
        raise UploadError('Nothing to upload.')
    if len(items) > MAX_FILES:
        raise UploadError(f'Upload at most {MAX_FILES} files at a time.')
    cleaned = [_clean(project, item) for item in items]
    out = []
    for path, size, content_type in cleaned:
        if is_text_file(path):
            out.append({'path': path, 'direct': False})  # text goes through the API into Postgres
            continue
        key = f'projects/{project.id}/{uuid.uuid4().hex}'
        pending = PendingUpload.objects.create(project=project, path=path, s3_key=key, size=size,
                                               content_type=content_type, **_owner(principal))
        out.append({'path': path, 'direct': True, 'uploadId': str(pending.id),
                    'url': storage.presigned_put_url(key, content_type, PUT_EXPIRES),
                    'headers': {'Content-Type': content_type}})
    return out


def _arrived(pending):
    try:
        return storage.head(pending.s3_key)['ContentLength'] == pending.size
    except ClientError:
        return False


def complete(project, principal, upload_ids):
    """Register the uploaded objects (only the caller's own). Returns (saved paths, [{path, error}])."""
    ids = [str(i) for i in upload_ids] if isinstance(upload_ids, list) else []
    try:
        pending = list(PendingUpload.objects.filter(project=project, id__in=ids, **_owner(principal)))
    except Exception:  # malformed ids
        raise UploadError('Unknown upload.') from None
    saved, failed = [], []
    for p in pending:
        error = None if _arrived(p) else 'The upload did not arrive complete.'
        if error is None:
            try:
                files.register_binary(project, p.path, p.s3_key, p.size, p.content_type)
            except IsADirectoryError as exc:
                error = str(exc)
        if error:
            storage.delete_keys([p.s3_key])
            failed.append({'path': p.path, 'error': error})
        else:
            saved.append(p.path)
        p.delete()
    return saved, failed


def cleanup_pending():
    """Remove uploads started over PENDING_MAX_AGE ago and never completed, with whatever was PUT."""
    stale = list(PendingUpload.objects.filter(created_at__lt=timezone.now() - PENDING_MAX_AGE))
    storage.delete_keys([p.s3_key for p in stale])
    PendingUpload.objects.filter(id__in=[p.id for p in stale]).delete()
    return len(stale)
