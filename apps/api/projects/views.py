"""Project / file endpoints. URLs and response shapes follow apps/frontend/src/api/client.ts."""
import base64
import json
import time
import zipfile
from datetime import timezone as dt_timezone

from django.db import transaction
from django.http import HttpResponse, StreamingHttpResponse
from django.utils import timezone
from rest_framework.decorators import api_view, authentication_classes, parser_classes, permission_classes
from rest_framework.exceptions import NotFound, ParseError, PermissionDenied
from rest_framework.parsers import JSONParser
from rest_framework.response import Response

from ai import arxiv
from ai.i18n import get_lang
from collab.auth import IsUserOrGuest
from common.uploads import PathMultiPartParser, upload_path
from common.zips import iter_zip_files
from jobs.models import Job
from templates_app import service as templates
from templates_app.models import Template

from . import files as pfiles
from .tasks import import_arxiv
from .access import QueryTokenJWTAuthentication, get_project, user_projects
from .models import Membership, Project, ProjectFile, Workspace
from .paths import InvalidPath, safe_path
from .tex import extract_document_body, merge_template_body

INERT_TYPES = {'image/png', 'image/jpeg', 'application/pdf'}
IGNORED_IMPORT_PATHS = ('project.json',)
BLOB_TYPES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.eps': 'application/postscript',
}


def iso(dt):
    return dt.astimezone(dt_timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z') if dt else None


def project_meta(p):
    return {
        'id': str(p.id), 'name': p.name, 'createdAt': iso(p.created_at), 'updatedAt': iso(p.updated_at),
        'tags': p.tags, 'archived': p.archived, 'trashed': p.trashed, 'trashedAt': iso(p.trashed_at),
        'fileOrder': p.file_order, 'workspaceId': str(p.workspace_id),
    }


def fail(message, status=200):
    """Node returned {ok: false, error} with HTTP 200 for most business errors; keep that contract."""
    return Response({'ok': False, 'error': message}, status=status)


def _path_or_error(raw):
    try:
        return safe_path(raw)
    except InvalidPath:
        raise ParseError('Invalid path')


def _default_workspace(user, workspace_id=None):
    memberships = Membership.objects.filter(user=user, role__in=Membership.WRITE_ROLES)
    if workspace_id:
        m = memberships.filter(workspace_id=workspace_id).first()
        if not m:
            raise NotFound('Workspace not found')
        return m.workspace
    m = memberships.select_related('workspace').order_by('workspace__created_at').first()
    if m:
        return m.workspace
    return Workspace.objects.create(name='My workspace')  # unreachable for registered users; defensive


def _template_or_404(template_id):
    try:
        return Template.objects.get(pk=template_id)
    except Template.DoesNotExist:
        raise NotFound('Unknown template')


# ---- projects ---------------------------------------------------------------------------------

@api_view(['GET', 'POST'])
@permission_classes([IsUserOrGuest])
def projects_collection(request):
    guest = getattr(request.user, 'is_guest', False)
    if request.method == 'GET':
        if guest:  # an invite-link guest sees exactly the project they were invited to
            return Response({'projects': [project_meta(p) for p in Project.objects.filter(pk=request.user.project_id)]})
        return Response({'projects': [project_meta(p) for p in user_projects(request.user).distinct()]})
    if guest:
        raise PermissionDenied('Guests cannot create projects.')
    name = (request.data.get('name') or 'Untitled').strip() or 'Untitled'
    template_id = request.data.get('template')
    template = _template_or_404(template_id) if template_id else None
    workspace = _default_workspace(request.user, request.data.get('workspaceId'))
    project = Project.objects.create(workspace=workspace, created_by=request.user, name=name)
    if template:
        templates.copy_into_project(template, project)
    return Response(project_meta(project))


@api_view(['POST'])
@parser_classes([PathMultiPartParser])
def import_zip(request):
    upload = request.FILES.get('zip') or next(iter(request.FILES.values()), None)
    if upload is None:
        return fail('Missing zip file.')
    name = str(request.data.get('projectName', '')).strip() or 'Imported Project'
    try:
        entries = list(iter_zip_files(upload, skip=lambda p: p.endswith(IGNORED_IMPORT_PATHS)))
    except (zipfile.BadZipFile, ValueError) as exc:
        return fail(f'Failed to extract zip: {exc}')
    workspace = _default_workspace(request.user, request.data.get('workspaceId'))
    project = Project.objects.create(workspace=workspace, created_by=request.user, name=name)
    try:
        for path, data in entries:
            pfiles.write_file(project, path, data)
    except Exception as exc:
        pfiles.delete_project_files(project)
        project.delete()
        return fail(f'Failed to extract zip: {exc}')
    return Response({'ok': True, 'project': project_meta(project)})


@api_view(['DELETE'])
def project_trash_delete(request, pk):
    project = get_project(request, pk, write=True)
    project.trashed, project.trashed_at = True, timezone.now()
    project.save(update_fields=['trashed', 'trashed_at'])
    return Response({'ok': True})


@api_view(['DELETE'])
def project_permanent_delete(request, pk):
    project = get_project(request, pk, write=True)
    pfiles.delete_project_files(project)
    project.delete()
    return Response({'ok': True})


@api_view(['POST'])
def rename_project(request, pk):
    project = get_project(request, pk, write=True)
    name = request.data.get('name')
    if not name:
        return fail('Missing name')
    project.name = name
    project.save(update_fields=['name', 'updated_at'])
    return Response({'ok': True, 'project': project_meta(project)})


@api_view(['POST'])
def copy_project(request, pk):
    src = get_project(request, pk)
    workspace = _default_workspace(request.user, src.workspace_id)
    with transaction.atomic():
        dst = Project.objects.create(
            workspace=workspace, created_by=request.user, tags=src.tags, archived=src.archived,
            file_order=src.file_order, name=request.data.get('name') or f'{src.name} (Copy)')
        pfiles.copy_project_files(src, dst)
    return Response({'ok': True, 'project': project_meta(dst)})


@api_view(['PATCH'])
def project_tags(request, pk):
    project = get_project(request, pk, write=True)
    tags = request.data.get('tags')
    if not isinstance(tags, list):
        return fail('tags must be an array')
    project.tags = [str(t) for t in tags]
    project.save(update_fields=['tags', 'updated_at'])
    return Response({'ok': True, 'project': project_meta(project)})


@api_view(['PATCH'])
def project_archive(request, pk):
    project = get_project(request, pk, write=True)
    project.archived = bool(request.data.get('archived'))
    project.save(update_fields=['archived', 'updated_at'])
    return Response({'ok': True, 'project': project_meta(project)})


@api_view(['PATCH'])
def project_trash(request, pk):
    project = get_project(request, pk, write=True)
    project.trashed = bool(request.data.get('trashed'))
    project.trashed_at = timezone.now() if project.trashed else None
    project.save(update_fields=['trashed', 'trashed_at', 'updated_at'])
    return Response({'ok': True, 'project': project_meta(project)})


def _may_write(request, project):
    try:
        get_project(request, project.id, write=True)
    except PermissionDenied:
        return False
    return True


# ---- files ------------------------------------------------------------------------------------

@api_view(['GET'])
@permission_classes([IsUserOrGuest])
def tree(request, pk):
    project = get_project(request, pk)
    return Response({'items': pfiles.list_tree(project), 'fileOrder': project.file_order, 'canWrite': _may_write(request, project)})


@api_view(['POST'])
@permission_classes([IsUserOrGuest])
def file_order(request, pk):
    project = get_project(request, pk, write=True)
    order = request.data.get('order')
    if not isinstance(order, list):
        return fail('Missing order.')
    project.file_order = {**project.file_order, request.data.get('folder', ''): [str(o) for o in order]}
    project.save(update_fields=['file_order'])
    return Response({'ok': True})


@api_view(['GET', 'PUT', 'DELETE'])
@permission_classes([IsUserOrGuest])
def file_item(request, pk):
    if request.method == 'PUT':
        project = get_project(request, pk, write=True)
        raw = request.data.get('path')
        if not raw:
            return Response({'ok': False})
        content = request.data.get('content') or ''
        try:
            pfiles.write_text(project, _path_or_error(raw), content)
        except IsADirectoryError as exc:
            return fail(str(exc), 409)
        return Response({'ok': True})

    raw = request.query_params.get('path')
    if request.method == 'DELETE':
        project = get_project(request, pk, write=True)
        if not raw:
            return fail('Missing file path')
        try:
            pfiles.delete(project, raw)
        except pfiles.FileNotFound:
            return fail('File not found')
        except InvalidPath:
            raise ParseError('Invalid path')
        return Response({'ok': True})

    project = get_project(request, pk)
    if not raw:
        return Response({'content': ''})
    try:
        return Response({'content': pfiles.read_text(project, raw)})
    except pfiles.FileNotFound:
        raise NotFound('File not found')
    except InvalidPath:
        raise ParseError('Invalid path')


@api_view(['GET'])
@authentication_classes([QueryTokenJWTAuthentication])
@permission_classes([IsUserOrGuest])
def blob(request, pk):
    project = get_project(request, pk)
    raw = request.query_params.get('path')
    if not raw:
        raise ParseError('Missing path')
    path = _path_or_error(raw)
    try:
        data = pfiles.read_bytes(project, path)
    except pfiles.FileNotFound:
        raise NotFound('File not found')
    row = project.files.get(path=path)
    ext = '.' + path.rsplit('.', 1)[-1].lower() if '.' in path.rsplit('/', 1)[-1] else ''
    resp = HttpResponse(data, content_type=BLOB_TYPES.get(ext) or row.content_type or 'application/octet-stream')
    if resp['Content-Type'] not in INERT_TYPES:
        # User-supplied SVG/HTML/unknown must not run script in our origin. (Not applied to PDFs and
        # rasters: Chrome refuses to render a PDF served with a sandbox CSP.)
        resp['Content-Security-Policy'] = 'sandbox'
    resp['X-Content-Type-Options'] = 'nosniff'
    return resp


@api_view(['POST'])
@parser_classes([PathMultiPartParser])
@permission_classes([IsUserOrGuest])
def upload(request, pk):
    project = get_project(request, pk, write=True)
    saved = []
    for f in request.FILES.getlist('files'):
        path = upload_path(f)
        if not path:
            continue
        try:
            pfiles.write_file(project, path, f.read(), f.content_type)
        except IsADirectoryError as exc:
            return fail(str(exc), 409)
        saved.append(path)
    return Response({'ok': True, 'files': saved})


@api_view(['GET'])
@permission_classes([IsUserOrGuest])
def all_files(request, pk):
    """Whole project inline. Heavy; kept because the editor loads it for compile and search."""
    project = get_project(request, pk)
    out = []
    for row in project.files.exclude(kind=ProjectFile.DIR).order_by('path'):
        if row.kind == ProjectFile.TEXT:
            out.append({'path': row.path, 'content': row.content, 'encoding': 'utf8'})
        else:
            data = pfiles.read_bytes(project, row.path)
            out.append({'path': row.path, 'content': base64.b64encode(data).decode(), 'encoding': 'base64'})
    return Response({'files': out})


@api_view(['POST'])
@permission_classes([IsUserOrGuest])
def create_folder(request, pk):
    project = get_project(request, pk, write=True)
    raw = request.data.get('path')
    if not raw:
        return Response({'ok': False})
    try:
        pfiles.mkdir(project, _path_or_error(raw))
    except (IsADirectoryError, FileExistsError) as exc:
        return fail(str(exc), 409)
    return Response({'ok': True})


@api_view(['POST'])
@permission_classes([IsUserOrGuest])
def rename_path(request, pk):
    project = get_project(request, pk, write=True)
    src, dst = request.data.get('from'), request.data.get('to')
    if not src or not dst:
        return Response({'ok': False})
    try:
        pfiles.rename(project, src, dst)
    except pfiles.FileNotFound:
        return fail('File not found')
    except (FileExistsError, ValueError) as exc:
        return fail(str(exc), 409)
    except InvalidPath:
        raise ParseError('Invalid path')
    return Response({'ok': True})


# ---- templates --------------------------------------------------------------------------------

@api_view(['POST'])
def apply_template(request, pk):
    project = get_project(request, pk, write=True)
    template_id = request.data.get('template')
    if not template_id:
        return Response({'ok': False})
    templates.copy_into_project(_template_or_404(template_id), project)
    return Response({'ok': True})


@api_view(['POST'])
def convert_template(request, pk):
    project = get_project(request, pk, write=True)
    target = request.data.get('targetTemplate')
    main_file = request.data.get('mainFile') or 'main.tex'
    if not target:
        return fail('Missing targetTemplate')
    template = Template.objects.filter(pk=target).first()
    if not template:
        return fail('Unknown template')
    try:
        main_file = _path_or_error(main_file)
        try:
            current = pfiles.read_text(project, main_file)
        except pfiles.FileNotFound:
            current = ''
        template_main = template.main_file or 'main.tex'
        template_tex = templates.read(template, template_main).decode('utf-8')
        merged = merge_template_body(template_tex, extract_document_body(current))
        changed = templates.merge_into_project(template, project)
        pfiles.write_text(project, template_main, merged)
        changed.append(template_main)
    except Exception as exc:
        return fail(f'Template convert failed: {exc}')
    return Response({'ok': True, 'mainFile': template_main, 'changedFiles': changed})


# ---- arXiv import (server-sent events) --------------------------------------------------------------

def _sse(event, data):
    return f'event: {event}\ndata: {json.dumps(data)}\n\n'.encode()


@api_view(['GET'])
@authentication_classes([QueryTokenJWTAuthentication])
def import_arxiv_sse(request):
    """Create a project from an arXiv paper. EventSource cannot set headers, so auth is `?token=`.

    The download/extract runs in a worker (queue `import`); this response just relays its progress.
    """
    arxiv_id = arxiv.extract_id(request.query_params.get('arxivIdOrUrl'))
    headers = {'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'}  # no proxy buffering, or events arrive in a lump
    if not arxiv_id:
        return StreamingHttpResponse(iter([_sse('error', {'error': 'Invalid arXiv ID.'})]),
                                     content_type='text/event-stream', headers=headers)
    workspace = _default_workspace(request.user, request.query_params.get('workspaceId'))
    name = request.query_params.get('projectName') or f'arxiv-{arxiv_id}'
    job = Job.objects.create(type=Job.IMPORT, user=request.user, params={
        'arxivId': arxiv_id, 'name': name, 'workspaceId': str(workspace.id),
        'lang': get_lang(request.headers.get('x-lang'))})
    import_arxiv.delay(str(job.id))

    def stream():
        deadline = time.monotonic() + 960
        last = None
        while time.monotonic() < deadline:
            job.refresh_from_db()
            progress = job.result.get('progress')
            if progress and progress != last:
                last = progress
                yield _sse('progress', progress)
            if job.status == Job.SUCCESS:
                project = Project.objects.get(pk=job.result['projectId'])
                yield _sse('done', {'ok': True, 'project': project_meta(project)})
                return
            if job.status == Job.FAILED:
                yield _sse('error', {'error': job.error})
                return
            time.sleep(0.4)
        yield _sse('error', {'error': 'Import timed out.'})

    return StreamingHttpResponse(stream(), content_type='text/event-stream', headers=headers)
