import uuid

from django.conf import settings
from django.db import models


class ZoteroConnection(models.Model):
    """A user's Zotero API key, encrypted (integrations.crypto). Never serialised; read it with get_zotero_key()."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='zotero')
    zotero_user_id = models.PositiveBigIntegerField()
    username = models.CharField(max_length=150, blank=True)
    api_key_encrypted = models.BinaryField()
    last_four = models.CharField(max_length=4)
    created_at = models.DateTimeField(auto_now_add=True)
    last_used_at = models.DateTimeField(null=True, blank=True)


class WorkspaceLlmConfig(models.Model):
    """The LLM provider a workspace's members use (endpoint, model, encrypted API key). Read it with
    llmconfig.workspace_llm_for(); the key is never serialised."""
    workspace = models.OneToOneField('projects.Workspace', on_delete=models.CASCADE, related_name='llm_config')
    endpoint = models.CharField(max_length=500, blank=True)
    model = models.CharField(max_length=200, blank=True)
    api_key_encrypted = models.BinaryField()
    last_four = models.CharField(max_length=4)
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name='+')
    updated_at = models.DateTimeField(auto_now=True)
    daily_limit = models.PositiveIntegerField(null=True, blank=True, db_default=None)  # AI jobs per UTC day; null = no limit


class LlmUsage(models.Model):
    """AI jobs per UTC day, by who ran them, in which workspace, and whose key paid (`source`). Counts requests, not
    tokens. Outlives the 24 h Job rows; pruned after LLM_USAGE_KEEP_DAYS. Written by ai.usage.charge()."""
    WORKSPACE, USER, BROWSER, SERVER = 'workspace', 'user', 'browser', 'server'
    SOURCES = [(s, s) for s in (WORKSPACE, USER, BROWSER, SERVER)]

    day = models.DateField()
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.CASCADE, related_name='+')
    workspace = models.ForeignKey('projects.Workspace', null=True, on_delete=models.CASCADE, related_name='+')
    source = models.CharField(max_length=10, choices=SOURCES)
    count = models.PositiveIntegerField(default=0, db_default=0)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['day', 'user', 'workspace', 'source'], nulls_distinct=False,
                                               name='llm_usage_unique_row')]
        indexes = [models.Index(fields=['workspace', 'day'])]


class CredentialEvent(models.Model):
    """Append-only history of stored credentials: who set, rotated, changed or removed one, and when. Never holds key
    material beyond the last four characters the UI already shows. Written only by integrations.audit.record()."""
    WORKSPACE_LLM, ZOTERO, USER_LLM, USER_MINERU = 'workspace_llm', 'zotero', 'user_llm', 'user_mineru'
    KINDS = [(k, k) for k in (WORKSPACE_LLM, ZOTERO, USER_LLM, USER_MINERU)]
    SET, ROTATED, UPDATED, REMOVED = 'set', 'rotated', 'updated', 'removed'
    ACTIONS = [(a, a) for a in (SET, ROTATED, UPDATED, REMOVED)]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name='+')
    actor_name = models.CharField(max_length=300, blank=True)  # kept after the actor's account is deleted
    workspace = models.ForeignKey('projects.Workspace', null=True, blank=True, on_delete=models.CASCADE, related_name='+')
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE, related_name='+')
    kind = models.CharField(max_length=20, choices=KINDS)
    action = models.CharField(max_length=10, choices=ACTIONS)
    last_four = models.CharField(max_length=4, blank=True)
    detail = models.JSONField(default=dict, blank=True)  # non-secret fields that changed, e.g. {"model": "gpt-4o"}

    class Meta:
        indexes = [models.Index(fields=['workspace', '-created_at']), models.Index(fields=['owner', '-created_at'])]
