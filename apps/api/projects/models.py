import uuid

from django.conf import settings
from django.db import models


class Workspace(models.Model):
    PERSONAL, TEAM = 'personal', 'team'
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    kind = models.CharField(max_length=10, choices=[(PERSONAL, 'Personal'), (TEAM, 'Team')], default=TEAM)
    color = models.CharField(max_length=9, blank=True, default='')  # '#rrggbb'; picked by the server for new workspaces
    # Unnamed project versions older than this many days are pruned (each project's newest is kept); null: count only.
    version_retention_days = models.PositiveIntegerField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    members = models.ManyToManyField(settings.AUTH_USER_MODEL, through='Membership', related_name='workspaces')

    def __str__(self):
        return self.name


class Membership(models.Model):
    OWNER, ADMIN, EDITOR, COMMENTER, VIEWER = 'owner', 'admin', 'editor', 'commenter', 'viewer'
    ROLES = [(OWNER, 'Owner'), (ADMIN, 'Admin'), (EDITOR, 'Editor'), (COMMENTER, 'Commenter'), (VIEWER, 'Viewer')]
    WRITE_ROLES = (OWNER, ADMIN, EDITOR)  # commenters and viewers cannot change files
    COMMENT_ROLES = WRITE_ROLES + (COMMENTER,)  # may write comments (viewers only read them)
    ADMIN_ROLES = (OWNER, ADMIN)
    ASSIGNABLE = (ADMIN, EDITOR, COMMENTER, VIEWER)  # ownership is not handed out through invitations

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name='memberships')
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='memberships')
    role = models.CharField(max_length=10, choices=ROLES, default=VIEWER)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['workspace', 'user'], name='uniq_workspace_user')]


class WorkspaceInvite(models.Model):
    """An invitation for an email address with no account yet. It becomes a Membership when that person registers."""
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name='invites')
    email = models.EmailField()  # stored lower-case
    role = models.CharField(max_length=10, choices=Membership.ROLES, default=Membership.EDITOR)
    invited_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)
    last_sent_at = models.DateTimeField(null=True, blank=True)  # when the invitation mail was last queued
    send_failed = models.BooleanField(default=False)  # the last mail could not be delivered after every retry

    class Meta:
        constraints = [models.UniqueConstraint(fields=['workspace', 'email'], name='uniq_workspace_invite')]


class Project(models.Model):
    """Mirrors the Node backend's project.json."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name='projects')
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name='+')
    name = models.CharField(max_length=200)
    tags = models.JSONField(default=list, blank=True)
    archived = models.BooleanField(default=False)
    trashed = models.BooleanField(default=False)
    trashed_at = models.DateTimeField(null=True, blank=True)
    file_order = models.JSONField(default=dict, blank=True)  # {folder: [names]}
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated_at']


class ProjectFile(models.Model):
    """One row per file or folder. Text lives in `content`; binaries live in S3 under `s3_key`."""
    TEXT, BINARY, DIR = 'text', 'binary', 'dir'
    KINDS = [(TEXT, 'Text'), (BINARY, 'Binary'), (DIR, 'Directory')]

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='files')
    path = models.CharField(max_length=1024)
    kind = models.CharField(max_length=6, choices=KINDS)
    content = models.TextField(blank=True, default='')
    s3_key = models.CharField(max_length=1200, blank=True, default='')
    size = models.BigIntegerField(default=0)
    content_type = models.CharField(max_length=200, blank=True, default='')
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['project', 'path'], name='uniq_project_path')]
        indexes = [models.Index(fields=['project', 'path'])]
