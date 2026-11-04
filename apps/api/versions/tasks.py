from celery import shared_task

from . import retention


@shared_task(name='versions.tasks.prune_versions')
def prune_versions():
    """Daily: drop unnamed versions beyond the newest VERSION_KEEP_UNNAMED per project, then unreferenced blobs."""
    return retention.prune_all()
