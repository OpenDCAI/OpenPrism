"""Users' own AI keys (UserCredential): saved and removed through the API, never returned, decrypted only by
resolve(). An endpoint is stored with its key, and changing it needs the key again, so a script running as the user
cannot point a stored key at another server."""
from django.db import transaction

from ai.ssrf import BlockedEndpoint, assert_public_url

from . import audit, crypto
from .llmconfig import MAX_KEY_CHARS, LlmConfigError, clean_endpoint
from .models import CredentialEvent, UserCredential

PROFILES = [p for p, _ in UserCredential.PROFILES]
FALLBACK = {UserCredential.SEARCH: UserCredential.LLM, UserCredential.VISION: UserCredential.LLM}


def _clean_mineru_base(value):
    value = str(value or '').strip().rstrip('/')
    if not value:
        return ''
    try:
        assert_public_url(value)
    except BlockedEndpoint as exc:
        raise LlmConfigError(str(exc)) from None
    return value


def status(user):
    rows = {c.profile: c for c in UserCredential.objects.filter(user=user)}
    return {p: ({'endpoint': c.endpoint, 'model': c.model, 'lastFour': c.last_four,
                 'updatedAt': c.updated_at.isoformat().replace('+00:00', 'Z')} if (c := rows.get(p)) else None)
            for p in PROFILES}


def _event(profile, action, user, cred=None, detail=None):
    kind = CredentialEvent.USER_MINERU if profile == UserCredential.MINERU else CredentialEvent.USER_LLM
    audit.record(kind, action, user, owner=user, last_four=cred.last_four if cred else '',
                 detail={'profile': profile, **(detail or {})})


def save(user, profile, endpoint=None, model=None, api_key=None):
    """Create or update one profile. `None` keeps a field. A key is needed the first time and whenever the endpoint
    changes; the model may change on its own."""
    if profile not in PROFILES:
        raise LlmConfigError('Unknown key profile.')
    cred = UserCredential.objects.filter(user=user, profile=profile).first()
    api_key = str(api_key or '').strip()
    if len(api_key) > MAX_KEY_CHARS:
        raise LlmConfigError('That API key is too long.')
    changed = {}
    if endpoint is not None:
        clean = _clean_mineru_base(endpoint) if profile == UserCredential.MINERU else clean_endpoint(endpoint)
        if cred is None or clean != cred.endpoint:
            changed['endpoint'] = clean
    if model is not None and profile != UserCredential.MINERU:
        clean = str(model).strip()[:200]
        if cred is None or clean != cred.model:
            changed['model'] = clean
    if cred is None and not api_key:
        raise LlmConfigError('Enter an API key.')
    if cred is not None and 'endpoint' in changed and not api_key:
        raise LlmConfigError('Enter the API key again to change the endpoint.')
    new_key = bool(api_key) and (cred is None or crypto.decrypt(cred.api_key_encrypted) != api_key)
    if cred is not None and not changed and not new_key:
        return cred
    fields = dict(changed)
    if new_key:
        fields.update(api_key_encrypted=crypto.encrypt(api_key), last_four=api_key[-4:])
    with transaction.atomic():
        created = cred is None
        if created:
            cred = UserCredential.objects.create(user=user, profile=profile, **fields)
        else:
            for k, v in fields.items():
                setattr(cred, k, v)
            cred.save()
        action = CredentialEvent.SET if created else CredentialEvent.ROTATED if new_key else CredentialEvent.UPDATED
        _event(profile, action, user, cred, changed)
    return cred


def remove(user, profile):
    with transaction.atomic():
        if UserCredential.objects.filter(user=user, profile=profile).delete()[0]:
            _event(profile, CredentialEvent.REMOVED, user)
            return True
    return False


def resolve(user, profile):
    """({endpoint, model}, key) of the user's stored profile (search/vision fall back to llm), or None. Accounts only."""
    if getattr(user, 'is_guest', False) or not getattr(user, 'is_authenticated', False):
        return None
    profile = profile if profile in PROFILES else UserCredential.LLM
    for p in (profile, FALLBACK.get(profile)):
        cred = p and UserCredential.objects.filter(user=user, profile=p).first()
        if cred:
            public = {k: v for k, v in (('endpoint', cred.endpoint), ('model', cred.model)) if v}
            return public, crypto.decrypt(cred.api_key_encrypted)
    return None
