"""Read-only version history: list, detail, PDF, files and a manifest diff. Naming, delete and restore live elsewhere."""
import hashlib

from django.core.exceptions import ValidationError
from django.db import transaction
from django.http import HttpResponse
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.exceptions import NotFound, ParseError, PermissionDenied
from rest_framework.response import Response

from collab.auth import IsUserOrGuest
from collab.views import evict_idle_room, flush_room, live_room
from projects import files as pfiles
from projects import storage
from projects.access import QueryTokenJWTAuthentication, get_project
from projects.models import ProjectFile
from projects.paths import InvalidPath, safe_path
from projects.views import BLOB_TYPES, INERT_TYPES, iso

from . import retention, snapshot
from .models import ProjectVersion, VersionBlob

PAGE_MAX = 100


def fail(message, status=200):
    return Response({'ok': False, 'error': message}, status=status)


def version_json(v, detail=False):
    author = v.created_by
    out = {
        'id': str(v.id), 'number': v.number, 'createdAt': iso(v.created_at),
        'createdBy': {'name': author.name or author.email.split('@')[0]} if author else None,
        'mainFile': v.main_file, 'engine': v.engine, 'name': v.name,
        'fileCount': sum(1 for m in v.manifest if m['kind'] != 'dir'), 'pdfSize': v.pdf_size,
        'restoredFrom': v.restored_from.number if v.restored_from_id else None,
    }
    if detail:
        out['manifest'] = v.manifest
    return out


def _can_write(request, project):
    """Whether the caller may name, delete and restore versions (the UI hides those controls otherwise)."""
    try:
        get_project(request, project.id, write=True)
    except PermissionDenied:
        return False
    return True


def get_version(project, version_id):
    try:
        return project.versions.select_related('created_by', 'restored_from').get(pk=version_id)
    except (ProjectVersion.DoesNotExist, ValidationError, ValueError, TypeError):  # unknown, malformed or another project's id
        raise NotFound('Version not found')


@api_view(['GET'])
@permission_classes([IsUserOrGuest])
def versions_collection(request, pk):
    project = get_project(request, pk)
    try:
        limit = min(max(int(request.query_params.get('limit', 50)), 1), PAGE_MAX)
        before = request.query_params.get('before')
        before = int(before) if before else None
    except ValueError:
        raise ParseError('limit and before must be numbers')
    rows = project.versions.select_related('created_by', 'restored_from')
    if before:
        rows = rows.filter(number__lt=before)
    rows = list(rows[:limit + 1])
    return Response({'ok': True, 'versions': [version_json(v) for v in rows[:limit]], 'hasMore': len(rows) > limit,
                     'canWrite': _can_write(request, project)})


NAME_MAX = 100


@api_view(['GET', 'PATCH', 'DELETE'])
@permission_classes([IsUserOrGuest])
def version_detail(request, pk, version_id):
    """GET the version with its manifest; PATCH {name} names/unnames it; DELETE removes an unnamed one (write access)."""
    project = get_project(request, pk, write=request.method != 'GET')
    version = get_version(project, version_id)
    if request.method == 'PATCH':
        name = request.data.get('name')
        if not isinstance(name, str):
            return fail('name must be a string.')
        name = name.strip()
        if len(name) > NAME_MAX:
            return fail(f'A version name can have at most {NAME_MAX} characters.')
        version.name = name
        version.save(update_fields=['name'])
    elif request.method == 'DELETE':
        if version.name:
            return fail('This version is named. Remove its name before deleting it.', 400)
        retention.delete_versions(project, [version])
        return Response({'ok': True})
    return Response({'ok': True, 'version': version_json(version, detail=True)})


@api_view(['GET'])
@authentication_classes([QueryTokenJWTAuthentication])
@permission_classes([IsUserOrGuest])
def version_pdf(request, pk, version_id):
    project = get_project(request, pk)
    version = get_version(project, version_id)
    if not version.pdf_key:
        raise NotFound('No PDF for this version')
    resp = HttpResponse(storage.get_bytes(version.pdf_key), content_type='application/pdf')
    resp['X-Content-Type-Options'] = 'nosniff'
    return resp


@api_view(['GET'])
@authentication_classes([QueryTokenJWTAuthentication])
@permission_classes([IsUserOrGuest])
def version_file(request, pk, version_id):
    """One file as it was in the version: JSON for text, the bytes (sandboxed like /blob) for binaries."""
    project = get_project(request, pk)
    version = get_version(project, version_id)
    raw = request.query_params.get('path')
    if not raw:
        raise ParseError('Missing path')
    try:
        path = safe_path(raw)
    except InvalidPath:
        raise ParseError('Invalid path')
    entry = next((m for m in version.manifest if m['path'] == path and m['kind'] != 'dir'), None)
    if entry is None:
        raise NotFound('File not found in this version')
    blob = VersionBlob.objects.filter(project=project, sha256=entry['sha256']).first()
    if blob is None:
        raise NotFound('File content is no longer stored')
    if blob.kind == VersionBlob.TEXT:
        return Response({'ok': True, 'kind': 'text', 'path': path, 'content': blob.text})
    ext = '.' + path.rsplit('.', 1)[-1].lower() if '.' in path.rsplit('/', 1)[-1] else ''
    resp = HttpResponse(storage.get_bytes(blob.s3_key), content_type=BLOB_TYPES.get(ext) or blob.content_type or 'application/octet-stream')
    if resp['Content-Type'] not in INERT_TYPES:
        resp['Content-Security-Policy'] = 'sandbox'  # user-supplied SVG/HTML must not run script in our origin
    resp['X-Content-Type-Options'] = 'nosniff'
    return resp


def current_manifest(project):
    """The project's live files in manifest form. Binaries have no stored hash, so they are hashed on demand
    (only when `compare_to` could be equal, see `diff`); here sha256 is '' for them until resolved."""
    out = {}
    for row in project.files.all():
        if row.kind == ProjectFile.DIR:
            out[row.path] = {'path': row.path, 'kind': 'dir', 'size': 0, 'sha256': ''}
        elif row.kind == ProjectFile.TEXT:
            data = row.content.encode('utf-8')
            out[row.path] = {'path': row.path, 'kind': 'text', 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        else:
            out[row.path] = {'path': row.path, 'kind': 'binary', 'size': row.size, 'sha256': None, 's3_key': row.s3_key}
    return out


def _same(old, new):
    if old['kind'] != new['kind']:
        return False
    if old['kind'] == 'dir':
        return True
    if new['sha256'] is None:  # live binary: sizes differ -> changed; equal sizes -> compare bytes
        if old['size'] != new['size']:
            return False
        new['sha256'] = hashlib.sha256(storage.get_bytes(new['s3_key'])).hexdigest()
    return old['sha256'] == new['sha256']


def diff_manifests(old, new, include_unchanged=False):
    """old/new: {path: entry}. One row per path, sorted: added | removed | modified | unchanged."""
    rows = []
    for path in sorted(old.keys() | new.keys()):
        a, b = old.get(path), new.get(path)
        if a is None:
            status, kind = 'added', b['kind']
        elif b is None:
            status, kind = 'removed', a['kind']
        else:
            status, kind = ('unchanged' if _same(a, b) else 'modified'), b['kind']
        if status != 'unchanged' or include_unchanged:
            rows.append({'path': path, 'status': status, 'kind': kind})
    return rows


@api_view(['GET'])
@permission_classes([IsUserOrGuest])
def versions_diff(request, pk):
    project = get_project(request, pk)
    source = request.query_params.get('from')
    target = request.query_params.get('to', 'current')
    if not source:
        raise ParseError('Missing from')
    old = {m['path']: m for m in get_version(project, source).manifest}
    if target == 'current':
        new = current_manifest(project)
    else:
        new = {m['path']: m for m in get_version(project, target).manifest}
    return Response({'ok': True, 'files': diff_manifests(old, new, include_unchanged=request.query_params.get('all') == '1')})


@api_view(['POST'])
@permission_classes([IsUserOrGuest])
def version_restore(request, pk, version_id):
    """Make the project's files exactly this version's and record that as a new version (history is never rewritten).

    Refused with 409, changing nothing, while someone is connected to a file the restore would change: a write behind a
    live room is overwritten by its next save. The editor leaves its own rooms before calling."""
    project = get_project(request, pk, write=True)
    version = get_version(project, version_id)
    wanted = {m['path']: m for m in version.manifest}

    # Bring the database up to date with live edits, and drop rooms nobody is using (they would keep their old text).
    text_paths = {row.path for row in project.files.filter(kind=ProjectFile.TEXT)} | {p for p, m in wanted.items() if m['kind'] == 'text'}
    unsaved = [p for p in sorted(text_paths) if live_room(project, p) and not flush_room(project, p)]
    if unsaved:
        return fail('Live edits could not be saved first. Try again in a moment.', 409)
    for path in sorted(text_paths):
        evict_idle_room(project, path)

    current = current_manifest(project)
    changes = diff_manifests(wanted, current)  # old = the version, new = now: 'added' means present now only
    to_remove = [c['path'] for c in changes if c['status'] == 'added']
    to_write = [c['path'] for c in changes if c['status'] in ('removed', 'modified')]
    if not changes:
        return Response({'ok': True, 'restored': False, 'message': 'The project already matches this version.'})
    busy = [p for p in sorted({*to_remove, *to_write}) if live_room(project, p)]
    if busy:
        return Response({'ok': False, 'error': 'Someone has files open that this restore would change. Ask them to close '
                         'them, then try again.', 'files': busy}, status=409)

    blobs = {b.sha256: b for b in VersionBlob.objects.filter(project=project, sha256__in={wanted[p]['sha256'] for p in to_write if wanted[p]['kind'] != 'dir'})}
    writes = []
    for path in to_write:
        entry = wanted[path]
        if entry['kind'] == 'dir':
            writes.append({'path': path, 'kind': 'dir'})
            continue
        blob = blobs.get(entry['sha256'])
        if blob is None:
            return fail('Some of this version\'s files are no longer stored, so it cannot be restored.', 409)
        writes.append({'path': path, 'kind': entry['kind'], 'text': blob.text, 'source_key': blob.s3_key,
                       'size': entry['size'], 'content_type': blob.content_type})
    applied = None
    try:
        with transaction.atomic():
            applied = pfiles.apply_changes(project, writes, to_remove)
            created = snapshot.record_restore(project, version, user=None if getattr(request.user, 'is_guest', False) else request.user)
    except Exception as exc:
        if applied:
            applied.rollback()
        return fail(f'Restore failed, nothing was changed: {exc}', 500)
    return Response({'ok': True, 'restored': True, 'versionId': str(created.id), 'versionNumber': created.number,
                     'changed': {'written': len(to_write), 'removed': len(to_remove)}})
