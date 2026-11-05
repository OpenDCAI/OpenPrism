from django.conf import settings
from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.exceptions import NotFound
from rest_framework.response import Response

from common import ratelimit
from projects import storage
from collab.auth import IsUserOrGuest
from projects.access import QueryTokenJWTAuthentication, get_project
from projects.models import Membership
from projects.paths import InvalidPath, safe_path

from .compile import SUPPORTED_ENGINES
from .models import Job
from .tasks import ACTIVE, compile_project

MAX_ACTIVE_COMPILES_PER_USER = 3


def fail(message, status=200):
    return Response({'ok': False, 'error': message}, status=status)


def _clean_focus(raw):
    """The optional caret position {file, line} sent with a compile. Best effort: anything malformed is ignored."""
    if not isinstance(raw, dict):
        return None
    try:
        line = int(raw.get('line'))
        file = safe_path(raw.get('file'))
    except (TypeError, ValueError, InvalidPath):
        return None
    return {'file': file, 'line': line} if 1 <= line <= 10_000_000 else None


def get_job(request, job_id):
    job = get_object_or_404(Job.objects.select_related('project'), pk=job_id)
    if getattr(request.user, 'is_guest', False):
        allowed = bool(job.project_id) and str(job.project_id) == request.user.project_id
    else:
        allowed = job.user_id == request.user.id or (
            job.project_id and Membership.objects.filter(workspace_id=job.project.workspace_id, user=request.user).exists())
    if not allowed:
        raise NotFound('Job not found')
    return job


@api_view(['POST'])
def job_cancel(request, pk):
    """Stop an AI job its owner started: the waiting request returns at once and the worker stops before its next step."""
    job = get_job(request, pk)
    if job.user_id != request.user.id:
        raise NotFound('Job not found')
    if job.status in ACTIVE and job.type != Job.COMPILE:
        body = {'ok': False, 'error': 'Cancelled.', 'cancelled': True}
        job.status, job.error = Job.FAILED, 'Cancelled.'
        job.result = {**job.result, 'cancelled': True, 'body': body}
        job.save(update_fields=['status', 'error', 'result', 'updated_at'])
    return Response({'ok': True, 'status': job.status})


def job_json(job):
    out = {
        'ok': True, 'jobId': str(job.id), 'type': job.type, 'status': job.status,
        'progressLog': job.progress_log, 'error': job.error,
        'createdAt': job.created_at.isoformat(), 'updatedAt': job.updated_at.isoformat(),
    }
    if job.status not in ACTIVE and job.type == Job.COMPILE:
        r = job.result
        out['result'] = {
            'log': r.get('log', ''), 'status': r.get('exitStatus'), 'engine': r.get('engine'), 'mainFile': r.get('mainFile'),
            'pdfUrl': f'/api/jobs/{job.id}/pdf' if r.get('pdfKey') else None,
            'focus': r.get('focus'),  # {page, x, y} of the caret's source line in the PDF, when it could be found
            'versionId': r.get('versionId'), 'versionNumber': r.get('versionNumber'), 'versionCreated': r.get('versionCreated'),
        }
    if job.status not in ACTIVE and job.type != Job.COMPILE:
        out['result'] = job.result.get('body')  # the endpoint's response body; never contains secrets
    return out


@api_view(['POST'])
@permission_classes([IsUserOrGuest])
def start_compile(request):
    """Queue a compilation. Poll GET /api/jobs/<jobId>, then fetch the PDF from result.pdfUrl."""
    project_id = request.data.get('projectId')
    main_file = request.data.get('mainFile') or 'main.tex'
    engine = request.data.get('engine') or 'pdflatex'
    if not project_id:
        return fail('Missing projectId.')
    ratelimit.enforce('compile', request.user, settings.COMPILE_RATE_PER_MINUTE)
    if engine not in SUPPORTED_ENGINES:
        return fail(f"Unsupported engine: {engine}. Supported: {', '.join(SUPPORTED_ENGINES)}")
    project = get_project(request, project_id)
    try:
        main_file = safe_path(main_file)
    except InvalidPath:
        return fail('Invalid main file path.')
    if not project.files.filter(path=main_file).exclude(kind='dir').exists():
        return fail(f'Main file not found: {main_file}')
    guest = getattr(request.user, 'is_guest', False)
    owner = None if guest else request.user  # guests have no account; limit them per project instead
    active = Job.objects.filter(user=owner, project=project if guest else None, type=Job.COMPILE, status__in=ACTIVE) \
        if guest else Job.objects.filter(user=owner, type=Job.COMPILE, status__in=ACTIVE)
    if active.count() >= MAX_ACTIVE_COMPILES_PER_USER:
        return fail('Too many compilations in progress. Wait for one to finish.', 429)
    params = {'mainFile': main_file, 'engine': engine}
    focus = _clean_focus(request.data.get('focus'))
    if focus:
        params['focus'] = focus
    job = Job.objects.create(type=Job.COMPILE, user=owner, project=project, params=params, progress_log=['Queued'])
    compile_project.delay(str(job.id))
    return Response({'ok': True, 'jobId': str(job.id), 'status': job.status})


@api_view(['GET'])
@permission_classes([IsUserOrGuest])
def job_status(request, pk):
    return Response(job_json(get_job(request, pk)))


@api_view(['GET'])
@authentication_classes([QueryTokenJWTAuthentication])
@permission_classes([IsUserOrGuest])
def job_pdf(request, pk):
    job = get_job(request, pk)
    key = job.result.get('pdfKey')
    if not key:
        raise NotFound('No PDF for this job')
    resp = HttpResponse(storage.get_bytes(key), content_type='application/pdf')
    resp['X-Content-Type-Options'] = 'nosniff'
    return resp
