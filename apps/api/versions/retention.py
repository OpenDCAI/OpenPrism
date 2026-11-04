"""Deleting versions and the stored objects only they used. Shared by the delete endpoint and the nightly prune."""
from datetime import timedelta

from django.conf import settings
from django.db.models import Count, Q
from django.utils import timezone

from projects import storage
from projects.models import Project

from .models import ProjectVersion, VersionBlob


def delete_versions(project, versions):
    """Delete these versions, their PDFs, and then any blob no remaining version of the project points at."""
    versions = list(versions)
    if not versions:
        return 0
    ids = [v.pk for v in versions]
    pdfs = {v.pdf_key for v in versions if v.pdf_key}
    ProjectVersion.objects.filter(pk__in=ids).delete()
    in_use = set(project.versions.filter(pdf_key__in=pdfs).values_list('pdf_key', flat=True))
    storage.delete_keys(pdfs - in_use)
    storage.delete_keys(v.log_key for v in versions if v.log_key)  # every version has its own log copy
    collect_blobs(project)
    return len(ids)


def collect_blobs(project):
    """Remove blobs (rows and S3 objects) that no version of the project references. Safe to run twice."""
    referenced = set()
    for manifest in project.versions.values_list('manifest', flat=True).iterator():
        referenced.update(m['sha256'] for m in manifest if m['kind'] != 'dir')
    orphans = [b for b in project.version_blobs.all() if b.sha256 not in referenced]
    storage.delete_keys(b.s3_key for b in orphans if b.kind == VersionBlob.BINARY and b.s3_key)
    VersionBlob.objects.filter(pk__in=[b.pk for b in orphans]).delete()
    return len(orphans)


def prune_project(project, keep=None, keep_failed=None, max_age_days=None):
    """Keep the newest `keep` unnamed successful versions (VERSION_KEEP_UNNAMED) and, counted separately so a run of
    failures never pushes good versions out, the newest `keep_failed` unnamed failed ones (VERSION_KEEP_FAILED). Both
    are at least 1, so the latest of each stays. With `max_age_days` (the workspace's version_retention_days), unnamed
    versions older than that go too, except the project's newest version. Named versions are never deleted."""
    keep = max(1, settings.VERSION_KEEP_UNNAMED if keep is None else keep)
    keep_failed = max(1, settings.VERSION_KEEP_FAILED if keep_failed is None else keep_failed)
    unnamed = project.versions.filter(name='')  # newest first: the slices are the oldest
    doomed = {v.pk: v for v in [*unnamed.filter(status=ProjectVersion.SUCCESS)[keep:],
                                *unnamed.filter(status=ProjectVersion.FAILED)[keep_failed:]]}
    if max_age_days:
        newest = project.versions.values_list('pk', flat=True).first()
        cutoff = timezone.now() - timedelta(days=max_age_days)
        doomed.update({v.pk: v for v in unnamed.filter(created_at__lt=cutoff).exclude(pk=newest)})
    return delete_versions(project, doomed.values())


def prune_all():
    keep, keep_failed = max(1, settings.VERSION_KEEP_UNNAMED), max(1, settings.VERSION_KEEP_FAILED)
    unnamed = Q(versions__name='')
    crowded = set(Project.objects.annotate(
        ok=Count('versions', filter=unnamed & Q(versions__status=ProjectVersion.SUCCESS)),
        failed=Count('versions', filter=unnamed & Q(versions__status=ProjectVersion.FAILED)),
    ).filter(Q(ok__gt=keep) | Q(failed__gt=keep_failed)).values_list('pk', flat=True))
    aged = set(Project.objects.filter(workspace__version_retention_days__isnull=False).values_list('pk', flat=True))
    projects = Project.objects.filter(pk__in=crowded | aged).select_related('workspace')
    return sum(prune_project(p, keep, keep_failed, p.workspace.version_retention_days) for p in projects.iterator())
