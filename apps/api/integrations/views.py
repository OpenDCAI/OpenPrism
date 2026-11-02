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
