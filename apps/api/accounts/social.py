"""Sign in with Google or ORCID (v0.1.4, #98): OpenID Connect authorization code flow with PKCE and a nonce, our own small
client so that nothing needs a Django session. The state lives in the cache (random, single use, 10 minutes). The
id_token is verified with PyJWT against the provider's published keys (signature, issuer, audience, expiry, nonce).

Rules, in the order they matter:
 * A provider email counts only when the provider says it is verified. ORCID usually gives none, so ORCID can only sign in
   identities that were linked from the Account page.
 * An unknown identity whose verified email matches an account links to it only when *that account's* address is verified
   too (otherwise someone could register a victim's address unverified and inherit their provider login).
 * An unknown identity with no account is a sign-up: it goes through `signup.check_signup`, so invitation-only mode holds.
 * An account with a second factor still gets the code step; the result is the same cookie/tickets as password login."""
import base64
import hashlib
import secrets
from urllib.parse import urlencode

import httpx
import jwt
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.utils import timezone

from . import invitations, mfa, signup
from .models import LinkedIdentity

User = get_user_model()
STATE_SECONDS = 600
TICKET_SECONDS = 300
TIMEOUT = 10


class SocialError(Exception):
    """`code` is shown to the browser as ?error=<code>; the messages live in the frontend."""
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def enabled():
    return {name: cfg['label'] for name, cfg in settings.SOCIAL_PROVIDERS.items()}


def provider(name):
    cfg = settings.SOCIAL_PROVIDERS.get(name)
    if cfg is None:
        raise SocialError('unavailable')
    return cfg


def redirect_uri(name):
    return f'{settings.APP_BASE_URL}/api/auth/social/{name}/callback'


def safe_next(value):
    value = str(value or '')
    return value if value.startswith('/') and not value.startswith('//') and not value.startswith('/\\') else '/'


def _b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode()


def make_link_ticket(user):
    ticket = secrets.token_urlsafe(24)
    cache.set(f'social-link:{ticket}', str(user.pk), TICKET_SECONDS)
    return ticket


def start_url(name, intent, ticket='', next_path='/'):
    """Where to send the browser. `link` needs a ticket from `make_link_ticket` (a navigation carries no bearer token)."""
    cfg = provider(name)
    uid = ''
    if intent == 'link':
        key = f'social-link:{str(ticket)[:80]}'
        found = cache.get(key)
        if not found or not cache.delete(key):
            raise SocialError('expired')
        uid = found
    elif intent != 'login':
        raise SocialError('failed')
    state, nonce, verifier = secrets.token_urlsafe(24), secrets.token_urlsafe(24), secrets.token_urlsafe(48)
    cache.set(f'social-state:{state}', {'provider': name, 'intent': intent, 'uid': uid, 'next': safe_next(next_path),
                                        'nonce': nonce, 'verifier': verifier}, STATE_SECONDS)
    query = urlencode({'response_type': 'code', 'client_id': cfg['client_id'], 'redirect_uri': redirect_uri(name),
                       'scope': cfg['scope'], 'state': state, 'nonce': nonce,
                       'code_challenge': _b64(hashlib.sha256(verifier.encode()).digest()), 'code_challenge_method': 'S256'})
    return f"{cfg['auth_url']}?{query}"


def _jwks(cfg, refresh=False):
    key = f"social-jwks:{cfg['jwks_url']}"
    keys = None if refresh else cache.get(key)
    if keys is None:
        keys = httpx.get(cfg['jwks_url'], timeout=TIMEOUT).raise_for_status().json()['keys']
        cache.set(key, keys, 3600)
    return keys


def _signing_key(cfg, token):
    kid = jwt.get_unverified_header(token).get('kid')
    for refresh in (False, True):  # a provider rotates keys: look again once with fresh ones
        for jwk in _jwks(cfg, refresh):
            if jwk.get('kid') == kid:
                return jwt.PyJWK(jwk).key
    raise SocialError('failed')


def exchange(name, code, st):
    """Trade the code for an id_token and return its verified claims."""
    cfg = provider(name)
    try:
        res = httpx.post(cfg['token_url'], timeout=TIMEOUT, headers={'Accept': 'application/json'}, data={
            'grant_type': 'authorization_code', 'code': code, 'redirect_uri': redirect_uri(name),
            'client_id': cfg['client_id'], 'client_secret': cfg['client_secret'], 'code_verifier': st['verifier']})
        res.raise_for_status()
        token = res.json()['id_token']
        claims = jwt.decode(token, _signing_key(cfg, token), algorithms=['RS256'], audience=cfg['client_id'],
                            issuer=cfg['issuer'], options={'require': ['exp', 'iss', 'aud', 'sub']}, leeway=30)
    except SocialError:
        raise
    except Exception:  # noqa: BLE001 - network, JSON, signature, expiry: one answer, nothing logged from the response
        raise SocialError('failed') from None
    if not secrets.compare_digest(str(claims.get('nonce', '')), st['nonce']):
        raise SocialError('failed')
    return claims


def _verified(claims):
    return claims.get('email_verified') in (True, 'true') and bool(claims.get('email'))


def _create_account(email, name, invite):
    from projects.models import Membership, Workspace
    try:
        with transaction.atomic():
            if invite is not None:
                invite = invitations.lock(invite)
                if invite is None:
                    raise SocialError('not_invited')
            user = User.objects.create_user(email, None, name=name[:150])  # no password: an unusable one
            if invite is not None:
                invitations.use(invite, user)
            workspace = Workspace.objects.create(name='Personal', kind=Workspace.PERSONAL, color='#5b6573')
            Membership.objects.create(workspace=workspace, user=user, role=Membership.OWNER)
            from .verification import mark_verified
            mark_verified(user)  # the provider proved the address
            if invite is not None and invite.workspace_id and invite.role:
                Membership.objects.get_or_create(workspace_id=invite.workspace_id, user=user, defaults={'role': invite.role})
            return user
    except IntegrityError:
        raise SocialError('failed') from None


def resolve(name, claims, st):
    """Decide who this is. Returns the account; raises SocialError."""
    subject = str(claims['sub'])
    email = str(claims.get('email') or '').strip().lower() if _verified(claims) else ''
    identity = LinkedIdentity.objects.select_related('user').filter(provider=name, subject=subject).first()
    if st['intent'] == 'link':
        user = User.objects.filter(pk=st['uid'], is_active=True).first()
        if user is None:
            raise SocialError('expired')
        if identity is not None and identity.user_id != user.pk:
            raise SocialError('linked_elsewhere')
        if identity is None:
            LinkedIdentity.objects.create(user=user, provider=name, subject=subject, email=email, email_verified=bool(email))
        return user
    if identity is not None:
        if not identity.user.is_active:
            raise SocialError('failed')
        identity.last_login_at = timezone.now()
        identity.save(update_fields=['last_login_at'])
        return identity.user
    if not email:
        raise SocialError('no_email')
    existing = User.objects.filter(email=email).first()
    if existing is not None:
        if not existing.is_active:
            raise SocialError('failed')
        if existing.email_verified_at is None:
            raise SocialError('verify_first')
        user = existing
    else:
        try:
            invite = signup.check_signup(email, None, address_verified=True)
        except signup.SignupRefused:
            raise SocialError('not_invited') from None
        except Exception:  # noqa: BLE001 - throttled
            raise SocialError('failed') from None
        user = _create_account(email, str(claims.get('name') or ''), invite)
    LinkedIdentity.objects.create(user=user, provider=name, subject=subject, email=email, email_verified=True,
                                  last_login_at=timezone.now())
    return user


def callback(name, params):
    """Handle the provider's redirect. Returns (user, state) or raises SocialError."""
    if params.get('error'):
        raise SocialError('denied')
    key = f"social-state:{str(params.get('state') or '')[:80]}"
    st = cache.get(key)
    if not st or not cache.delete(key) or st['provider'] != name:
        raise SocialError('expired')
    code = str(params.get('code') or '')
    if not code:
        raise SocialError('failed')
    return resolve(name, exchange(name, code, st), st), st


def second_step(user):
    """A ticket for the code step when the account has one."""
    return mfa.make_ticket(user) if mfa.enabled(user) else None
