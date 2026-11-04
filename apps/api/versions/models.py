import uuid

from django.conf import settings
from django.db import models


class ProjectVersion(models.Model):
    """What the project looked like when it was compiled: a manifest of its files plus the PDF it produced (none for a
    failed compile) and the compile log.

    File contents are not stored here; the manifest points at `VersionBlob`s by hash."""
    SUCCESS, FAILED = 'success', 'failed'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey('projects.Project', on_delete=models.CASCADE, related_name='versions')
    number = models.PositiveIntegerField()  # 1, 2, 3... per project
    created_at = models.DateTimeField(auto_now_add=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name='+')  # null: guest
    job = models.ForeignKey('jobs.Job', null=True, on_delete=models.SET_NULL, related_name='+')
    main_file = models.CharField(max_length=1024)
    engine = models.CharField(max_length=20)
    manifest = models.JSONField(default=list)  # [{path, kind: text|binary|dir, size, sha256}]
    manifest_hash = models.CharField(max_length=64)
    pdf_key = models.CharField(max_length=1200, blank=True, default='')
    pdf_size = models.BigIntegerField(default=0)
    status = models.CharField(max_length=7, choices=[(SUCCESS, 'Success'), (FAILED, 'Failed')], default=SUCCESS)
    log_key = models.CharField(max_length=1200, blank=True, default='')  # the compile log (text/plain); blank before v0.0.4.1
    log_size = models.BigIntegerField(default=0)
    name = models.CharField(max_length=100, blank=True, default='')  # a named version is pinned: retention keeps it forever
    restored_from = models.ForeignKey('self', null=True, blank=True, on_delete=models.SET_NULL, related_name='+')

    class Meta:
        ordering = ['-number']
        constraints = [models.UniqueConstraint(fields=['project', 'number'], name='version_number_per_project')]


class VersionBlob(models.Model):
    """One distinct file content of a project, stored once however many versions contain it."""
    TEXT, BINARY = 'text', 'binary'

    project = models.ForeignKey('projects.Project', on_delete=models.CASCADE, related_name='version_blobs')
    sha256 = models.CharField(max_length=64)
    kind = models.CharField(max_length=6, choices=[(TEXT, 'Text'), (BINARY, 'Binary')])
    text = models.TextField(blank=True, default='')
    s3_key = models.CharField(max_length=1200, blank=True, default='')
    size = models.BigIntegerField(default=0)
    content_type = models.CharField(max_length=200, blank=True, default='')

    class Meta:
        constraints = [models.UniqueConstraint(fields=['project', 'sha256'], name='blob_per_project_hash')]
