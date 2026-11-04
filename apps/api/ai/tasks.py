import logging

from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded

from jobs.models import Job
from jobs.tasks import ACTIVE, finish
from projects import storage

from .agent import Cancelled
from .handlers import HANDLERS

log = logging.getLogger(__name__)


@shared_task(name='ai.tasks.run_ai_job', soft_time_limit=540, time_limit=570, ignore_result=True)
def run_ai_job(job_id, secrets=None):
    """Run an llm / agent / vision / plot job. `secrets` (the user's API key) travel only in the broker message,
    never in the database or the Celery result backend."""
    try:
        job = Job.objects.select_related('project').get(pk=job_id)
    except Job.DoesNotExist:
        return
    if job.status not in ACTIVE:
        return
    job.status = Job.RUNNING
    job.save(update_fields=['status', 'updated_at'])
    try:
        body = HANDLERS[job.type](job, secrets or {})
    except Cancelled:
        return  # the cancel endpoint already ended the job
    except SoftTimeLimitExceeded:
        return finish(job, Job.FAILED, 'The AI request timed out.', {'body': {'ok': False, 'error': 'The AI request timed out.'}})
    except Exception as exc:
        log.exception('ai job %s crashed', job_id)
        return finish(job, Job.FAILED, f'AI job failed: {exc}', {'body': {'ok': False, 'error': f'AI job failed: {exc}'}})
    finally:
        if job.params.get('imageKey'):
            storage.delete_keys([job.params['imageKey']])
    job.refresh_from_db(fields=['result'])
    if job.result.get('cancelled'):
        return  # cancelled while the last call ran: keep the cancelled outcome
    finish(job, Job.SUCCESS if body.get('ok') else Job.FAILED, '' if body.get('ok') else str(body.get('error') or body.get('reply') or ''),
           {'body': body})
