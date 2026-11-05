"""Workspace-level LLM provider settings. Only workspace_llm_for() decrypts the key."""
from ai.llm import normalize_chat_endpoint
from ai.ssrf import BlockedEndpoint, assert_public_url
from projects.models import Membership

from django.db import transaction

from . import audit, crypto
from .models import CredentialEvent, WorkspaceLlmConfig

MAX_KEY_CHARS = 500
MAX_DAILY_LIMIT = 100000
UNSET = object()


class LlmConfigError(ValueError):
    """A message that is safe to show to the user."""


def clean_endpoint(value):
    value = str(value or '').strip()
    if not value:
        return ''
    endpoint = normalize_chat_endpoint(value)
    try:
        assert_public_url(endpoint)
    except BlockedEndpoint as exc:
        raise LlmConfigError(str(exc)) from None
    return endpoint


def clean_daily_limit(value):
    """AI jobs per day through the provider: 1-MAX_DAILY_LIMIT, or None/'' for no limit."""
    if value is None or value == '':
        return None
    if isinstance(value, bool) or not isinstance(value, (int, str)) or not str(value).strip().isdigit() \
            or not 1 <= int(value) <= MAX_DAILY_LIMIT:
        raise LlmConfigError(f'The daily limit must be a whole number from 1 to {MAX_DAILY_LIMIT}, or empty for no limit.')
    return int(value)


def _detail(changed):
    """The non-secret fields a save changed, in the API's names, for the event log."""
    names = {'endpoint': 'endpoint', 'model': 'model', 'daily_limit': 'dailyLimit'}
    return {names[k]: v for k, v in changed.items()}


def save(workspace, user, endpoint=None, model=None, api_key=None, daily_limit=UNSET):
    """Create or update the workspace's config. `None` fields (and an omitted `daily_limit`) keep their current value; a
    key is required the first time. Records a credential event (set / rotated / updated) unless nothing changed."""
    config = WorkspaceLlmConfig.objects.filter(workspace=workspace).first()
    api_key = str(api_key or '').strip()
    if len(api_key) > MAX_KEY_CHARS:
        raise LlmConfigError('That API key is too long.')
    if config is None and not api_key:
        raise LlmConfigError('Enter an API key.')
    public = {}
    if daily_limit is not UNSET:
        public['daily_limit'] = clean_daily_limit(daily_limit)
    if endpoint is not None:
        public['endpoint'] = clean_endpoint(endpoint)
    if model is not None:
        public['model'] = str(model).strip()[:200]
    created = config is None
    changed = {k: v for k, v in public.items() if created or getattr(config, k) != v}
    new_key = bool(api_key) and (created or crypto.decrypt(config.api_key_encrypted) != api_key)
    if not created and not changed and not new_key:
        return config  # an identical save writes and records nothing
    fields = {'updated_by': user, **public}
    if new_key:
        fields.update(api_key_encrypted=crypto.encrypt(api_key), last_four=api_key[-4:])
    with transaction.atomic():
        if created:
            config = WorkspaceLlmConfig.objects.create(workspace=workspace, **fields)
        else:
            for k, v in fields.items():
                setattr(config, k, v)
            config.save()
        action = CredentialEvent.SET if created else CredentialEvent.ROTATED if new_key else CredentialEvent.UPDATED
        audit.record(CredentialEvent.WORKSPACE_LLM, action, user, workspace=workspace, last_four=config.last_four,
                     detail=_detail(changed))
    return config


def remove(workspace, user):
    """Delete the workspace's provider and record it. Returns False when there was none."""
    with transaction.atomic():
        deleted = WorkspaceLlmConfig.objects.filter(workspace=workspace).delete()[0]
        if deleted:
            audit.record(CredentialEvent.WORKSPACE_LLM, CredentialEvent.REMOVED, user, workspace=workspace)
    return bool(deleted)


def workspace_llm_for(workspace, user):
    """({endpoint, model}, {apiKey}) if the workspace has a provider and `user` may use it (owner/admin/editor), else None."""
    if workspace is None or not Membership.objects.filter(workspace=workspace, user=user,
                                                          role__in=Membership.WRITE_ROLES).exists():
        return None
    config = WorkspaceLlmConfig.objects.filter(workspace=workspace).first()
    if config is None:
        return None
    public = {k: v for k, v in (('endpoint', config.endpoint), ('model', config.model)) if v}
    return public, {'apiKey': crypto.decrypt(config.api_key_encrypted)}
