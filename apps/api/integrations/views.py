import re

from django.db import transaction
from rest_framework.decorators import api_view
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from collab.views import flush_room, live_room
from common import ratelimit
from django.conf import settings
from projects import files
from projects.access import get_project
from projects.models import Membership, ProjectFile
from projects.workspaces import membership_for, require_admin
from projects.paths import InvalidPath, safe_path

from . import aiprofiles, audit, bibtex, crypto, llmconfig, provider, userkeys, zotero
from .models import AiProfile, CredentialEvent, ZoteroConnection


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
        with transaction.atomic():
            if ZoteroConnection.objects.filter(user=request.user).delete()[0]:
                audit.record(CredentialEvent.ZOTERO, CredentialEvent.REMOVED, request.user, owner=request.user)
        return Response({'ok': True})
    api_key = str((request.data or {}).get('apiKey') or '').strip() if isinstance(request.data, dict) else ''
    if not api_key or len(api_key) > 200:
        return Response({'ok': False, 'error': 'Enter your Zotero API key.'})
    try:
        zotero_id, username = zotero.verify_key(api_key)
    except zotero.ZoteroError as exc:
        return Response({'ok': False, 'error': str(exc)})
    if conn is not None and crypto.decrypt(conn.api_key_encrypted) == api_key and conn.zotero_user_id == zotero_id:
        return Response(_status(conn))  # the same key again: nothing changes, nothing is recorded
    with transaction.atomic():
        rotated = conn is not None
        conn, _ = ZoteroConnection.objects.update_or_create(user=request.user, defaults={
            'zotero_user_id': zotero_id, 'username': username, 'last_four': api_key[-4:],
            'api_key_encrypted': crypto.encrypt(api_key)})
        audit.record(CredentialEvent.ZOTERO, CredentialEvent.ROTATED if rotated else CredentialEvent.SET, request.user,
                     owner=request.user, last_four=conn.last_four, detail={'username': username})
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


# ---- workspace LLM provider -----------------------------------------------------------------------------------------

def _llm_status(config, membership):
    can_manage = membership.role in Membership.ADMIN_ROLES
    if config is None:
        return {'ok': True, 'configured': False, 'canManage': can_manage, 'canUse': False}
    body = {'ok': True, 'configured': True, 'endpoint': config.endpoint, 'model': config.model, 'canManage': can_manage,
            'canUse': membership.role in Membership.WRITE_ROLES,
            'updatedAt': config.updated_at.isoformat().replace('+00:00', 'Z'),
            'updatedBy': (config.updated_by.name or config.updated_by.email) if config.updated_by else ''}
    if can_manage:
        from ai.usage import workspace_usage
        body.update(lastFour=config.last_four, dailyLimit=config.daily_limit, usage=workspace_usage(config.workspace_id))
    return body


@api_view(['GET', 'PUT', 'DELETE'])
def workspace_llm(request, pk):
    membership = membership_for(request.user, pk)
    config = AiProfile.objects.select_related('updated_by').filter(workspace_id=pk, profile=AiProfile.LLM).first()
    if request.method == 'GET':
        return Response(_llm_status(config, membership))
    require_admin(request.user, pk)
    if request.method == 'DELETE':
        llmconfig.remove(membership.workspace, request.user)
        return Response(_llm_status(None, membership))
    b = request.data if isinstance(request.data, dict) else {}
    try:
        extra = {'daily_limit': b['dailyLimit']} if 'dailyLimit' in b else {}
        config = llmconfig.save(membership.workspace, request.user, b.get('endpoint'), b.get('model'), b.get('apiKey'), **extra)
    except llmconfig.LlmConfigError as exc:
        return Response({'ok': False, 'error': str(exc)})
    return Response(_llm_status(config, membership))


def _ai_status(workspace, membership):
    """Every profile of a workspace. Members see which exist and whether they can use them; owners and admins also see the
    endpoint, model, last four characters and daily limit (never the key)."""
    can_manage = membership.role in Membership.ADMIN_ROLES
    rows = aiprofiles.status(workspace)
    profiles = {}
    for name, row in rows.items():
        if row is None:
            profiles[name] = {'configured': False}
            continue
        entry = {'configured': True, 'updatedAt': row['updatedAt']}
        if can_manage:
            entry.update(endpoint=row['endpoint'], model=row['model'], lastFour=row['lastFour'], dailyLimit=row['dailyLimit'])
        elif name != aiprofiles.MINERU:
            entry['model'] = row['model']
        profiles[name] = entry
    return {'ok': True, 'canManage': can_manage, 'canUse': membership.role in Membership.WRITE_ROLES, 'profiles': profiles}


@api_view(['GET'])
def workspace_ai(request, pk):
    """All AI settings (AI model, Search, Vision, MinerU) of a workspace (#78)."""
    membership = membership_for(request.user, pk)
    return Response(_ai_status(membership.workspace, membership))


@api_view(['PUT', 'DELETE'])
def workspace_ai_profile(request, pk, profile):
    membership = membership_for(request.user, pk)
    require_admin(request.user, pk)
    if profile not in aiprofiles.PROFILES:
        return Response({'ok': False, 'error': 'Unknown AI setting.'}, status=404)
    if request.method == 'DELETE':
        aiprofiles.remove(membership.workspace, request.user, profile)
        return Response(_ai_status(membership.workspace, membership))
    b = request.data if isinstance(request.data, dict) else {}
    try:
        extra = {'daily_limit': b['dailyLimit']} if 'dailyLimit' in b else {}
        aiprofiles.save(membership.workspace, request.user, profile, b.get('endpoint'), b.get('model'), b.get('apiKey'), **extra)
    except aiprofiles.LlmConfigError as exc:
        return Response({'ok': False, 'error': str(exc)})
    return Response(_ai_status(membership.workspace, membership))


def _project_ai_access(request, pk):
    """(project, membership, can_manage). Everyone in the workspace may read how the project is set up; owners and admins
    of the workspace and the project's creator (with a write role) change overrides; guests have no access."""
    project = get_project(request, pk)
    if getattr(request.user, 'is_guest', False):
        raise PermissionDenied('Only workspace members can see AI settings.')
    membership = Membership.objects.get(workspace=project.workspace, user=request.user)
    can_manage = membership.role in Membership.ADMIN_ROLES or (
        project.created_by_id == request.user.id and membership.role in Membership.WRITE_ROLES)
    return project, membership, can_manage


def _project_ai_status(project, membership, can_manage):
    """For every profile: where it comes from (project / workspace / server), whether this project overrides it, and, for
    those who manage it, the override's endpoint, model, last four characters and limit. Never a key."""
    own = aiprofiles.status(project)
    effective = aiprofiles.effective(project, project.workspace)
    can_use = membership.role in Membership.WRITE_ROLES
    profiles = {}
    for name in aiprofiles.PROFILES:
        e, o = effective[name], own[name]
        entry = {'source': e['source'] if e else 'server', 'viaLlm': bool(e and e['viaLlm']), 'overridden': o is not None}
        if e and can_use and name != aiprofiles.MINERU:
            entry['model'] = e['model']
        if can_manage and o:
            entry.update(endpoint=o['endpoint'], model=o['model'], lastFour=o['lastFour'], dailyLimit=o['dailyLimit'])
        profiles[name] = entry
    return {'ok': True, 'canManage': can_manage, 'canUse': can_use, 'profiles': profiles}


@api_view(['GET'])
def project_ai(request, pk):
    """How a project gets its AI settings (#78): inherited from the workspace, overridden here, or the server's."""
    project, membership, can_manage = _project_ai_access(request, pk)
    return Response(_project_ai_status(project, membership, can_manage))


@api_view(['PUT', 'DELETE'])
def project_ai_profile(request, pk, profile):
    """Override one profile for this project, or reset it to the workspace's."""
    project, membership, can_manage = _project_ai_access(request, pk)
    if not can_manage:
        raise PermissionDenied('Only workspace owners and admins, or the project\'s creator, can change its AI settings.')
    if profile not in aiprofiles.PROFILES:
        return Response({'ok': False, 'error': 'Unknown AI setting.'}, status=404)
    if request.method == 'DELETE':
        aiprofiles.remove(project, request.user, profile)
        return Response(_project_ai_status(project, membership, can_manage))
    b = request.data if isinstance(request.data, dict) else {}
    try:
        extra = {'daily_limit': b['dailyLimit']} if 'dailyLimit' in b else {}
        aiprofiles.save(project, request.user, profile, b.get('endpoint'), b.get('model'), b.get('apiKey'), **extra)
    except aiprofiles.LlmConfigError as exc:
        return Response({'ok': False, 'error': str(exc)})
    return Response(_project_ai_status(project, membership, can_manage))


@api_view(['POST'])
def project_ai_models(request, pk):
    """Load models for a project's own override (same rules as the workspace form)."""
    project, _, can_manage = _project_ai_access(request, pk)
    if not can_manage:
        raise PermissionDenied('Only workspace owners and admins, or the project\'s creator, can do this.')
    ratelimit.enforce('ai', request.user, settings.AI_RATE_PER_MINUTE)
    b = request.data if isinstance(request.data, dict) else {}
    try:
        endpoint, key = provider.resolve(project, b.get('endpoint'), b.get('apiKey'), str(b.get('profile') or 'llm'))
        return Response({'ok': True, 'models': provider.list_models(endpoint, key)})
    except provider.ProviderError as exc:
        return Response({'ok': False, 'error': str(exc)})


@api_view(['POST'])
def project_ai_test(request, pk):
    project, _, can_manage = _project_ai_access(request, pk)
    if not can_manage:
        raise PermissionDenied('Only workspace owners and admins, or the project\'s creator, can do this.')
    ratelimit.enforce('ai', request.user, settings.AI_RATE_PER_MINUTE)
    b = request.data if isinstance(request.data, dict) else {}
    try:
        endpoint, key = provider.resolve(project, b.get('endpoint'), b.get('apiKey'), str(b.get('profile') or 'llm'))
        return Response({'ok': True, 'latencyMs': provider.chat_check(endpoint, key, b.get('model'))})
    except provider.ProviderError as exc:
        return Response({'ok': False, 'error': str(exc)})


@api_view(['POST'])
def workspace_llm_models(request, pk):
    """Load the provider's model list for the settings form (#76). Admins only. The typed key (or, for an unchanged
    endpoint, the stored one) is used for the call and never returned. Not counted against the daily limit."""
    membership_for(request.user, pk)
    require_admin(request.user, pk)
    ratelimit.enforce('ai', request.user, settings.AI_RATE_PER_MINUTE)
    b = request.data if isinstance(request.data, dict) else {}
    try:
        endpoint, key = provider.resolve(pk, b.get('endpoint'), b.get('apiKey'), str(b.get('profile') or 'llm'))
        return Response({'ok': True, 'models': provider.list_models(endpoint, key)})
    except provider.ProviderError as exc:
        return Response({'ok': False, 'error': str(exc)})


@api_view(['POST'])
def workspace_llm_test(request, pk):
    """Send one tiny chat request to the chosen model (#76). Admins only; advice, not a gate on saving."""
    membership_for(request.user, pk)
    require_admin(request.user, pk)
    ratelimit.enforce('ai', request.user, settings.AI_RATE_PER_MINUTE)
    b = request.data if isinstance(request.data, dict) else {}
    try:
        endpoint, key = provider.resolve(pk, b.get('endpoint'), b.get('apiKey'), str(b.get('profile') or 'llm'))
        return Response({'ok': True, 'latencyMs': provider.chat_check(endpoint, key, b.get('model'))})
    except provider.ProviderError as exc:
        return Response({'ok': False, 'error': str(exc)})


@api_view(['GET'])
def workspace_credential_events(request, pk):
    """The workspace's credential history, for owners and admins (others 403, non-members 404)."""
    membership = membership_for(request.user, pk)
    require_admin(request.user, pk)
    return Response(audit.page(CredentialEvent.objects.filter(workspace=membership.workspace),
                               request.query_params.get('before'), request.query_params.get('limit')))


@api_view(['GET'])
def my_credential_events(request):
    """The signed-in user's own credential history (Zotero, their AI keys)."""
    return Response(audit.page(CredentialEvent.objects.filter(owner=request.user),
                               request.query_params.get('before'), request.query_params.get('limit')))


@api_view(['GET'])
def ai_keys(request):
    """The user's own AI key profiles: endpoint, model and last four characters; never the key."""
    return Response({'ok': True, 'profiles': userkeys.status(request.user)})


@api_view(['PUT', 'DELETE'])
def ai_key(request, profile):
    if profile not in userkeys.PROFILES:
        return Response({'ok': False, 'error': 'Unknown key profile.'}, status=404)
    if request.method == 'DELETE':
        userkeys.remove(request.user, profile)
    else:
        b = request.data if isinstance(request.data, dict) else {}
        try:
            userkeys.save(request.user, profile, b.get('endpoint'), b.get('model'), b.get('apiKey'))
        except llmconfig.LlmConfigError as exc:
            return Response({'ok': False, 'error': str(exc)})
    return Response({'ok': True, 'profiles': userkeys.status(request.user)})
