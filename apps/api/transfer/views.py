"""Template transfer endpoints (port of routes/transfer.js).

Same URLs and response shapes as the Node backend, but the work happens in Celery: /step no longer blocks
for the whole run; it starts the job on first call and afterwards just reports status.
"""
import json
import uuid

from django.db import transaction
from rest_framework.decorators import api_view, parser_classes
from rest_framework.response import Response

from ai import usage
from integrations import aiprofiles
from ai.views import limit_rate, split_llm_config
from common import secrets as job_secrets
from common.uploads import PathMultiPartParser
from jobs.models import Job
from jobs.views import get_job
from projects import files as pfiles
from projects import storage
from projects.access import get_project
from projects.models import Membership, Project, Workspace
from templates_app import service as templates
from templates_app.models import Template

from . import mineru
from .tasks import run_transfer_segment

MAX_PAGE_IMAGES_BYTES = 100 * 1024 * 1024
MAX_UPLOAD_PDF_BYTES = 200 * 1024 * 1024


def bad(message, status=400):
    return Response({'ok': False, 'error': message}, status=status)


def transfer_job(request, job_id):
    """The job if it is a transfer job the user may access; otherwise None."""
    try:
        job = get_job(request, job_id)
    except Exception:
        return None
    return job if job.type == Job.TRANSFER else None


def status_name(job):
    return 'pending' if job.status == Job.QUEUED else job.status  # Node vocabulary


def status_body(job):
    return {'status': status_name(job), 'progressLog': job.progress_log, 'error': job.error or None,
            'targetDeleted': bool(job.result.get('targetDeleted'))}


def _create_job(request, mode, b):
    """Shared by both start endpoints: validates, creates the target project from the template, creates the Job."""
    template = Template.objects.filter(pk=b.get('targetTemplateId')).first()
    if not template:
        return None, bad(f"Unknown template: {b.get('targetTemplateId')}")
    source = get_project(request, b['sourceProjectId']) if b.get('sourceProjectId') else None
    workspace = (Workspace.objects.filter(memberships__user=request.user, memberships__role__in=Membership.WRITE_ROLES,
                                          id=source.workspace_id).first() if source else None) or Workspace.objects.filter(
        memberships__user=request.user, memberships__role__in=Membership.WRITE_ROLES).order_by('created_at').first()
    if workspace is None:
        return None, bad('You do not have a workspace you can write to.', 403)
    paid = usage.resolve(request, workspace, *split_llm_config(b.get('llmConfig')), project=source)
    public, secrets, key_source = paid
    usage.charge(request, key_source, workspace, paid=paid)
    params = {
        'mode': mode, 'sourceProjectId': str(source.id) if source else '', 'sourceMainFile': b.get('sourceMainFile') or '',
        'targetMainFile': b['targetMainFile'], 'engine': b.get('engine') or 'pdflatex',
        'layoutCheck': bool(b.get('layoutCheck')), 'llmConfig': public, 'keySource': key_source,
    }
    if mode == 'mineru':
        mineru_cfg = mineru.public_part(b.get('mineruConfig'))
        secrets['mineruToken'] = str((b.get('mineruConfig') or {}).get('token') or '').strip()
        saved = None if secrets['mineruToken'] else aiprofiles.usable(request.user, source, workspace, aiprofiles.MINERU)
        if saved:  # the project's or workspace's MinerU token, with the API base saved alongside it (or the server's)
            secrets['mineruToken'] = saved[1]
            mineru_cfg['apiBase'] = saved[0].get('endpoint', '')
        params['mineruConfig'] = mineru_cfg
    with transaction.atomic():
        target = Project.objects.create(workspace=workspace, created_by=request.user,
                                        name=f"{source.name if source else 'Untitled'} ({template.label})")
        templates.copy_into_project(template, target)
        params['targetProjectId'] = str(target.id)
        job = Job.objects.create(type=Job.TRANSFER, user=request.user, project=target, params=params,
                                 result={'state': {'entry': 'start', 'segment': 1}})
    job_secrets.put(str(job.id), secrets)
    return (job, target), None


@api_view(['POST'])
def start(request):
    limit_rate(request)
    b = request.data if isinstance(request.data, dict) else {}
    if not all(b.get(k) for k in ('sourceProjectId', 'sourceMainFile', 'targetTemplateId', 'targetMainFile')):
        return bad('Missing required fields.')
    created, error = _create_job(request, 'legacy', b)
    if error:
        return error
    job, target = created
    return Response({'jobId': str(job.id), 'newProjectId': str(target.id)})


@api_view(['POST'])
def start_mineru(request):
    limit_rate(request)
    b = request.data if isinstance(request.data, dict) else {}
    if not b.get('targetTemplateId') or not b.get('targetMainFile'):
        return bad('Missing targetTemplateId or targetMainFile.')
    if bool(b.get('sourceProjectId')) != bool(b.get('sourceMainFile')):
        return bad('sourceProjectId and sourceMainFile must be provided together, or both omitted.')
    created, error = _create_job(request, 'mineru', b)
    if error:
        return error
    job, target = created
    return Response({'jobId': str(job.id), 'newProjectId': str(target.id)})


@api_view(['POST'])
def step(request):
    """First call starts the job; every call returns the current status (the UI polls this)."""
    job = transfer_job(request, (request.data or {}).get('jobId'))
    if job is None:
        return bad('Job not found.', 404)
    # Atomic claim so two concurrent first calls cannot enqueue the job twice.
    if Job.objects.filter(pk=job.pk, status=Job.QUEUED).update(status=Job.RUNNING):
        job.refresh_from_db()
        run_transfer_segment.delay(str(job.id), job.result['state']['segment'])
    job.refresh_from_db()
    return Response(status_body(job))


@api_view(['POST'])
def submit_images(request):
    b = request.data if isinstance(request.data, dict) else {}
    job = transfer_job(request, b.get('jobId'))
    if job is None:
        return bad('Job not found.', 404)
    images = b.get('images') or []
    payload = json.dumps(images).encode()
    if len(payload) > MAX_PAGE_IMAGES_BYTES:
        return bad('Page images are too large.', 413)
    key = f'jobs/{job.id}/page_images.json'
    with transaction.atomic():
        locked = Job.objects.select_for_update().get(pk=job.pk)
        if locked.status != Job.WAITING_IMAGES:
            return bad('Job is not waiting for images.')
        storage.put_bytes(key, payload, 'application/json')
        state = locked.result['state']
        state.update({'pageImagesKey': key, 'entry': 'checkLayout', 'segment': state['segment'] + 1})
        locked.result = {**locked.result, 'state': state}
        locked.status = Job.RUNNING
        locked.save(update_fields=['result', 'status', 'updated_at'])
        segment = state['segment']
    run_transfer_segment.delay(str(job.id), segment)
    return Response({'ok': True})


@api_view(['GET'])
def status(request, job_id):
    job = transfer_job(request, job_id)
    if job is None:
        return bad('Job not found.', 404)
    return Response(status_body(job))


@api_view(['POST'])
@parser_classes([PathMultiPartParser])
def upload_pdf(request):
    job = transfer_job(request, request.data.get('jobId'))
    if not request.data.get('jobId'):
        return bad('Missing jobId.')
    if job is None:
        return bad('Job not found.', 404)
    if job.params.get('mode') != 'mineru':
        return bad('Job is not a MinerU transfer job.')
    upload = request.FILES.get('pdf')
    if upload is None:
        return bad('No PDF file uploaded.')
    if upload.size > MAX_UPLOAD_PDF_BYTES:
        return bad('PDF is too large (max 200 MB).', 413)
    if job.status != Job.QUEUED:
        return bad('The transfer has already started.')
    key = f'jobs/{job.id}/source.pdf'
    storage.put_bytes(key, upload.read(), 'application/pdf')
    with transaction.atomic():
        locked = Job.objects.select_for_update().get(pk=job.pk)
        state = locked.result['state']
        state['sourcePdfKey'] = key
        locked.result = {**locked.result, 'state': state}
        locked.save(update_fields=['result', 'updated_at'])
    return Response({'ok': True, 'pdfPath': key})
