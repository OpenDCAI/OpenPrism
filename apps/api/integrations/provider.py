"""Helpers for the workspace AI provider form (#76): list a provider's models and send one tiny test chat.

Both run on the server, so the browser never sees the key, and both go through the SSRF guard (ai.ssrf). They are advice
for the admin filling the form, never a gate on saving. The key is used for the call only: it is not stored, returned,
logged or written to a job row, and any text the provider sends back has the key removed before it is shown.
"""
import re
import time

import httpx
from django.conf import settings

from ai.llm import DEFAULT_ENDPOINT, normalize_chat_endpoint
from ai.ssrf import BlockedEndpoint, assert_public_url

from . import aiprofiles, crypto
from .models import AiProfile

TIMEOUT = 15          # seconds; these are quick helpers, unlike a real AI job
MAX_MODELS = 500
MAX_ERROR_CHARS = 300


class ProviderError(ValueError):
    """A message that is safe to show to the admin."""


def models_url(chat_endpoint):
    """The model list lives next to the chat route: .../v1/chat/completions -> .../v1/models."""
    return re.sub(r'/chat/completions/?$', '/models', chat_endpoint, flags=re.I)


def resolve(workspace, endpoint, api_key, profile=AiProfile.LLM):
    """(chat endpoint, key) to call with, for one profile (llm, search or vision). A typed key wins. With no key the
    stored one of the same profile is used only when the endpoint is unchanged (or not given): changing the endpoint
    needs the key typed again, so the stored key cannot be sent elsewhere."""
    if profile not in (AiProfile.LLM, AiProfile.SEARCH, AiProfile.VISION):
        raise ProviderError('This setting has no model list or test.')
    config = AiProfile.objects.filter(workspace=workspace, profile=profile).first()
    try:
        typed = aiprofiles.clean_endpoint(endpoint)
    except aiprofiles.LlmConfigError as exc:
        raise ProviderError(str(exc)) from None
    url = typed or (config.endpoint if config and config.endpoint else '') or DEFAULT_ENDPOINT
    key = str(api_key or '').strip()
    if key:
        return url, key
    if config is not None and (not typed or typed == config.endpoint or (not config.endpoint and typed == DEFAULT_ENDPOINT)):
        return url, crypto.decrypt(config.api_key_encrypted)
    if config is not None:
        raise ProviderError('Enter the API key to use a different endpoint.')
    raise ProviderError('Enter an API key.')


def _clean(text, key):
    text = str(text or '').strip()
    if key:
        text = text.replace(key, '***')
    return re.sub(r'\s+', ' ', text)[:MAX_ERROR_CHARS] or 'The provider returned an empty error.'


def _call(method, url, key, **kw):
    """One guarded request; returns the response or raises ProviderError with a message that never contains the key."""
    try:
        assert_public_url(url)
    except BlockedEndpoint as exc:
        raise ProviderError(str(exc)) from None
    try:
        res = httpx.request(method, url, headers={'Authorization': f'Bearer {key}'}, timeout=TIMEOUT,
                            follow_redirects=False, **kw)
    except httpx.TimeoutException:
        raise ProviderError('The provider did not answer in time.') from None
    except httpx.HTTPError as exc:
        raise ProviderError(_clean(f'Could not reach the provider: {exc}', key)) from None
    if 300 <= res.status_code < 400:
        raise ProviderError('The provider redirected the request; use its final address as the endpoint.')
    if res.status_code in (401, 403):
        raise ProviderError(f'The provider refused the key ({res.status_code}). {_clean(res.text, key)}'.strip())
    if res.status_code >= 400:
        raise ProviderError(f'The provider answered {res.status_code}: {_clean(res.text, key)}')
    return res


def list_models(endpoint, key):
    """Sorted model ids from <base>/models. Raises ProviderError; providers without a list (Azure deployments, some local
    servers) answer an error here and the admin types the model by hand."""
    res = _call('GET', models_url(normalize_chat_endpoint(endpoint)), key)
    try:
        data = res.json()
    except ValueError:
        raise ProviderError('The provider did not return a model list (not JSON). Type the model name instead.') from None
    items = data.get('data') if isinstance(data, dict) else data
    if isinstance(data, dict) and items is None:
        items = data.get('models')
    ids = sorted({(m.get('id') or m.get('name') or '') if isinstance(m, dict) else str(m) for m in (items or [])} - {''})
    if not ids:
        raise ProviderError('The provider returned no models. Type the model name instead.')
    return ids[:MAX_MODELS]


def chat_check(endpoint, key, model):
    """Send one tiny chat request. Returns latency in ms; raises ProviderError with the provider's own message."""
    model = str(model or '').strip()
    if not model:
        raise ProviderError('Choose or type a model to test.')
    body = {'model': model, 'messages': [{'role': 'user', 'content': 'Reply with the single word: ok'}], 'max_tokens': 5}
    started = time.monotonic()
    res = _call('POST', normalize_chat_endpoint(endpoint), key, json=body)
    latency = int((time.monotonic() - started) * 1000)
    try:
        res.json()['choices'][0]
    except (ValueError, KeyError, IndexError, TypeError):
        raise ProviderError('The provider answered, but not like a chat completion. Check the endpoint and model.') from None
    return latency
