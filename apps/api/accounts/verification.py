"""Email verification. The link carries a signed, timestamped `<user id>:<email>` (django.core.signing), so it stops
working after EMAIL_VERIFY_MAX_AGE or if the address changes. Verifying accepts the workspace invitations waiting for
that address: until then nobody has shown they own it."""
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core import signing
from django.utils import timezone
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from . import mail

User = get_user_model()
SALT = 'openprism.email-verify'


def make_token(user):
    return signing.TimestampSigner(salt=SALT).sign(f'{user.pk}:{user.email}')


def send_verification(user):
    link = mail.app_link(f'/verify-email?token={make_token(user)}')
    mail.send_template(user.email, 'verify_email', {'name': user.name or user.email, 'link': link})


def mark_verified(user):
    from projects.workspaces import accept_pending_invites
    if user.email_verified_at is None:
        user.email_verified_at = timezone.now()
        user.save(update_fields=['email_verified_at'])
    accept_pending_invites(user)


class VerifyEmailView(APIView):
    """POST {token}. Public: the link may be opened in a browser where the account is not signed in."""
    permission_classes = [AllowAny]
    throttle_scope = 'auth'

    def post(self, request):
        token = str((request.data or {}).get('token') or '')
        try:
            uid, email = signing.TimestampSigner(salt=SALT).unsign(token, max_age=settings.EMAIL_VERIFY_MAX_AGE).split(':', 1)
            user = User.objects.get(pk=uid, email=email, is_active=True)
        except signing.SignatureExpired:
            return Response({'ok': False, 'error': 'This verification link has expired. Sign in and ask for a new one.'}, status=400)
        except (signing.BadSignature, ValueError, User.DoesNotExist, Exception):
            return Response({'ok': False, 'error': 'This verification link is not valid.'}, status=400)
        mark_verified(user)
        return Response({'ok': True, 'email': user.email})


class ResendVerificationView(APIView):
    allow_unverified = True
    throttle_scope = 'auth'

    def post(self, request):
        if request.user.email_verified_at:
            return Response({'ok': True, 'alreadyVerified': True})
        send_verification(request.user)
        return Response({'ok': True})
