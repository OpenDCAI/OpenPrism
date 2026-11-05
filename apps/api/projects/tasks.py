import logging

from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded

from ai.i18n import t
from jobs.models import Job
from jobs.tasks import ACTIVE, finish

from . import arxiv_import

log = logging.getLogger(__name__)


@shared_task(name='projects.tasks.import_arxiv', soft_time_limit=900, time_limit=960, ignore_result=True)
def import_arxiv(job_id):
    try:
        job = Job.objects.get(pk=job_id)
    except Job.DoesNotExist:
        return
    if job.status not in ACTIVE:
        return
    job.status = Job.RUNNING
    job.save(update_fields=['status', 'updated_at'])

    def progress(info):
        job.result = {**job.result, 'progress': info}
        job.save(update_fields=['result', 'updated_at'])

    lang = job.params.get('lang') or 'en-US'
    try:
        project = arxiv_import.run(job_id, progress)
    except SoftTimeLimitExceeded:
        return finish(job, Job.FAILED, t(lang, 'arxiv_download_failed', error='timed out'))
    except Exception as exc:
        if not isinstance(exc, arxiv_import.ImportFailed):
            log.exception('arxiv import %s crashed', job_id)
        return finish(job, Job.FAILED, t(lang, 'arxiv_download_failed', error=str(exc)))
    finish(job, Job.SUCCESS, '', {'projectId': str(project.id)})


@shared_task(name='projects.tasks.cleanup_pending_uploads', ignore_result=True)
def cleanup_pending_uploads():
    """Every 15 minutes: drop direct uploads started over an hour ago and never completed (and their objects)."""
    from .direct_uploads import cleanup_pending
    return cleanup_pending()
