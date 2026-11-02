from rest_framework.decorators import api_view
from rest_framework.response import Response

from . import crypto, zotero
from .models import ZoteroConnection


def _status(conn):
    if not conn:
        return {'ok': True, 'connected': False}
    return {'ok': True, 'connected': True, 'username': conn.username, 'lastFour': conn.last_four}


@api_view(['GET', 'PUT', 'DELETE'])
def zotero_connection(request):
    conn = ZoteroConnection.objects.filter(user=request.user).first()
    if request.method == 'GET':
        return Response(_status(conn))
    if request.method == 'DELETE':
        ZoteroConnection.objects.filter(user=request.user).delete()
        return Response({'ok': True})
    api_key = str((request.data or {}).get('apiKey') or '').strip() if isinstance(request.data, dict) else ''
    if not api_key or len(api_key) > 200:
        return Response({'ok': False, 'error': 'Enter your Zotero API key.'})
    try:
        zotero_id, username = zotero.verify_key(api_key)
    except zotero.ZoteroError as exc:
        return Response({'ok': False, 'error': str(exc)})
    conn, _ = ZoteroConnection.objects.update_or_create(user=request.user, defaults={
        'zotero_user_id': zotero_id, 'username': username, 'last_four': api_key[-4:],
        'api_key_encrypted': crypto.encrypt(api_key)})
    return Response(_status(conn))


def _zotero_view(fn):
    """Run `fn(api_key, zotero_user_id, request)` for a connected user; Zotero problems become {ok: false, error}."""
    def wrapper(request):
        try:
            zid, key = zotero.get_zotero_key(request.user)
            body = fn(key, zid, request)
            zotero.touch(request.user.zotero)
            return Response({'ok': True, **body})
        except zotero.ZoteroError as exc:
            return Response({'ok': False, 'error': str(exc)})
        except ValueError as exc:  # bad numbers in the query string, or an undecryptable key
            return Response({'ok': False, 'error': str(exc) if 'decrypt' in str(exc) else 'Invalid request.'})
    wrapper.__name__ = fn.__name__
    return api_view(['GET'])(wrapper)


@_zotero_view
def zotero_libraries(key, zid, request):
    return {'libraries': zotero.libraries(key, zid)}


@_zotero_view
def zotero_collections(key, zid, request):
    prefix = zotero.library_prefix(key, zid, request.query_params.get('library'))
    return {'collections': zotero.collections(key, prefix)}


@_zotero_view
def zotero_items(key, zid, request):
    q = request.query_params
    prefix = zotero.library_prefix(key, zid, q.get('library'))
    collection = q.get('collection') or ''
    if collection and not collection.isalnum():
        raise zotero.ZoteroError('Unknown collection.')
    rows, total = zotero.items(key, prefix, (q.get('q') or '').strip()[:200], collection,
                               int(q.get('start') or 0), int(q.get('limit') or 25))
    return {'items': rows, 'total': total}
