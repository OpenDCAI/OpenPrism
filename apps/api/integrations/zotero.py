"""Zotero Web API v3 client. The host is fixed (settings.ZOTERO_API_BASE), so no SSRF guard; responses are untrusted."""
import time

import httpx
from django.conf import settings
from django.utils import timezone

from . import crypto
from .models import ZoteroConnection

MAX_WAIT = 5  # seconds we are willing to sleep for Backoff / Retry-After before giving up with a friendly error


class ZoteroError(Exception):
    """A message that is safe to show to the user."""


def get_connection(user):
    try:
        return user.zotero
    except ZoteroConnection.DoesNotExist:
        raise ZoteroError('Zotero is not connected.') from None


def get_zotero_key(user):
    conn = get_connection(user)
    return conn.zotero_user_id, crypto.decrypt(conn.api_key_encrypted)


def request(api_key, path, params=None, retries=1):
    """GET `path` on the Zotero API. Honours Backoff / Retry-After; returns the httpx response."""
    headers = {'Zotero-API-Version': '3', 'Zotero-API-Key': api_key, 'User-Agent': 'openprism/1.0'}
    for attempt in range(retries + 1):
        try:
            res = httpx.get(settings.ZOTERO_API_BASE + path, params=params, headers=headers, timeout=20)
        except httpx.HTTPError:
            raise ZoteroError('Could not reach Zotero. Try again in a moment.') from None
        wait = _wait_seconds(res)
        if res.status_code in (429, 503):
            if wait <= MAX_WAIT and attempt < retries:
                time.sleep(wait or 1)
                continue
            raise ZoteroError(f'Zotero asked us to slow down. Try again in {int(wait) or 1} s.')
        if res.status_code < 400 and wait:
            time.sleep(min(wait, MAX_WAIT))  # Backoff on a good reply applies before our next request
        if res.status_code == 403:
            raise ZoteroError('Zotero refused the key. Reconnect Zotero.')
        if res.status_code == 404:
            raise ZoteroError('Not found in Zotero.')
        if res.status_code >= 400:
            raise ZoteroError(f'Zotero error ({res.status_code}).')
        return res
    raise ZoteroError('Could not reach Zotero.')  # pragma: no cover


def _wait_seconds(res):
    for h in ('Backoff', 'Retry-After'):
        try:
            v = float(res.headers.get(h, 0))
        except ValueError:
            continue
        if v > 0:
            return v
    return 0


def verify_key(api_key):
    """Returns (zotero_user_id, username) for a valid key."""
    res = request(api_key, '/keys/current', retries=0)
    try:
        data = res.json()
        return int(data['userID']), str(data.get('username') or '')
    except (ValueError, KeyError, TypeError):
        raise ZoteroError('Zotero returned an unexpected reply.') from None


def touch(conn):
    ZoteroConnection.objects.filter(pk=conn.pk).update(last_used_at=timezone.now())
