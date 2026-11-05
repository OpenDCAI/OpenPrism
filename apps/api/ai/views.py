"""AI endpoints. Each queues a Job for the `ai` queue. With `async: true` in the body the reply is `{ok, jobId}` at once
and the client polls GET /api/jobs/<id> (its `result` is the body below); the frontend always does this. Without it the
view waits (bounded, holding a web thread; deprecated) so the Node-era response shapes still work, and if the wait runs
out the job keeps going and the reply carries its id."""
import json
import time
import uuid

from django.conf import settings
from rest_framework.decorators import api_view, parser_classes
from rest_framework.response import Response

from common.uploads import PathMultiPartParser
from jobs.models import Job
from jobs.tasks import ACTIVE
from projects import storage
from projects.access import get_project
from projects.paths import InvalidPath, safe_path, sanitize_upload_path

from common import ratelimit

from . import arxiv, usage
from .i18n import get_lang
from .tasks import run_ai_job

MAX_IMAGE_BYTES = 20 * 1024 * 1024


def split_llm_config(cfg):
    """Separate the secret from the rest: only non-secret settings may be stored on the Job row."""
    cfg = cfg if isinstance(cfg, dict) else {}
    public = {k: str(cfg[k]) for k in ('model', 'endpoint') if cfg.get(k)}
    return public, {'apiKey': str(cfg.get('apiKey') or '')}


def limit_rate(request):
    """AI_RATE_PER_MINUTE per user across the AI endpoints (429 with Retry-After)."""
    ratelimit.enforce('ai', request.user, settings.AI_RATE_PER_MINUTE)


def wants_async(request):
    """`async: true` in a JSON body, or `async=1|true` as a multipart field."""
    value = request.data.get('async') if hasattr(request.data, 'get') else None
    return value is True or str(value).lower() in ('1', 'true')


def run_job(request, job_type, params, paid, project=None, job_id=None, charged=False):
    """`paid` is usage.resolve()'s (public, secrets, source); the job is charged to it (policy, daily limits) first,
    unless the view already did (`charged`)."""
    public, secrets, source = paid
    if not charged:
        usage.charge(request, source, project.workspace if project else None)
    params = {**params, 'llmConfig': public, 'keySource': source}
    job = Job.objects.create(id=job_id or uuid.uuid4(), type=job_type, user=request.user, project=project, params=params)
    run_ai_job.delay(str(job.id), secrets)
    if wants_async(request):
        return Response({'ok': True, 'jobId': str(job.id), 'status': job.status})
    deadline = time.monotonic() + settings.AI_WAIT_SECONDS
    while time.monotonic() < deadline:
        job.refresh_from_db()
        if job.status not in ACTIVE:
            return Response(job.result.get('body') or {'ok': False, 'error': job.error or 'AI job failed.'})
        time.sleep(0.25)
    return Response({'ok': False, 'error': 'Timed out waiting for the AI job; it is still running.', 'jobId': str(job.id)})


def _body(request):
    return request.data if isinstance(request.data, dict) else {}


@api_view(['POST'])
def llm_endpoint(request):
    limit_rate(request)
    b = _body(request)
    public, secrets = split_llm_config(b.get('llmConfig'))
    if b.get('model') and 'model' not in public:
        public['model'] = str(b['model'])
    project = get_project(request, b['projectId']) if b.get('projectId') else None
    paid = usage.resolve(request, project.workspace if project else None, public, secrets)
    return run_job(request, Job.LLM, {'messages': b.get('messages') or []}, paid, project)


def edit_rate_limited(user):
    """True when `user` has used up this minute's in-place edit requests (each one can run a many-step agent)."""
    return bool(ratelimit.hit('ai-edit', ratelimit.ident_for(user), settings.AI_EDIT_RATE_PER_MINUTE))


MAX_SELECTION = 20000
MAX_EDIT_CONTENT = 400000


def clean_edit_context(project, raw):
    """Validate the editor context of an in-place edit; returns (context, error)."""
    from projects import files as pfiles
    if not isinstance(raw, dict):
        return None, 'editContext must be an object.'
    active, main = raw.get('activeFile'), raw.get('mainFile') or ''
    try:
        active, main = safe_path(active), (safe_path(main) if main else '')
    except (InvalidPath, TypeError, AttributeError):
        return None, 'editContext has an invalid file path.'
    try:
        pfiles.read_text(project, active)
    except pfiles.FileNotFound:
        return None, f'File not found: {active}'
    cursor, selection = raw.get('cursor') or {}, raw.get('selection')
    try:
        cursor = {'line': max(int(cursor.get('line', 1)), 1), 'col': max(int(cursor.get('col', 1)), 1)}
    except (TypeError, ValueError, AttributeError):
        return None, 'editContext.cursor needs numeric line and col.'
    sel = selection.get('text') if isinstance(selection, dict) else None
    if sel is not None and (not isinstance(sel, str) or len(sel) > MAX_SELECTION):
        return None, f'The selection is too large (limit {MAX_SELECTION} characters).'
    content = raw.get('content')
    if content is not None and (not isinstance(content, str) or len(content) > MAX_EDIT_CONTENT):
        return None, 'The file text sent with the request is too large.'
    return {'activeFile': active, 'mainFile': main, 'cursor': cursor, 'content': content,
            'selection': {'text': sel} if sel else None}, None


@api_view(['POST'])
def agent_run(request):
    limit_rate(request)
    b = _body(request)
    public, secrets = split_llm_config(b.get('llmConfig'))
    edit = b.get('editContext') is not None
    project = get_project(request, b['projectId'], write=edit) if b.get('projectId') else None
    if edit:  # an in-place edit needs tools mode and a project the user may change
        if project is None:
            return Response({'ok': False, 'error': 'editContext needs a projectId.'})
        b['editContext'], error = clean_edit_context(project, b['editContext'])
        if error:
            return Response({'ok': False, 'error': error})
        b['mode'] = 'tools'
        if edit_rate_limited(request.user):
            return Response({'ok': False, 'error': 'Too many AI requests. Try again in a minute.'}, status=429)
        try:  # the editor picks the job id so it can cancel the request while it is still running
            job_id = uuid.UUID(str(b['jobId'])) if b.get('jobId') else None
        except ValueError:
            return Response({'ok': False, 'error': 'jobId must be a UUID.'})
    paid = usage.resolve(request, project.workspace if project else None, public, secrets)
    params = {k: b.get(k) for k in ('task', 'prompt', 'selection', 'content', 'mode', 'activePath', 'compileLog',
                                    'interaction', 'history', 'editContext')}
    params['lang'] = get_lang(request.headers.get('x-lang'))
    return run_job(request, Job.AGENT, params, paid, project, job_id=job_id if edit else None)


@api_view(['POST'])
@parser_classes([PathMultiPartParser])
def vision_latex(request):
    limit_rate(request)
    image = request.FILES.get('image') or next(iter(request.FILES.values()), None)
    if image is None:
        return Response({'ok': False, 'error': 'Missing image.'})
    if image.size > MAX_IMAGE_BYTES:
        return Response({'ok': False, 'error': 'Image is too large (max 20 MB).'})
    try:
        cfg = json.loads(request.data.get('llmConfig') or '{}')
    except ValueError:
        cfg = {}
    public, secrets = split_llm_config(cfg)
    project, save = None, False
    if request.data.get('projectId'):
        project = get_project(request, request.data['projectId'])
        from projects.models import Membership
        save = Membership.objects.filter(workspace_id=project.workspace_id, user=request.user,
                                         role__in=Membership.WRITE_ROLES).exists()
    paid = usage.resolve(request, project.workspace if project else None, public, secrets)
    usage.charge(request, paid[2], project.workspace if project else None)  # before storing the upload
    job_id = uuid.uuid4()
    key = f'jobs/{job_id}/input'
    storage.put_bytes(key, image.read(), image.content_type or 'image/png')
    params = {'imageKey': key, 'imageName': getattr(image, 'full_path', image.name), 'imageType': image.content_type or 'image/png',
              'mode': request.data.get('mode') or 'equation', 'prompt': request.data.get('prompt') or '',
              'saveToProject': save}
    return run_job(request, Job.VISION, params, paid, project, job_id, charged=True)


@api_view(['POST'])
def plot_from_table(request):
    limit_rate(request)
    b = _body(request)
    if not b.get('projectId'):
        return Response({'ok': False, 'error': 'Missing projectId.'})
    if not b.get('tableLatex'):
        return Response({'ok': False, 'error': 'Missing tableLatex.'})
    project = get_project(request, b['projectId'], write=True)
    name = sanitize_upload_path(b.get('filename') or '') or f'plot_{int(time.time() * 1000)}.png'
    if '.' not in name.rsplit('/', 1)[-1]:
        name += '.png'
    try:
        asset_path = safe_path(f'assets/plots/{name}')
    except InvalidPath:
        return Response({'ok': False, 'error': 'Invalid filename.'})
    paid = usage.resolve(request, project.workspace, *split_llm_config(b.get('llmConfig')))
    try:
        retries = min(5, max(0, int(b.get('retries', 2))))
    except (TypeError, ValueError):
        retries = 2
    params = {'tableLatex': b['tableLatex'], 'chartType': b.get('chartType'), 'title': b.get('title'),
              'prompt': b.get('prompt'), 'assetPath': asset_path, 'retries': retries}
    return run_job(request, Job.PLOT, params, paid, project)


@api_view(['POST'])
def arxiv_search(request):
    b = _body(request)
    return Response(arxiv.search(b.get('query'), b.get('maxResults')))


@api_view(['POST'])
def arxiv_bibtex(request):
    arxiv_id = arxiv.extract_id(_body(request).get('arxivId'))
    if not arxiv_id:
        return Response({'ok': False, 'error': 'Invalid arXiv ID.'})
    try:
        entry = arxiv.fetch_entry(arxiv_id)
    except Exception as exc:
        return Response({'ok': False, 'error': str(exc)})
    if not entry:
        return Response({'ok': False, 'error': 'No arXiv metadata found.'})
    return Response({'ok': True, 'bibtex': arxiv.build_bibtex(entry), 'entry': entry})
