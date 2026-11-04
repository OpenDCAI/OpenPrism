"""Record a project version after a compile, successful or not (a failed one has no PDF but keeps its log).

The snapshot is the list `jobs.compile.materialise` returned, i.e. the files the compiler was given. File contents are
stored once per project, keyed by hash (`VersionBlob`); a version is a manifest pointing at them, plus its PDF."""
import hashlib
import json
import logging
import uuid

from django.db import transaction

from projects import storage
from projects.models import Project

from .models import ProjectVersion, VersionBlob

log = logging.getLogger(__name__)


def blob_key(project_id, sha256):
    return f'versions/{project_id}/blobs/{sha256}'


def pdf_key(project_id, version_id):
    return f'versions/{project_id}/{version_id}.pdf'


def log_key(project_id, version_id):
    return f'versions/{project_id}/{version_id}.log'


def manifest_of(entries):
    """The stored manifest: path, kind, size and hash per file, sorted so equal projects give equal manifests."""
    return sorted(({'path': e['path'], 'kind': e['kind'], 'size': e['size'], 'sha256': e['sha256']} for e in entries),
                  key=lambda m: m['path'])


def hash_manifest(manifest):
    canonical = json.dumps([[m['path'], m['kind'], m['sha256']] for m in manifest], separators=(',', ':'))
    return hashlib.sha256(canonical.encode()).hexdigest()


def _store_blobs(project, entries):
    known = set(VersionBlob.objects.filter(project=project, sha256__in={e['sha256'] for e in entries if e['kind'] != 'dir'})
                .values_list('sha256', flat=True))
    for e in entries:
        if e['kind'] == 'dir' or e['sha256'] in known:
            continue
        known.add(e['sha256'])
        if e['kind'] == 'text':
            VersionBlob.objects.create(project=project, sha256=e['sha256'], kind=VersionBlob.TEXT, text=e['text'], size=e['size'])
        else:  # source keys are immutable, so the copy has exactly the bytes that were hashed
            key = blob_key(project.id, e['sha256'])
            storage.copy(e['s3_key'], key)
            VersionBlob.objects.create(project=project, sha256=e['sha256'], kind=VersionBlob.BINARY, s3_key=key, size=e['size'],
                                       content_type=e.get('content_type', ''))


def record(project, entries, pdf, main_file, engine, job=None, user=None, log=None):
    """Save a version unless nothing changed since the latest one. `pdf` None means the compile failed: the version is
    recorded with status failed and no PDF. `log` (the job's capped log) is stored beside it. Returns (version, created)."""
    manifest = manifest_of(entries)
    digest = hash_manifest(manifest)
    status = ProjectVersion.SUCCESS if pdf else ProjectVersion.FAILED
    version_id = uuid.uuid4()
    key = pdf_key(project.id, version_id) if pdf else ''
    lkey = log_key(project.id, version_id) if log is not None else ''
    stored = []
    try:
        with transaction.atomic():
            Project.objects.select_for_update().get(pk=project.pk)  # serialises numbering and the "unchanged?" check
            latest = project.versions.first()
            if latest and (latest.manifest_hash, latest.main_file, latest.engine, latest.status) == (digest, main_file, engine, status):
                return latest, False
            _store_blobs(project, entries)
            if key:
                storage.put_bytes(key, pdf, 'application/pdf')
                stored.append(key)
            if lkey:
                storage.put_bytes(lkey, log.encode('utf-8'), 'text/plain; charset=utf-8')
                stored.append(lkey)
            version = ProjectVersion.objects.create(
                id=version_id, project=project, number=(latest.number + 1 if latest else 1), created_by=user, job=job,
                main_file=main_file, engine=engine, manifest=manifest, manifest_hash=digest, pdf_key=key,
                pdf_size=len(pdf) if pdf else 0, status=status, log_key=lkey)
            return version, True
    except Exception:
        storage.delete_keys(stored)
        raise


def record_restore(project, source, user=None):
    """Record the version a restore produced: the same manifest and status as `source`, with its own copies of the PDF
    and log (so deleting either version never takes the other's with it). The blobs already exist. Returns the new
    version."""
    version_id = uuid.uuid4()
    key = pdf_key(project.id, version_id) if source.pdf_key else ''
    lkey = log_key(project.id, version_id) if source.log_key else ''
    copied = []
    try:
        for src, dst in ((source.pdf_key, key), (source.log_key, lkey)):
            if dst:
                storage.copy(src, dst)
                copied.append(dst)
        with transaction.atomic():
            Project.objects.select_for_update().get(pk=project.pk)
            latest = project.versions.first()
            return ProjectVersion.objects.create(
                id=version_id, project=project, number=(latest.number + 1 if latest else 1), created_by=user,
                main_file=source.main_file, engine=source.engine, manifest=source.manifest,
                manifest_hash=source.manifest_hash, pdf_key=key, pdf_size=source.pdf_size, restored_from=source,
                status=source.status, log_key=lkey)
    except Exception:
        storage.delete_keys(copied)
        raise
