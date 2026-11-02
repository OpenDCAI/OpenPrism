"""Workspace-level LLM provider settings. Only workspace_llm_for() decrypts the key."""
from ai.llm import normalize_chat_endpoint
from ai.ssrf import BlockedEndpoint, assert_public_url
from projects.models import Membership

from . import crypto
from .models import WorkspaceLlmConfig

MAX_KEY_CHARS = 500


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


def save(workspace, user, endpoint=None, model=None, api_key=None):
    """Create or update the workspace's config. `None` fields keep their current value; a key is required the first time."""
    config = WorkspaceLlmConfig.objects.filter(workspace=workspace).first()
    api_key = str(api_key or '').strip()
    if len(api_key) > MAX_KEY_CHARS:
        raise LlmConfigError('That API key is too long.')
    if config is None and not api_key:
        raise LlmConfigError('Enter an API key.')
    fields = {'updated_by': user}
    if endpoint is not None:
        fields['endpoint'] = clean_endpoint(endpoint)
    if model is not None:
        fields['model'] = str(model).strip()[:200]
    if api_key:
        fields.update(api_key_encrypted=crypto.encrypt(api_key), last_four=api_key[-4:])
    if config is None:
        return WorkspaceLlmConfig.objects.create(workspace=workspace, **fields)
    for k, v in fields.items():
        setattr(config, k, v)
    config.save()
    return config


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
