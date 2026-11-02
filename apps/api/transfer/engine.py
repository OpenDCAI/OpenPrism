"""Transfer state machine: runs the node graph in resumable segments.

Replaces the LangGraph graphs (graph.js / graphMineru.js). A *segment* runs nodes until the job finishes or
reaches the pause before `checkLayout` (waiting for page screenshots). Segments are restartable from their entry
point, so a crashed segment can simply be run again; only small state is persisted between segments.
Secrets are never part of the state: they come from common.secrets (Redis).
"""
import logging

from django.db import connection

from common import secrets as job_secrets
from jobs.models import Job
from projects import storage
from projects.models import Project

from . import nodes
from .llmjson import TransferError

log = logging.getLogger(__name__)

FIRST = {'legacy': 'analyzeSource', 'mineru': 'compileSource'}
# State that survives between segments (everything else is recomputed within a segment).
PERSISTED = ('entry', 'segment', 'started', 'compileAttempt', 'layoutAttempt', 'compileResult', 'layoutCheckResult',
             'pageImagesKey', 'sourcePdfKey')
TERMINAL = (Job.SUCCESS, Job.FAILED)


def next_node(node, s, mode):
    """The graph's edges (identical for both modes after analyzeTarget)."""
    if node == 'analyzeTarget':
        return 'draftPlan' if mode == 'legacy' else 'applyTransfer'
    if node == 'compile':
        result = s.get('compileResult') or {}
        if result.get('ok'):
            return 'requestPageImages' if s.get('_layoutCheck') else 'finalize'
        return 'fixCompile' if s.get('compileAttempt', 0) < nodes.MAX_COMPILE_LOOPS else 'finalize'
    if node == 'checkLayout':
        if (s.get('layoutCheckResult') or {}).get('ok'):
            return 'finalize'
        return 'fixLayout' if s.get('layoutAttempt', 0) < nodes.MAX_LAYOUT_LOOPS else 'finalize'
    return {
        'analyzeSource': 'analyzeTarget', 'draftPlan': 'applyTransfer', 'applyTransfer': 'copyAssets',
        'copyAssets': 'compile', 'fixCompile': 'compile', 'requestPageImages': 'checkLayout', 'fixLayout': 'compile',
        'compileSource': 'parsePdfWithMineru', 'parsePdfWithMineru': 'analyzeTarget', 'finalize': None,
    }[node]


class Run:
    def __init__(self, job, secrets):
        self.job, self.params, self.secrets = job, job.params, secrets
        self.s = dict(job.result.get('state') or {})
        self.s['_layoutCheck'] = bool(self.params.get('layoutCheck'))
        self._target = self._source = None

    @property
    def target(self):
        if self._target is None:
            self._target = Project.objects.get(pk=self.params['targetProjectId'])
        return self._target

    @property
    def source(self):
        if self._source is None and self.params.get('sourceProjectId'):
            self._source = Project.objects.get(pk=self.params['sourceProjectId'])
        return self._source

    def llm_cfg(self):
        return {**(self.params.get('llmConfig') or {}), 'apiKey': self.secrets.get('apiKey', '')}

    def key(self, name):
        return f'jobs/{self.job.id}/{name}'

    def beat(self, message=None):
        """Heartbeat (stops the stale-job reaper); optionally add a line to the visible log."""
        if message:
            self.job.progress_log = [*self.job.progress_log, message]
        self.job.save(update_fields=['progress_log', 'updated_at'])

    def checkpoint(self):
        self.job.save(update_fields=['progress_log', 'status', 'updated_at'])

    def save(self):
        state = {k: self.s[k] for k in PERSISTED if k in self.s}
        self.job.result = {**self.job.result, 'state': state}
        self.job.save(update_fields=['result', 'progress_log', 'status', 'error', 'updated_at'])


def _lock_key(job_id):
    return job_id.int & 0x7FFFFFFFFFFFFFFF


def run_segment(job_id, segment):
    """Run one segment. Safe to call twice concurrently or after a redelivery: extra callers return immediately."""
    with connection.cursor() as cur:
        cur.execute('SELECT pg_try_advisory_lock(%s)', [_lock_key(job_id)])
        if not cur.fetchone()[0]:
            return  # another worker is already running this job
    try:
        _run_segment(job_id, segment)
    finally:
        with connection.cursor() as cur:
            cur.execute('SELECT pg_advisory_unlock(%s)', [_lock_key(job_id)])


def _run_segment(job_id, segment):
    job = Job.objects.select_related('project').get(pk=job_id)
    state = job.result.get('state') or {}
    if job.status in TERMINAL or state.get('segment') != segment:
        return  # finished, or superseded by a newer segment
    run = Run(job, job_secrets.get(str(job.id)))
    job.status = Job.RUNNING
    mode = job.params['mode']
    node = FIRST[mode] if run.s.get('entry', 'start') == 'start' else run.s['entry']
    try:
        while node:
            updates = nodes.NODES[node](run)
            message = updates.pop('progressLog', None)
            run.s.update(updates)
            if message:
                job.progress_log = [*job.progress_log, message]
            if node == 'finalize':
                return _finish(run)
            node = next_node(node, run.s, mode)
            if node == 'checkLayout':  # the pause: wait for the browser to send page screenshots
                run.s['entry'] = 'checkLayout'
                job.status = Job.WAITING_IMAGES
                pdf_key = (run.s.get('compileResult') or {}).get('pdfKey')
                if pdf_key:  # the browser renders this PDF's pages and sends them back
                    job.result = {**job.result, 'pdfKey': pdf_key}
                run.save()
                return
            run.checkpoint()  # progress + heartbeat only; state is saved at segment boundaries
    except TransferError as exc:
        _fail(run, str(exc))
    except Exception as exc:
        log.exception('transfer job %s crashed', job_id)
        _fail(run, f'Transfer failed: {exc}')


def _finish(run):
    job, s = run.job, run.s
    job.status = Job.SUCCESS if s.get('status') == 'success' else Job.FAILED
    job.error = s.get('error') or ''
    pdf_key = (s.get('compileResult') or {}).get('pdfKey')
    if pdf_key:
        job.result = {**job.result, 'pdfKey': pdf_key}
    run.save()
    job_secrets.delete(str(job.id))


def _fail(run, message):
    run.job.status, run.job.error = Job.FAILED, message
    run.job.progress_log = [*run.job.progress_log, f'[error] {message}']
    run.save()
    job_secrets.delete(str(run.job.id))
