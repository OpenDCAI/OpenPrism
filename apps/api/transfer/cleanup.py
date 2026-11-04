"""A failed transfer leaves nothing behind: its half-built target project is deleted.

The job row is kept (it carries the error the panel shows), so it is detached from the project first: Job.project
cascades, and deleting the project would take the job with it."""
import logging

from django.db import transaction

from jobs.models import Job
from projects import files as pfiles
from projects.models import Project

log = logging.getLogger(__name__)
NOTE = 'The unfinished project was removed.'


def discard_target(job):
    """Delete a failed transfer job's target project. Idempotent; a no-op for anything else."""
    if job.type != Job.TRANSFER or job.status != Job.FAILED or not job.project_id:
        return False
    with transaction.atomic():
        project = Project.objects.select_for_update().filter(pk=job.project_id).first()
        Job.objects.filter(pk=job.pk).update(project=None)
        job.project_id = None
        job.result = {**job.result, 'targetDeleted': True}
        job.progress_log = [*job.progress_log, NOTE]
        job.save(update_fields=['project', 'result', 'progress_log', 'updated_at'])
        if project is None:
            return False  # the user deleted it already
        gone = Project(pk=project.pk)  # delete() clears project.pk; storage cleanup below needs the id
        project.delete()
    try:
        pfiles.delete_project_files(gone)
    except Exception:  # the rows are gone; leftover objects only cost storage
        log.exception('could not delete storage of discarded transfer target %s', gone.pk)
    return True


def discard_failed_targets(job_ids):
    for job in Job.objects.filter(pk__in=job_ids, type=Job.TRANSFER, status=Job.FAILED).exclude(project=None):
        discard_target(job)
