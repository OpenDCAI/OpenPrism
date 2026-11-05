"""OpenAI-compatible chat client (port of apps/backend/src/services/llmService.js).

API keys are never stored: they are passed in per call (or read from the worker's environment).
"""
import os
import re

import httpx
from django.conf import settings

from .ssrf import BlockedEndpoint, assert_public_url

DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions'


def normalize_chat_endpoint(endpoint):
    url = (endpoint or '').strip().rstrip('/')
    if not url:
        return DEFAULT_ENDPOINT
    if re.search(r'/chat/completions$', url, re.I):
        return url
    if re.search(r'/v1$', url, re.I):
        return f'{url}/chat/completions'
    if re.search(r'/v1/', url, re.I):
        return url
    return f'{url}/v1/chat/completions'


def resolve_config(cfg=None):
    """The request's endpoint, key and model, or, when it brings no key, the worker's OPENPRISM_LLM_* as a whole: the
    operator's key is only ever sent to the operator's endpoint (a request naming its own endpoint without a key would
    otherwise receive it), and with the operator's model."""
    cfg = cfg or {}
    key = (cfg.get('apiKey') or cfg.get('api_key') or '').strip()
    if not key:
        cfg = {}
    return {
        'endpoint': (cfg.get('endpoint') or os.environ.get('OPENPRISM_LLM_ENDPOINT') or DEFAULT_ENDPOINT).strip(),
        'api_key': key or os.environ.get('OPENPRISM_LLM_API_KEY', '').strip(),
        'model': (cfg.get('model') or os.environ.get('OPENPRISM_LLM_MODEL') or 'gpt-4o-mini').strip(),
    }


def chat_raw(messages, cfg=None, tools=None, temperature=0.2):
    """POST a chat completion. Returns {'ok': True, 'message': {...}} or {'ok': False, 'error': str}."""
    c = resolve_config(cfg)
    if not c['api_key']:
        return {'ok': False, 'error': 'OPENPRISM_LLM_API_KEY not set'}
    url = normalize_chat_endpoint(c['endpoint'])
    try:
        assert_public_url(url)
    except BlockedEndpoint as exc:
        return {'ok': False, 'error': str(exc)}
    body = {'model': c['model'], 'messages': messages}
    # Some reasoning models accept only the default temperature; OPENPRISM_LLM_TEMPERATURE=default omits it.
    if os.environ.get('OPENPRISM_LLM_TEMPERATURE', '').strip().lower() != 'default':
        body['temperature'] = temperature
    # e.g. gpt-6-luna refuses function tools unless reasoning_effort is 'none'.
    effort = os.environ.get('OPENPRISM_LLM_REASONING_EFFORT', '').strip()
    if effort:
        body['reasoning_effort'] = effort
    if tools:
        body['tools'] = tools
    try:
        res = httpx.post(url, json=body, headers={'Authorization': f"Bearer {c['api_key']}"},
                         timeout=settings.LLM_TIMEOUT_SECONDS, follow_redirects=False)
    except httpx.HTTPError as exc:
        return {'ok': False, 'error': f'LLM request failed: {exc}'}
    if res.status_code >= 400:
        return {'ok': False, 'error': res.text or f'Request failed with {res.status_code}'}
    if 'application/json' not in res.headers.get('content-type', ''):
        return {'ok': False, 'error': res.text or 'Non-JSON response from provider.'}
    try:
        data = res.json()
        message = data['choices'][0]['message']
    except (ValueError, KeyError, IndexError, TypeError):
        return {'ok': False, 'error': 'Response JSON parse failed.'}
    return {'ok': True, 'message': message}


def chat(messages, cfg=None):
    """Plain completion. Returns {'ok': True, 'content': str} or {'ok': False, 'error': str}."""
    res = chat_raw(messages, cfg)
    if not res['ok']:
        return res
    return {'ok': True, 'content': res['message'].get('content') or ''}
