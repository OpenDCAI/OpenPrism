import uuid

from django.conf import settings
from django.db import models


class CommentThread(models.Model):
    """A discussion anchored to a range of a text file. The anchor is the quoted text plus a little context either
    side; the character offsets are only a hint, because the file keeps changing (see anchor.py)."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey('projects.Project', on_delete=models.CASCADE, related_name='comment_threads')
    path = models.CharField(max_length=1024)
    anchor_from = models.PositiveIntegerField()
    anchor_to = models.PositiveIntegerField()
    quote = models.TextField()
    prefix = models.CharField(max_length=64, blank=True, default='')
    suffix = models.CharField(max_length=64, blank=True, default='')
    resolved = models.BooleanField(default=False)
    resolved_by_name = models.CharField(max_length=200, blank=True, default='')
    resolved_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [models.Index(fields=['project', 'path'])]


class Comment(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    thread = models.ForeignKey(CommentThread, on_delete=models.CASCADE, related_name='comments')
    # An account, or an invite-link guest (identified by the invite, so they can edit their own comment while it lasts).
    author = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    guest_invite_id = models.CharField(max_length=36, blank=True, default='')
    author_name = models.CharField(max_length=200)  # kept if the account is deleted
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    edited_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['created_at']
