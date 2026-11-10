"""Passkeys (v0.1.4, #96): WebAuthn credentials that sign a person in with no password and no code.

Built on allauth's `allauth.mfa.webauthn` library code (credential storage in `Authenticator`, user handles), driven by
fido2 directly because allauth keeps the ceremony's challenge in a Django session and we use none: the state lives in the
shared cache under a random id the browser returns, single use, five minutes. Every passkey is registered with user
verification required (biometric or PIN) and a discoverable credential, so one passkey is both factors and sign-in needs
no username; it therefore also skips the TOTP step. The relying-party id is the host of APP_BASE_URL: changing the host
invalidates every passkey."""
import secrets
from urllib.parse import urlparse

from allauth.mfa.models import Authenticator
from allauth.mfa.webauthn.internal import auth as wa
from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone
from fido2.server import Fido2Server
from fido2.webauthn import (PublicKeyCredentialRpEntity, ResidentKeyRequirement, UserVerificationRequirement)
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from common import ratelimit

from . import cookies, mfa
from .passwords import revoke_refresh_tokens

STATE_SECONDS = 300
BAD = 'That passkey could not be verified. Try again or use your password.'
MAX_PER_USER = 20


def rp_id():
    return settings.PASSKEY_RP_ID or urlparse(settings.APP_BASE_URL).hostname or 'localhost'


def allowed_origins():
    return {o.rstrip('/') for o in (settings.APP_BASE_URL, *settings.TRUSTED_ORIGINS) if o}


def server():
    return Fido2Server(PublicKeyCredentialRpEntity(id=rp_id(), name='OpenPrism'),
                       verify_origin=lambda origin: origin.rstrip('/') in allowed_origins())


def keep_state(state, user_id=''):
    sid = secrets.token_urlsafe(24)
    cache.set(f'passkey-state:{sid}', (state, user_id), STATE_SECONDS)
    return sid


def take_state(sid, user_id=''):
    """The ceremony state, once. A state made for someone else's registration is not usable."""
    key = f'passkey-state:{str(sid or "")[:80]}'
    found = cache.get(key)
    if not found or not cache.delete(key):
        return None
    state, owner = found
    return state if owner == user_id else None


def passkeys(user):
    return Authenticator.objects.filter(user=user, type=Authenticator.Type.WEBAUTHN).order_by('created_at')


def describe(a):
    return {'id': str(a.pk), 'name': a.data.get('name', ''), 'createdAt': a.created_at, 'lastUsedAt': a.last_used_at}


def begin_registration(user):
    options, state = server().register_begin(
        user=wa.build_user_payload(user), credentials=wa.get_credentials(user),
        resident_key_requirement=ResidentKeyRequirement.REQUIRED,
        user_verification=UserVerificationRequirement.REQUIRED, extensions=wa.EXTENSIONS)
    return dict(options), keep_state(state, str(user.pk))


def finish_registration(user, state_id, credential, name):
    state = take_state(state_id, str(user.pk))
    if not state:
        raise ValueError('expired')
    server().register_complete(state, credential)
    if (credential.get('clientExtensionResults') or {}).get('credProps', {}).get('rk') is False:
        raise ValueError('not discoverable')  # it could never sign in without a username
    return wa.WebAuthn.add(user, name, credential).instance


def begin_login():
    options, state = server().authenticate_begin(credentials=[], user_verification=UserVerificationRequirement.REQUIRED)
    return dict(options), keep_state(state)


def finish_login(state_id, response):
    """The account the assertion belongs to. Raises on anything wrong (one message to the caller)."""
    state = take_state(state_id)
    if not state or not isinstance(response, dict):
        raise ValueError('no state')
    user = wa.extract_user_from_response(response)
    if not user.is_active:
        raise ValueError('inactive')
    binding = server().authenticate_complete(state, wa.get_credentials(user), response)
    authenticator = wa.get_authenticator_by_credential_id(user, binding.credential_id)
    if authenticator is None:
        raise ValueError('unknown credential')
    authenticator.last_used_at = timezone.now()
    authenticator.save(update_fields=['last_used_at'])
    return user


def body(request):
    return request.data if isinstance(request.data, dict) else {}


def clean_name(value):
    return (' '.join(str(value or '').split()) or 'Passkey')[:60]


class PasskeysView(APIView):
    allow_unverified = True
    throttle_scope = 'auth'

    def get(self, request):
        return Response({'ok': True, 'passkeys': [describe(a) for a in passkeys(request.user)]})

    def post(self, request):
        """{state, credential, name}: store the passkey the browser just made."""
        user, b = request.user, body(request)
        if passkeys(user).count() >= MAX_PER_USER:
            return Response({'ok': False, 'error': 'You have the most passkeys allowed. Remove one first.'}, status=400)
        try:
            with transaction.atomic():
                authenticator = finish_registration(user, b.get('state'), b.get('credential') or {}, clean_name(b.get('name')))
        except Exception:  # noqa: BLE001 - every failure is the same to the caller
            return Response({'ok': False, 'error': BAD}, status=400)
        mfa.notice(user, 'passkey_added')
        return Response({'ok': True, 'passkey': describe(authenticator)}, status=201)


class OptionsView(APIView):
    """POST {password}: creation options for navigator.credentials.create()."""
    allow_unverified = True
    throttle_scope = 'auth'

    def post(self, request):
        try:
            mfa.require_password(request.user, body(request).get('password'))
        except mfa.MfaError as e:
            return mfa.fail(e)
        options, state = begin_registration(request.user)
        return Response({'ok': True, 'options': options, 'state': state})


class PasskeyView(APIView):
    allow_unverified = True
    throttle_scope = 'auth'

    def get_object(self, request, pk):
        try:
            return passkeys(request.user).filter(pk=pk).first()
        except (ValueError, TypeError):
            return None

    def patch(self, request, pk):
        a = self.get_object(request, pk)
        if a is None:
            return Response({'ok': False, 'error': 'Passkey not found.'}, status=404)
        a.data['name'] = clean_name(body(request).get('name'))
        a.save(update_fields=['data'])
        return Response({'ok': True, 'passkey': describe(a)})

    def delete(self, request, pk):
        """Needs the password in the body. Signs other browsers out; this one carries on."""
        user = request.user
        try:
            mfa.require_password(user, body(request).get('password'))
        except mfa.MfaError as e:
            return mfa.fail(e)
        a = self.get_object(request, pk)
        if a is None:
            return Response({'ok': False, 'error': 'Passkey not found.'}, status=404)
        from . import methods
        if not methods.others_remain(user, passkey=a):
            return Response({'ok': False, 'error': methods.LAST_METHOD}, status=400)
        a.delete()
        mfa.notice(user, 'passkey_removed')
        return mfa.fresh_session(user, {})


class LoginOptionsView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_scope = 'auth'

    def post(self, request):
        options, state = begin_login()
        return Response({'ok': True, 'options': options, 'state': state})


class LoginView(APIView):
    """POST {state, credential}: sign in with a passkey. Tokens exactly like password login."""
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_scope = 'auth'

    def post(self, request):
        b = body(request)
        try:
            user = finish_login(b.get('state'), b.get('credential'))
        except Exception:  # noqa: BLE001 - wrong, replayed, expired, unknown account: one answer
            return Response({'ok': False, 'error': BAD}, status=400)
        if ratelimit.hit('passkey-login', user.pk, 30, window_seconds=900):
            return Response({'ok': False, 'error': 'Too many attempts. Try again in a few minutes.'}, status=429)
        from .views import _tokens
        tokens = _tokens(user)
        return cookies.with_session(Response({'ok': True, 'access': tokens['access']}), tokens)
