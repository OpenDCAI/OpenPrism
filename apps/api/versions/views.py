"""Read-only version history: list, detail, PDF, files and a manifest diff. Naming, delete and restore live elsewhere."""
import hashlib

from django.core.exceptions import ValidationError
from django.http import HttpResponse
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.exceptions import NotFound, ParseError
from rest_framework.response import Response

from collab.auth import IsUserOrGuest
from projects import storage
from projects.access import QueryTokenJWTAuthentication, get_project
from projects.models import ProjectFile
from projects.paths import InvalidPath, safe_path
from projects.views import BLOB_TYPES, INERT_TYPES, iso

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
    return Response({'ok': True, 'versions': [version_json(v) for v in rows[:limit]], 'hasMore': len(rows) > limit})


@api_view(['GET'])
@permission_classes([IsUserOrGuest])
def version_detail(request, pk, version_id):
    project = get_project(request, pk)
    return Response({'ok': True, 'version': version_json(get_version(project, version_id), detail=True)})


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
