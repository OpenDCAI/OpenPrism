import re

from rest_framework.decorators import api_view
from rest_framework.response import Response

from collab.views import flush_room, live_room
from projects import files
from projects.access import get_project
from projects.models import ProjectFile
from projects.paths import InvalidPath, safe_path

from . import bibtex, crypto, zotero
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


@api_view(['GET'])
def zotero_bibtex(request):
    """The BibTeX Zotero produces for some items, validated; nothing is written."""
    keys = _item_keys(request.query_params.get('keys'))
    try:
        zid, key = zotero.get_zotero_key(request.user)
        prefix = zotero.library_prefix(key, zid, request.query_params.get('library'))
        got = zotero.bibtex_for(key, prefix, keys, request.query_params.get('style') or 'bibtex')
    except zotero.ZoteroError as exc:
        return Response({'ok': False, 'error': str(exc)})
    entries, refused = [], []
    for k in keys:
        try:
            text, _, cite = bibtex.parse_single_entry((got.get(k) or (None,))[0])
            entries.append({'zoteroKey': k, 'citeKey': cite, 'bibtex': text})
        except bibtex.BibError as exc:
            refused.append({'zoteroKey': k, 'reason': str(exc)})
    return Response({'ok': True, 'entries': entries, 'refused': refused})


def _item_keys(raw):
    keys = [k for k in str(raw or '').split(',') if k]
    return [k for k in dict.fromkeys(keys) if k.isalnum()][:zotero.PAGE_MAX]


BIBLATEX_RE = re.compile(r'\\usepackage\s*(\[[^\]]*\])?\s*\{[^}]*\bbiblatex\b[^}]*\}')


def _bib_file(project, requested):
    if requested:
        path = safe_path(str(requested))
        if not path.lower().endswith('.bib'):
            raise zotero.ZoteroError('The bibliography file must end in .bib.')
        return path
    bibs = [p for p in project.files.filter(kind=ProjectFile.TEXT).values_list('path', flat=True) if p.lower().endswith('.bib')]
    return bibs[0] if len(bibs) == 1 else 'references.bib'


@api_view(['POST'])
def zotero_add(request, pk):
    """Append Zotero items to a project's .bib. Never rewrites existing text; items added earlier are recognised by the
    `% zotero: <library>:<key>` comment above their entry and reported as skipped (with their current cite key)."""
    project = get_project(request, pk, write=True)
    b = request.data if isinstance(request.data, dict) else {}
    keys = _item_keys(','.join(map(str, b.get('keys') or [])) if isinstance(b.get('keys'), list) else '')
    if not keys:
        return Response({'ok': False, 'error': 'Choose at least one reference.'})
    library = str(b.get('library') or '')
    try:
        bib_path = _bib_file(project, b.get('bibFile'))
        zid, api_key = zotero.get_zotero_key(request.user)
        prefix = zotero.library_prefix(api_key, zid, library)
        style = 'biblatex' if any(BIBLATEX_RE.search(c) for c in project.files.filter(
            kind=ProjectFile.TEXT, path__endswith='.tex').values_list('content', flat=True)) else 'bibtex'
        if not flush_room(project, bib_path):  # the live document may hold edits the database has not seen yet
            return Response({'ok': False, 'error': 'Timed out waiting for the collaboration server to save.'})
        try:
            current = files.read_text(project, bib_path)
        except files.FileNotFound:
            current = ''
        got = zotero.bibtex_for(api_key, prefix, keys, style)
    except (zotero.ZoteroError, InvalidPath) as exc:
        return Response({'ok': False, 'error': str(exc)})
    marked, taken = bibtex.existing(current)
    added, skipped, refused, chunks = [], [], [], []
    for k in keys:
        tag = bibtex.marker(library, k)[len('% zotero: '):]
        if tag in marked:
            skipped.append({'zoteroKey': k, 'citeKey': marked[tag]})
            continue
        text, data = got.get(k) or (None, {})
        try:
            entry, _, cite = bibtex.parse_single_entry(text)
            if not bibtex.KEY_RE.match(cite) or cite in taken:  # Zotero's key is unusable here: make our own
                cite = bibtex.unique_key(bibtex.generate_key(data), taken)
                entry = bibtex.with_key(entry, cite)
            bibtex.parse_single_entry(entry)
        except bibtex.BibError as exc:
            refused.append({'zoteroKey': k, 'reason': str(exc)})
            continue
        taken.add(cite)
        chunks.append(f'{bibtex.marker(library, k)}\n{entry}\n')
        added.append({'zoteroKey': k, 'citeKey': cite})
    text = '\n'.join(chunks)
    applied = False
    if text:
        if live_room(project, bib_path):
            pass  # a REST write would be overwritten by the live document: the editor appends `text` itself
        else:
            sep = '' if not current or current.endswith('\n\n') else ('\n' if current.endswith('\n') else '\n\n')
            files.write_text(project, bib_path, current + sep + text)
            applied = True
    return Response({'ok': True, 'file': bib_path, 'added': added, 'skipped': skipped, 'refused': refused,
                     'applied': applied, 'text': text if not applied else ''})
