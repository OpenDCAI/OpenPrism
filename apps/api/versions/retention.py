"""Deleting versions and the stored objects only they used. Shared by the delete endpoint and the nightly prune."""
from django.conf import settings
from django.db.models import Count, Q

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


def prune_project(project, keep=None):
    """Keep the newest `keep` unnamed versions (setting VERSION_KEEP_UNNAMED, at least 1, so the latest unnamed version
    always stays); named versions are never deleted."""
    keep = max(1, settings.VERSION_KEEP_UNNAMED if keep is None else keep)
    return delete_versions(project, list(project.versions.filter(name='')[keep:]))  # newest first: the slice is the oldest


def prune_all():
    keep = max(1, settings.VERSION_KEEP_UNNAMED)
    crowded = Project.objects.annotate(n=Count('versions', filter=Q(versions__name=''))).filter(n__gt=keep)
    return sum(prune_project(p, keep) for p in crowded.iterator())
