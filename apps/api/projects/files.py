"""Project file service: the only code that reads or writes ProjectFile rows and their S3 objects.

Text files are stored in Postgres (`content`); binaries get a random S3 key, so renames are DB-only.
Directories are implicit from path prefixes, plus explicit `dir` rows for empty folders.
"""
import mimetypes
import uuid

from django.db import transaction
from django.utils import timezone

from . import storage
from .models import Project, ProjectFile
from .paths import is_text_file, safe_path


class FileNotFound(LookupError):
    pass


def _get(project, path):
    try:
        return project.files.get(path=safe_path(path))
    except ProjectFile.DoesNotExist:
        raise FileNotFound(path)


def _touch(project):
    Project.objects.filter(pk=project.pk).update(updated_at=timezone.now())


def _assert_can_create(project, path):
    """A path may not sit under a file, nor replace a directory."""
    parts = path.split('/')
    ancestors = ['/'.join(parts[:i]) for i in range(1, len(parts))]
    if ancestors and project.files.filter(path__in=ancestors).exclude(kind=ProjectFile.DIR).exists():
        raise IsADirectoryError(f'A parent of {path} is a file')
    if project.files.filter(path__startswith=path + '/').exists() or project.files.filter(
            path=path, kind=ProjectFile.DIR).exists():
        raise IsADirectoryError(f'{path} is a directory')


def _drop_collab_state(project, path):
    from collab.models import CollabDoc  # imported lazily: collab depends on this module
    CollabDoc.objects.filter(project=project, path=path).delete()
    CollabDoc.objects.filter(project=project, path__startswith=path + '/').delete()


def write_text(project, path, content):
    path = safe_path(path)
    _assert_can_create(project, path)
    with transaction.atomic():
        obj, _ = project.files.update_or_create(
            path=path,
            defaults={'kind': ProjectFile.TEXT, 'content': content, 's3_key': '',
                      'size': len(content.encode('utf-8')), 'content_type': 'text/plain'},
        )
        _touch(project)
    return obj


def write_binary(project, path, data, content_type=None):
    path = safe_path(path)
    _assert_can_create(project, path)
    content_type = content_type or mimetypes.guess_type(path)[0] or 'application/octet-stream'
    key = f'projects/{project.id}/{uuid.uuid4().hex}'
    storage.put_bytes(key, data, content_type)
    with transaction.atomic():
        existing = project.files.filter(path=path).first()
        old_key = existing.s3_key if existing else ''
        obj, _ = project.files.update_or_create(
            path=path,
            defaults={'kind': ProjectFile.BINARY, 'content': '', 's3_key': key,
                      'size': len(data), 'content_type': content_type},
        )
        _touch(project)
    if old_key:
        storage.delete_keys([old_key])
    return obj


def write_file(project, path, data, content_type=None):
    """Store bytes as text when the extension is a text type, otherwise as a binary object."""
    if is_text_file(path):
        try:
            return write_text(project, path, data.decode('utf-8'))
        except UnicodeDecodeError:
            pass
    return write_binary(project, path, data, content_type)


def read_text(project, path):
    obj = _get(project, path)
    if obj.kind != ProjectFile.TEXT:
        raise FileNotFound(path)
    return obj.content


def read_bytes(project, path):
    obj = _get(project, path)
    if obj.kind == ProjectFile.TEXT:
        return obj.content.encode('utf-8')
    if obj.kind == ProjectFile.BINARY:
        return storage.get_bytes(obj.s3_key)
    raise FileNotFound(path)


def mkdir(project, path):
    path = safe_path(path)
    existing = project.files.filter(path=path).first()
    if existing:
        if existing.kind != ProjectFile.DIR:
            raise FileExistsError(path)
        return existing
    _assert_can_create(project, path)
    return project.files.create(path=path, kind=ProjectFile.DIR)


def list_tree(project):
    """[{path, type: 'file'|'dir'}] with implicit parent directories included, sorted by path."""
    items = {}
    for path, kind in project.files.values_list('path', 'kind'):
        parts = path.split('/')
        for i in range(1, len(parts)):
            items['/'.join(parts[:i])] = 'dir'
        items[path] = 'dir' if kind == ProjectFile.DIR else 'file'
    return [{'path': p, 'type': t} for p, t in sorted(items.items())]


def _subtree(project, path):
    return project.files.filter(path=path) | project.files.filter(path__startswith=path + '/')


def delete(project, path):
    path = safe_path(path)
    rows = list(_subtree(project, path))
    if not rows:
        raise FileNotFound(path)
    keys = [r.s3_key for r in rows if r.s3_key]
    with transaction.atomic():
        _subtree(project, path).delete()
        _drop_collab_state(project, path)
        _touch(project)
    storage.delete_keys(keys)


def rename(project, src, dst):
    src, dst = safe_path(src), safe_path(dst)
    if dst == src or dst.startswith(src + '/'):
        raise ValueError('Invalid destination')
    rows = list(_subtree(project, src))
    if not rows:
        raise FileNotFound(src)
    if project.files.filter(path=dst).exists() or project.files.filter(path__startswith=dst + '/').exists():
        raise FileExistsError(dst)
    with transaction.atomic():
        for row in rows:
            row.path = dst + row.path[len(src):]
            row.save(update_fields=['path', 'updated_at'])
        _drop_collab_state(project, src)  # live rooms for the old path are stale; the new path reseeds from the file
        _touch(project)


def copy_project_files(src_project, dst_project):
    """Duplicate every file into another project (binaries are copied server-side in S3)."""
    new_rows = []
    for row in src_project.files.all():
        key = ''
        if row.s3_key:
            key = f'projects/{dst_project.id}/{uuid.uuid4().hex}'
            storage.copy(row.s3_key, key)
        new_rows.append(ProjectFile(
            project=dst_project, path=row.path, kind=row.kind, content=row.content,
            s3_key=key, size=row.size, content_type=row.content_type))
    ProjectFile.objects.bulk_create(new_rows)


def delete_project_files(project):
    """Remove all S3 objects for a project (call before deleting the Project row)."""
    storage.delete_prefix(f'projects/{project.id}/')
    storage.delete_prefix(f'versions/{project.id}/')  # version blobs and PDFs


class Applied:
    """What `apply_changes` staged in S3, so a caller whose own transaction fails afterwards can discard it."""

    def __init__(self, staged_keys):
        self.staged_keys = staged_keys

    def rollback(self):
        storage.delete_keys(self.staged_keys)


def apply_changes(project, writes, removals):
    """Make a set of file changes all at once (version restore). Either every change lands or none does.

    `writes`: dicts {path, kind 'text'|'binary'|'dir', text, source_key, size, content_type}; a binary's bytes are
    copied server-side from `source_key` into a new random key. `removals`: exact paths of rows to delete. Removals run
    first, then folders, then files, so a path can turn from file to folder and back. Binaries are staged in S3 before
    the database transaction and the replaced objects are deleted only after it commits (`transaction.on_commit`, so
    also after any outer transaction), so a failure leaves the project, and its old bytes, untouched."""
    staged = {}  # path -> new key
    try:
        for w in writes:
            if w['kind'] == 'binary':
                staged[w['path']] = f'projects/{project.id}/{uuid.uuid4().hex}'
                storage.copy(w['source_key'], staged[w['path']])
        old_keys = []
        with transaction.atomic():
            for path in removals:
                path = safe_path(path)
                old_keys += project.files.filter(path=path).exclude(s3_key='').values_list('s3_key', flat=True)
                project.files.filter(path=path).delete()
                _drop_collab_state(project, path)
            for w in sorted(writes, key=lambda w: (w['kind'] != 'dir', w['path'])):
                path = safe_path(w['path'])
                existing = project.files.filter(path=path).first()
                if existing and existing.s3_key:
                    old_keys.append(existing.s3_key)
                if w['kind'] == 'dir':
                    if existing and existing.kind == ProjectFile.DIR:
                        continue
                    parts = path.split('/')
                    parents = ['/'.join(parts[:i]) for i in range(1, len(parts))]
                    if parents and project.files.filter(path__in=parents).exclude(kind=ProjectFile.DIR).exists():
                        raise IsADirectoryError(f'A parent of {path} is a file')
                    defaults = {'kind': ProjectFile.DIR, 'content': '', 's3_key': '', 'size': 0, 'content_type': ''}
                else:
                    if existing and existing.kind == ProjectFile.DIR and project.files.filter(path__startswith=path + '/').exists():
                        raise IsADirectoryError(f'{path} is a directory')
                    if not existing:
                        _assert_can_create(project, path)
                    if w['kind'] == 'text':
                        defaults = {'kind': ProjectFile.TEXT, 'content': w['text'], 's3_key': '',
                                    'size': len(w['text'].encode('utf-8')), 'content_type': 'text/plain'}
                    else:
                        defaults = {'kind': ProjectFile.BINARY, 'content': '', 's3_key': staged[path], 'size': w['size'],
                                    'content_type': w.get('content_type') or 'application/octet-stream'}
                project.files.update_or_create(path=path, defaults=defaults)
            _touch(project)
            transaction.on_commit(lambda: storage.delete_keys(old_keys))
    except Exception:
        storage.delete_keys(staged.values())
        raise
    return Applied(list(staged.values()))
