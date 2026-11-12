"""AI settings of a workspace or a project (#78): four profiles (llm, search, vision, mineru), each with an endpoint, a
model, an encrypted key and an optional daily limit. A project's row overrides its workspace's for that profile only.

Only usable() decrypts a key. Saving records a credential event (never key material). Changing an endpoint needs the key
typed again, so a script running as an admin cannot point a stored key at another server."""
from django.db import transaction

from ai.llm import normalize_chat_endpoint
from ai.ssrf import BlockedEndpoint, assert_public_url
from projects.models import Membership, Project

from . import audit, crypto
from .models import AiProfile, CredentialEvent

LLM, SEARCH, VISION, MINERU = AiProfile.LLM, AiProfile.SEARCH, AiProfile.VISION, AiProfile.MINERU
PROFILES = [p for p, _ in AiProfile.PROFILES]
FALLBACK = {SEARCH: LLM, VISION: LLM}      # unset Search / Vision use the AI model
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


def clean_mineru_base(value):
    value = str(value or '').strip().rstrip('/')
    if not value:
        return ''
    try:
        assert_public_url(value)
    except BlockedEndpoint as exc:
        raise LlmConfigError(str(exc)) from None
    return value


def clean_daily_limit(value):
    """AI jobs per day through the provider: 1-MAX_DAILY_LIMIT, or None/'' for no limit."""
    if value is None or value == '':
        return None
    if isinstance(value, bool) or not isinstance(value, (int, str)) or not str(value).strip().isdigit() \
            or not 1 <= int(value) <= MAX_DAILY_LIMIT:
        raise LlmConfigError(f'The daily limit must be a whole number from 1 to {MAX_DAILY_LIMIT}, or empty for no limit.')
    return int(value)


def _where(owner):
    return {'project': owner} if isinstance(owner, Project) else {'workspace': owner}


def get(owner, profile):
    return AiProfile.objects.filter(profile=profile, **_where(owner)).first()


def status(owner):
    """Per profile {endpoint, model, lastFour, dailyLimit, updatedAt} or None. Never the key."""
    rows = {r.profile: r for r in AiProfile.objects.filter(**_where(owner))}
    return {p: ({'endpoint': r.endpoint, 'model': r.model, 'lastFour': r.last_four, 'dailyLimit': r.daily_limit,
                 'updatedAt': r.updated_at.isoformat().replace('+00:00', 'Z')} if (r := rows.get(p)) else None)
            for p in PROFILES}


def _event(owner, profile, action, user, row=None, detail=None):
    workspace = owner.workspace if isinstance(owner, Project) else owner
    detail = dict(detail or {})
    if isinstance(owner, Project):
        detail['projectId'] = str(owner.id)
    if profile == LLM and not isinstance(owner, Project):
        kind = CredentialEvent.WORKSPACE_LLM       # the history the workspace block has always shown
    else:
        kind, detail['profile'] = CredentialEvent.AI_PROFILE, profile
    audit.record(kind, action, user, workspace=workspace, last_four=row.last_four if row else '', detail=detail)


def _detail(changed):
    names = {'endpoint': 'endpoint', 'model': 'model', 'daily_limit': 'dailyLimit'}
    return {names[k]: v for k, v in changed.items()}


def save(owner, user, profile, endpoint=None, model=None, api_key=None, daily_limit=UNSET):
    """Create or update one profile. `None` fields (and an omitted `daily_limit`) keep their value. A key is needed the
    first time and whenever the endpoint changes; the model and the limit may change on their own."""
    if profile not in PROFILES:
        raise LlmConfigError('Unknown AI setting.')
    row = get(owner, profile)
    api_key = str(api_key or '').strip()
    if len(api_key) > MAX_KEY_CHARS:
        raise LlmConfigError('That API key is too long.')
    if row is None and not api_key:
        raise LlmConfigError('Enter an API key.')
    public = {}
    if daily_limit is not UNSET:
        public['daily_limit'] = clean_daily_limit(daily_limit)
    if endpoint is not None:
        public['endpoint'] = clean_mineru_base(endpoint) if profile == MINERU else clean_endpoint(endpoint)
    if model is not None and profile != MINERU:
        public['model'] = str(model).strip()[:200]
    created = row is None
    changed = {k: v for k, v in public.items() if created or getattr(row, k) != v}
    if row is not None and 'endpoint' in changed and not api_key:
        raise LlmConfigError('Enter the API key again to change the endpoint.')
    new_key = bool(api_key) and (created or crypto.decrypt(row.api_key_encrypted) != api_key)
    if not created and not changed and not new_key:
        return row   # an identical save writes and records nothing
    fields = {'updated_by': user, **public}
    if new_key:
        fields.update(api_key_encrypted=crypto.encrypt(api_key), last_four=api_key[-4:])
    with transaction.atomic():
        if created:
            row = AiProfile.objects.create(profile=profile, **_where(owner), **fields)
        else:
            for k, v in fields.items():
                setattr(row, k, v)
            row.save()
        action = CredentialEvent.SET if created else CredentialEvent.ROTATED if new_key else CredentialEvent.UPDATED
        _event(owner, profile, action, user, row, _detail(changed))
    return row


def remove(owner, user, profile):
    """Delete one profile and record it. Returns False when there was none."""
    with transaction.atomic():
        row = get(owner, profile)
        if row is None:
            return False
        row.delete()
        audit.record(CredentialEvent.WORKSPACE_LLM if (profile == LLM and not isinstance(owner, Project))
                     else CredentialEvent.AI_PROFILE, CredentialEvent.REMOVED, user,
                     workspace=owner.workspace if isinstance(owner, Project) else owner,
                     detail={} if (profile == LLM and not isinstance(owner, Project))
                     else {'profile': profile, **({'projectId': str(owner.id)} if isinstance(owner, Project) else {})})
    return True


def may_use(user, workspace):
    """Workspace and project settings are used by members who can write (owner, admin, editor)."""
    return workspace is not None and getattr(user, 'is_authenticated', False) and not getattr(user, 'is_guest', False) \
        and Membership.objects.filter(workspace=workspace, user=user, role__in=Membership.WRITE_ROLES).exists()


def usable(user, project, workspace, profile):
    """({endpoint, model}, key, level) for the profile a request should use, or None. Order: the project's own row, the
    workspace's row, then for Search / Vision the AI model the same way. level is 'project' or 'workspace'."""
    if not may_use(user, workspace):
        return None
    for p in (profile, FALLBACK.get(profile)):
        if not p:
            continue
        for level, owner in (('project', project), ('workspace', workspace)):
            row = owner is not None and get(owner, p)
            if row:
                public = {k: v for k, v in (('endpoint', row.endpoint), ('model', row.model)) if v}
                return public, crypto.decrypt(row.api_key_encrypted), level
    return None


def effective(project, workspace):
    """Where each profile comes from for a project (or a workspace when project is None): {profile: {source, endpoint,
    model, lastFour} | None}. source: 'project', 'workspace' or 'llm' (Search / Vision following the AI model)."""
    out = {}
    for profile in PROFILES:
        found = None
        for p in (profile, FALLBACK.get(profile)):
            if not p or found:
                continue
            for level, owner in (('project', project), ('workspace', workspace)):
                row = owner is not None and get(owner, p)
                if row:
                    found = {'source': level, 'viaLlm': p != profile, 'endpoint': row.endpoint, 'model': row.model,
                             'lastFour': row.last_four}
                    break
        out[profile] = found
    return out
