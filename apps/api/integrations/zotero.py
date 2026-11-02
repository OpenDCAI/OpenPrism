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


# ---- browsing -------------------------------------------------------------------------------------------------

PAGE_MAX = 50


def groups(api_key, zotero_user_id):
    res = request(api_key, f'/users/{zotero_user_id}/groups', {'format': 'json', 'limit': 100})
    out = []
    for g in _json_list(res):
        data = g.get('data') or {}
        if str(g.get('id', '')).isdigit():
            out.append({'id': str(g['id']), 'type': 'group', 'name': str(data.get('name') or f"Group {g['id']}")})
    return out


def libraries(api_key, zotero_user_id):
    return [{'id': 'user', 'type': 'user', 'name': 'My Library'}, *groups(api_key, zotero_user_id)]


def library_prefix(api_key, zotero_user_id, library):
    """URL prefix for a library the key can reach. `library` is "user" or a numeric group id from the user's groups."""
    library = str(library or '')
    if library == 'user':
        return f'/users/{zotero_user_id}'
    if library.isdigit() and any(g['id'] == library for g in groups(api_key, zotero_user_id)):
        return f'/groups/{library}'
    raise ZoteroError('That Zotero library is not available to you.')


def _json_list(res):
    try:
        data = res.json()
    except ValueError:
        raise ZoteroError('Zotero returned an unexpected reply.') from None
    if not isinstance(data, list):
        raise ZoteroError('Zotero returned an unexpected reply.')
    return [d for d in data if isinstance(d, dict)]


def _creator_name(c):
    if not isinstance(c, dict):
        return ''
    return str(c.get('name') or ' '.join(x for x in (c.get('firstName'), c.get('lastName')) if x) or '')


def _year(item_data, meta):
    parsed = str((meta or {}).get('parsedDate') or item_data.get('date') or '')
    return parsed[:4] if parsed[:4].isdigit() else ''


def summarize(item):
    d = item.get('data') or {}
    return {
        'key': str(item.get('key') or d.get('key') or ''),
        'title': str(d.get('title') or d.get('shortTitle') or '(untitled)'),
        'creators': [n for n in (_creator_name(c) for c in (d.get('creators') or [])) if n],
        'year': _year(d, item.get('meta')),
        'itemType': str(d.get('itemType') or ''),
        'citationKey': str(d.get('citationKey') or ''),
        'doi': str(d.get('DOI') or ''),
    }


def items(api_key, prefix, q='', collection='', start=0, limit=25):
    """One page of top-level items (attachments and standalone notes left out) and the library's total count."""
    limit = min(PAGE_MAX, max(1, int(limit)))
    path = f'{prefix}/collections/{collection}/items/top' if collection else f'{prefix}/items/top'
    params = {'format': 'json', 'limit': limit, 'start': max(0, int(start)), 'itemType': '-attachment',
              'sort': 'dateModified', 'direction': 'desc'}
    if q:
        params.update({'q': q, 'qmode': 'titleCreatorYear'})
        params.pop('sort'), params.pop('direction')
    res = request(api_key, path, params)
    rows = [summarize(i) for i in _json_list(res) if (i.get('data') or {}).get('itemType') not in ('note', 'attachment')]
    try:
        total = int(res.headers.get('Total-Results', len(rows)))
    except ValueError:
        total = len(rows)
    return rows, total


def collections(api_key, prefix):
    out, start = [], 0
    for _ in range(5):  # at most 500 collections
        res = request(api_key, f'{prefix}/collections', {'format': 'json', 'limit': 100, 'start': start})
        page = _json_list(res)
        for c in page:
            d = c.get('data') or {}
            parent = d.get('parentCollection')
            out.append({'key': str(c.get('key') or d.get('key') or ''), 'name': str(d.get('name') or ''),
                        'parent': parent if isinstance(parent, str) else None})
        if len(page) < 100:
            break
        start += 100
    return out
