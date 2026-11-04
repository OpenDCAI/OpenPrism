"""Forgotten-password reset by email, and changing the password while signed in.

The reset token is Django's PasswordResetTokenGenerator: it is derived from the password hash and last login, so it dies
as soon as the password changes (single use) and after PASSWORD_RESET_TIMEOUT. Any password change revokes every refresh
token the user holds, so other browsers are signed out at their next refresh."""
from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.contrib.auth.tokens import default_token_generator
from django.core.exceptions import ValidationError
from django.utils.encoding import force_bytes, force_str
from django.utils.http import urlsafe_base64_decode, urlsafe_base64_encode
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken

from . import mail

User = get_user_model()


def revoke_refresh_tokens(user):
    for token in OutstandingToken.objects.filter(user=user):
        BlacklistedToken.objects.get_or_create(token=token)


def _password_error(password, user):
    try:
        validate_password(password, user)
    except ValidationError as exc:
        return ' '.join(exc.messages)
    return None


def set_new_password(user, password):
    user.set_password(password)
    user.save(update_fields=['password'])
    revoke_refresh_tokens(user)
    mail.send_template(user.email, 'password_changed', {'name': user.name or user.email})


class ForgotPasswordView(APIView):
    permission_classes = [AllowAny]
    throttle_scope = 'auth'

    def post(self, request):
        email = str((request.data or {}).get('email') or '').strip().lower()
        user = User.objects.filter(email=email, is_active=True).first() if email else None
        if user:
            uid = urlsafe_base64_encode(force_bytes(user.pk))
            link = mail.app_link(f'/reset-password?uid={uid}&token={default_token_generator.make_token(user)}')
            mail.send_template(user.email, 'password_reset', {'name': user.name or user.email, 'link': link})
        return Response({'ok': True})  # the same answer either way: whether an account exists is not revealed


class ResetPasswordView(APIView):
    permission_classes = [AllowAny]
    throttle_scope = 'auth'

    def post(self, request):
        b = request.data if isinstance(request.data, dict) else {}
        try:
            user = User.objects.get(pk=force_str(urlsafe_base64_decode(str(b.get('uid') or ''))), is_active=True)
        except (User.DoesNotExist, ValueError, TypeError, ValidationError):
            user = None
        if user is None or not default_token_generator.check_token(user, str(b.get('token') or '')):
            return Response({'ok': False, 'error': 'This reset link is invalid or has expired. Ask for a new one.'}, status=400)
        password = str(b.get('password') or '')
        error = _password_error(password, user)
        if error:
            return Response({'ok': False, 'error': error}, status=400)
        set_new_password(user, password)
        return Response({'ok': True})


class ChangePasswordView(APIView):
    allow_unverified = True
    throttle_scope = 'auth'

    def post(self, request):
        b = request.data if isinstance(request.data, dict) else {}
        user = request.user
        if not user.check_password(str(b.get('current') or '')):
            return Response({'ok': False, 'error': 'Your current password is not correct.'}, status=400)
        password = str(b.get('password') or '')
        error = _password_error(password, user)
        if error:
            return Response({'ok': False, 'error': error}, status=400)
        set_new_password(user, password)
        from .views import _tokens
        return Response({'ok': True, **_tokens(user)})  # this browser stays signed in with fresh tokens
