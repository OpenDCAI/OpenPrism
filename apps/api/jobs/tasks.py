import logging
from datetime import timedelta

from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded
from django.conf import settings
from django.utils import timezone

from common import secrets as job_secrets
from projects import storage

from versions import snapshot

from . import compile as tex
from .models import Job

log = logging.getLogger(__name__)
ACTIVE = (Job.QUEUED, Job.RUNNING)


def add_progress(job, message):
    job.progress_log = [*job.progress_log, message]
    job.save(update_fields=['progress_log', 'updated_at'])  # updated_at doubles as the heartbeat


def finish(job, status, error='', result=None):
    job.status, job.error = status, error
    if result:
        job.result = {**job.result, **result}
    job.save(update_fields=['status', 'error', 'result', 'updated_at'])


@shared_task(name='jobs.tasks.compile_project', soft_time_limit=300, time_limit=330)
def compile_project(job_id):
    try:
        job = Job.objects.select_related('project').get(pk=job_id)
    except Job.DoesNotExist:
        return
    if job.status not in ACTIVE:
        return  # redelivered after it already finished or was reaped
    job.status = Job.RUNNING
    job.save(update_fields=['status', 'updated_at'])
    params = job.params
    try:
        out = tex.compile_project(
            job.project, params['mainFile'], params['engine'], progress=lambda m: add_progress(job, m),
            focus=params.get('focus'))
    except tex.CompileError as exc:
        return finish(job, Job.FAILED, str(exc))
    except SoftTimeLimitExceeded:
        return finish(job, Job.FAILED, 'Compilation timed out.')
    except Exception as exc:
        log.exception('compile job %s crashed', job_id)
        return finish(job, Job.FAILED, f'Compilation failed: {exc}')

    result = {'log': out['log'], 'exitStatus': out['status'], 'engine': params['engine'], 'mainFile': params['mainFile'],
              'focus': out.get('focus')}
    if not out['pdf']:
        return finish(job, Job.FAILED, out.get('error') or 'No PDF generated.', result)
    key = f'jobs/{job.id}/output.pdf'
    storage.put_bytes(key, out['pdf'], 'application/pdf')
    result.update(pdfKey=key, pdfSize=len(out['pdf']), **save_version(job, out, params))
    finish(job, Job.SUCCESS, '', result)


def save_version(job, out, params):
    """Record the project version this compile produced. Never fails the compile: no version is better than no PDF."""
    if not out.get('snapshot'):
        return {}
    try:
        version, created = snapshot.record(job.project, out['snapshot'], out['pdf'], params['mainFile'], params['engine'],
                                           job=job, user=job.user)
    except Exception:
        log.exception('could not save a version for compile job %s', job.id)
        return {}
    return {'versionId': str(version.id), 'versionNumber': version.number, 'versionCreated': created}


@shared_task(name='jobs.tasks.reap_stale_jobs')
def reap_stale_jobs():
    """Fail jobs whose worker died (no heartbeat) or that never got picked up, and drop their stored secrets."""
    now = timezone.now()
    stale = [
        (Job.objects.filter(status=Job.RUNNING, updated_at__lt=now - timedelta(minutes=settings.JOB_RUNNING_STALE_MINUTES)),
         'Job timed out (worker stopped responding).'),
        (Job.objects.filter(status=Job.QUEUED, updated_at__lt=now - timedelta(minutes=settings.JOB_QUEUED_STALE_MINUTES)),
         'Job was never started (queue backlog or lost message).'),
        # A transfer paused for the layout check waits for the browser's page images; if the tab is gone it never resumes.
        (Job.objects.filter(status=Job.WAITING_IMAGES, updated_at__lt=now - timedelta(minutes=settings.JOB_WAITING_STALE_MINUTES)),
         'The layout check was never answered (the page was closed).'),
    ]
    count = 0
    for queryset, message in stale:
        ids = list(queryset.values_list('pk', flat=True))
        count += queryset.filter(pk__in=ids).update(status=Job.FAILED, error=message, updated_at=now)
        for job_id in ids:
            job_secrets.delete(str(job_id))
        from transfer.cleanup import discard_failed_targets  # imported lazily: transfer depends on jobs
        discard_failed_targets(ids)
    return count


@shared_task(name='jobs.tasks.cleanup_old_jobs')
def cleanup_old_jobs():
    """Delete finished jobs (and their stored output) older than JOB_RETENTION_HOURS."""
    cutoff = timezone.now() - timedelta(hours=settings.JOB_RETENTION_HOURS)
    old = Job.objects.exclude(status__in=ACTIVE).filter(updated_at__lt=cutoff)
    n = 0
    for job in old.iterator():
        storage.delete_prefix(f'jobs/{job.id}/')
        job_secrets.delete(str(job.id))
        job.delete()
        n += 1
    return n
