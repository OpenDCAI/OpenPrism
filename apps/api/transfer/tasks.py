import logging
import uuid

from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded

from common import secrets as job_secrets
from jobs.models import Job

from . import engine

log = logging.getLogger(__name__)


@shared_task(name='transfer.tasks.run_transfer_segment', soft_time_limit=1800, time_limit=1860, ignore_result=True)
def run_transfer_segment(job_id, segment):
    """Run one segment of a template-transfer job (start -> pause/finish, or resume -> pause/finish)."""
    try:
        engine.run_segment(uuid.UUID(str(job_id)), segment)
    except SoftTimeLimitExceeded:
        job = Job.objects.get(pk=job_id)
        job.status, job.error = Job.FAILED, 'The transfer timed out.'
        job.progress_log = [*job.progress_log, '[error] The transfer timed out.']
        job.save(update_fields=['status', 'error', 'progress_log', 'updated_at'])
        job_secrets.delete(str(job_id))
        from .cleanup import discard_target
        discard_target(job)
