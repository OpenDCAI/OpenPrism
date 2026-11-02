"""AI endpoints. Each queues a Job for the `ai` queue and waits (bounded) so the Node-era response shapes still work.
If the wait runs out the job keeps going and the reply carries its id: poll GET /api/jobs/<id>."""
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

from . import arxiv
from .i18n import get_lang
from .tasks import run_ai_job

MAX_IMAGE_BYTES = 20 * 1024 * 1024


def split_llm_config(cfg):
    """Separate the secret from the rest: only non-secret settings may be stored on the Job row."""
    cfg = cfg if isinstance(cfg, dict) else {}
    public = {k: str(cfg[k]) for k in ('model', 'endpoint') if cfg.get(k)}
    return public, {'apiKey': str(cfg.get('apiKey') or '')}


def workspace_first(request, workspace, public, secrets):
    """The workspace's provider replaces the browser's whole config (endpoint, model and key belong together) when it
    has one and the user may use it; otherwise the browser's config stands (and, without one, the server default)."""
    from integrations.llmconfig import workspace_llm_for
    return workspace_llm_for(workspace, request.user) or (public, secrets)


def run_job(request, job_type, params, secrets, project=None, job_id=None):
    job = Job.objects.create(id=job_id or uuid.uuid4(), type=job_type, user=request.user, project=project, params=params)
    run_ai_job.delay(str(job.id), secrets)
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
    b = _body(request)
    public, secrets = split_llm_config(b.get('llmConfig'))
    if b.get('model') and 'model' not in public:
        public['model'] = str(b['model'])
    if b.get('projectId'):
        public, secrets = workspace_first(request, get_project(request, b['projectId']).workspace, public, secrets)
    return run_job(request, Job.LLM, {'messages': b.get('messages') or [], 'llmConfig': public}, secrets)


@api_view(['POST'])
def agent_run(request):
    b = _body(request)
    public, secrets = split_llm_config(b.get('llmConfig'))
    project = get_project(request, b['projectId']) if b.get('projectId') else None
    if project:
        public, secrets = workspace_first(request, project.workspace, public, secrets)
    params = {k: b.get(k) for k in ('task', 'prompt', 'selection', 'content', 'mode', 'activePath', 'compileLog',
                                    'interaction', 'history')}
    params.update({'llmConfig': public, 'lang': get_lang(request.headers.get('x-lang'))})
    return run_job(request, Job.AGENT, params, secrets, project)


@api_view(['POST'])
@parser_classes([PathMultiPartParser])
def vision_latex(request):
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
        public, secrets = workspace_first(request, project.workspace, public, secrets)
    job_id = uuid.uuid4()
    key = f'jobs/{job_id}/input'
    storage.put_bytes(key, image.read(), image.content_type or 'image/png')
    params = {'imageKey': key, 'imageName': getattr(image, 'full_path', image.name), 'imageType': image.content_type or 'image/png',
              'mode': request.data.get('mode') or 'equation', 'prompt': request.data.get('prompt') or '',
              'llmConfig': public, 'saveToProject': save}
    return run_job(request, Job.VISION, params, secrets, project, job_id)


@api_view(['POST'])
def plot_from_table(request):
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
    public, secrets = workspace_first(request, project.workspace, *split_llm_config(b.get('llmConfig')))
    try:
        retries = min(5, max(0, int(b.get('retries', 2))))
    except (TypeError, ValueError):
        retries = 2
    params = {'tableLatex': b['tableLatex'], 'chartType': b.get('chartType'), 'title': b.get('title'),
              'prompt': b.get('prompt'), 'assetPath': asset_path, 'retries': retries, 'llmConfig': public}
    return run_job(request, Job.PLOT, params, secrets, project)


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
