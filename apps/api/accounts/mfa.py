"""Two-factor authentication (v0.1.3, #91): TOTP codes and recovery codes from allauth's library code (see
docs/spike-allauth.md), behind our own endpoints and our own tokens.

Sign-in with a second factor is two steps. The password step (accounts/views.LoginSerializer) answers
`{mfaRequired, ticket}` and issues **no** access token and **no** refresh cookie; `POST /api/auth/login/mfa` redeems the
ticket with a code and only then issues them. A refresh token therefore only ever exists after complete sign-in, so
`/api/auth/refresh` cannot be used to skip the step; turning the factor on revokes the refresh tokens issued before.
Nothing here uses a Django session: the setup secret travels in a signed, short-lived token."""
import io
import secrets
from urllib.parse import quote

from allauth.mfa.models import Authenticator
from allauth.mfa.recovery_codes.internal.auth import RecoveryCodes
from allauth.mfa.totp.internal import auth as totp
from django.contrib.auth import get_user_model
from django.core import signing
from django.core.cache import cache
from django.db import transaction
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from common import ratelimit

from . import cookies, mail
from .passwords import revoke_refresh_tokens

User = get_user_model()
TICKET_SALT = 'openprism.mfa-ticket'
SETUP_SALT = 'openprism.mfa-setup'
TICKET_SECONDS = 300
SETUP_SECONDS = 600
TICKET_ATTEMPTS = 5          # wrong codes per ticket
ADDRESS_ATTEMPTS = 10        # wrong codes per account per 15 minutes
BAD_CODE = 'That code is not correct.'
BAD_TICKET = 'This sign-in has expired. Enter your password again.'


class MfaError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message, self.status = message, status


def fail(error):
    return Response({'ok': False, 'error': error.message}, status=error.status)


def totp_factor(user):
    return Authenticator.objects.filter(user=user, type=Authenticator.Type.TOTP).first()


def recovery_factor(user):
    return Authenticator.objects.filter(user=user, type=Authenticator.Type.RECOVERY_CODES).first()


def enabled(user):
    return totp_factor(user) is not None


def recovery_codes_left(user):
    factor = recovery_factor(user)
    return len(RecoveryCodes(factor).get_unused_codes()) if factor else 0


def check_code(user, code):
    """True when `code` is a current authenticator code (each accepted once) or an unused recovery code (spent now).
    Wrong guesses count against the account; over the limit nothing is accepted for a while (429)."""
    code = ''.join(str(code or '').split())
    if not code or len(code) > 20:
        return False
    blocked = cache.get(f'mfa-locked:{user.pk}')
    if blocked:
        raise MfaError('Too many wrong codes. Try again in a few minutes.', 429)
    factor = totp_factor(user)
    ok = False
    if factor and code.isdigit() and len(code) == 6:
        ok = totp.TOTP(factor).validate_code(code)
    if not ok:
        recovery = recovery_factor(user)
        ok = bool(recovery) and RecoveryCodes(recovery).validate_code(code)
    if not ok:
        wait = ratelimit.hit('mfa-wrong', user.pk, ADDRESS_ATTEMPTS, window_seconds=900)
        if wait:
            cache.set(f'mfa-locked:{user.pk}', 1, wait)
            raise MfaError('Too many wrong codes. Try again in a few minutes.', 429)
    return ok


def make_ticket(user):
    return signing.TimestampSigner(salt=TICKET_SALT).sign(f'{user.pk}:{secrets.token_urlsafe(12)}')


def redeem_ticket(ticket, code):
    """The account the ticket was issued for, when `code` is right. A ticket allows a few wrong codes and works once."""
    try:
        uid, jti = signing.TimestampSigner(salt=TICKET_SALT).unsign(str(ticket or ''), max_age=TICKET_SECONDS).split(':', 1)
        user = User.objects.get(pk=uid, is_active=True)
    except Exception:  # noqa: BLE001 - bad signature, expired, unknown account: one answer
        raise MfaError(BAD_TICKET) from None
    if cache.get(f'mfa-ticket-used:{jti}'):
        raise MfaError(BAD_TICKET)
    if ratelimit.hit('mfa-ticket', jti, TICKET_ATTEMPTS, window_seconds=TICKET_SECONDS):
        raise MfaError(BAD_TICKET)
    if not check_code(user, code):
        raise MfaError(BAD_CODE)
    if not cache.add(f'mfa-ticket-used:{jti}', 1, TICKET_SECONDS + 60):  # two requests racing with one ticket
        raise MfaError(BAD_TICKET)
    return user


def require_password(user, password):
    if not user.check_password(str(password or '')):
        raise MfaError('Your password is not correct.')


def otpauth_uri(user, secret):
    from django.conf import settings
    issuer = settings.MFA_TOTP_ISSUER
    return f'otpauth://totp/{quote(issuer)}:{quote(user.email)}?secret={secret}&issuer={quote(issuer)}'


def qr_svg(text):
    import qrcode
    import qrcode.image.svg
    buffer = io.BytesIO()
    qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage, border=2).save(buffer)
    return buffer.getvalue().decode()


def fresh_session(user, body):
    """After a security change: every other browser is signed out, this one continues with new tokens."""
    from .views import _tokens
    revoke_refresh_tokens(user)
    tokens = _tokens(user)
    return cookies.with_session(Response({'ok': True, **body, **tokens}), tokens)


def notice(user, template):
    mail.send_template(user.email, template, {'name': user.name or user.email})


def body(request):
    return request.data if isinstance(request.data, dict) else {}


class StatusView(APIView):
    allow_unverified = True

    def get(self, request):
        return Response({'ok': True, 'enabled': enabled(request.user), 'recoveryCodesLeft': recovery_codes_left(request.user)})


class SetupView(APIView):
    """POST {password}: a new secret to show once (as text and QR code). Nothing is stored until `enable`."""
    allow_unverified = True
    throttle_scope = 'auth'

    def post(self, request):
        user = request.user
        try:
            require_password(user, body(request).get('password'))
        except MfaError as e:
            return fail(e)
        if enabled(user):
            return Response({'ok': False, 'error': 'Two-factor authentication is already on.'}, status=409)
        secret = totp.generate_totp_secret()
        uri = otpauth_uri(user, secret)
        setup = signing.TimestampSigner(salt=SETUP_SALT).sign(f'{user.pk}:{secret}')
        return Response({'ok': True, 'secret': secret, 'uri': uri, 'qrSvg': qr_svg(uri), 'setup': setup})


class EnableView(APIView):
    """POST {setup, code}: the first code proves the app has the secret. Returns the recovery codes, once."""
    allow_unverified = True
    throttle_scope = 'auth'

    def post(self, request):
        user, b = request.user, body(request)
        try:
            uid, secret = signing.TimestampSigner(salt=SETUP_SALT).unsign(str(b.get('setup') or ''), max_age=SETUP_SECONDS).split(':', 1)
            if uid != str(user.pk):
                raise signing.BadSignature()
        except signing.BadSignature:
            return Response({'ok': False, 'error': 'This setup has expired. Start again.'}, status=400)
        code = ''.join(str(b.get('code') or '').split())
        if ratelimit.hit('mfa-enable', user.pk, ADDRESS_ATTEMPTS, window_seconds=900):
            return Response({'ok': False, 'error': 'Too many attempts. Try again in a few minutes.'}, status=429)
        if not (code.isdigit() and totp.validate_totp_code(secret, code)):
            return Response({'ok': False, 'error': BAD_CODE}, status=400)
        with transaction.atomic():
            if enabled(user):
                return Response({'ok': False, 'error': 'Two-factor authentication is already on.'}, status=409)
            factor = totp.TOTP.activate(user, secret)
            factor.validate_code(code)  # spends the code, so it cannot also sign someone in
            codes = RecoveryCodes.activate(user).get_unused_codes()
        notice(user, 'mfa_enabled')
        return fresh_session(user, {'recoveryCodes': codes})


class RecoveryCodesView(APIView):
    """POST {password, code}: new recovery codes; the old ones stop working."""
    allow_unverified = True
    throttle_scope = 'auth'

    def post(self, request):
        user, b = request.user, body(request)
        try:
            require_password(user, b.get('password'))
            if not enabled(user):
                return Response({'ok': False, 'error': 'Two-factor authentication is not on.'}, status=409)
            if not check_code(user, b.get('code')):
                return Response({'ok': False, 'error': BAD_CODE}, status=400)
        except MfaError as e:
            return fail(e)
        with transaction.atomic():
            Authenticator.objects.filter(user=user, type=Authenticator.Type.RECOVERY_CODES).delete()
            codes = RecoveryCodes.activate(user).get_unused_codes()
        return Response({'ok': True, 'recoveryCodes': codes})


class DisableView(APIView):
    """POST {password, code}: turns the factor off (a recovery code is accepted as the code)."""
    allow_unverified = True
    throttle_scope = 'auth'

    def post(self, request):
        user, b = request.user, body(request)
        try:
            require_password(user, b.get('password'))
            if not enabled(user):
                return Response({'ok': False, 'error': 'Two-factor authentication is not on.'}, status=409)
            if not check_code(user, b.get('code')):
                return Response({'ok': False, 'error': BAD_CODE}, status=400)
        except MfaError as e:
            return fail(e)
        remove(user)
        notice(user, 'mfa_disabled')
        return fresh_session(user, {})


def remove(user):
    Authenticator.objects.filter(user=user).delete()


class LoginMfaView(APIView):
    """POST {ticket, code}: the second step of signing in. Issues the tokens the password step withheld."""
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_scope = 'auth'

    def post(self, request):
        b = body(request)
        try:
            user = redeem_ticket(b.get('ticket'), b.get('code'))
        except MfaError as e:
            return fail(e)
        from .views import _tokens
        tokens = _tokens(user)
        return cookies.with_session(Response({'ok': True, 'access': tokens['access'], 'refresh': tokens['refresh']}), tokens)
