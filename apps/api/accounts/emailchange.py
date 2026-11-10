"""Changing the account's email address (v0.1.3, #90).

The password is required to ask. The new address is held as an *unverified* allauth `EmailAddress` and a signed link
goes to it (1 hour); the old address gets a notice at once, and again when the change happens. Following the link swaps
`User.email`, marks it verified, drops every other address row (so nothing can still claim the old one) and signs out
every browser. The link names the old and the new address, so it dies if either has changed since."""
from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.core import signing
from django.db import IntegrityError, transaction
from django.core.validators import validate_email
from django.core.exceptions import ValidationError
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from common import ratelimit

from . import mail
from .passwords import revoke_refresh_tokens
from .verification import mark_verified

User = get_user_model()
SALT = 'openprism.email-change'
MAX_AGE = 3600
BAD_LINK = 'This link is not valid or has expired. Start the change again from Account settings.'


def pending(user):
    row = EmailAddress.objects.filter(user=user, primary=False, verified=False).order_by('-id').first()
    return row.email if row else None


def taken(email, user):
    return (User.objects.filter(email__iexact=email).exclude(pk=user.pk).exists()
            or EmailAddress.objects.filter(email__iexact=email).exclude(user=user).exists())


class EmailView(APIView):
    """GET: the current address and a pending change. DELETE: cancel the pending change."""
    allow_unverified = True

    def get(self, request):
        return Response({'ok': True, 'email': request.user.email, 'pending': pending(request.user)})

    def delete(self, request):
        EmailAddress.objects.filter(user=request.user, primary=False, verified=False).delete()
        return Response({'ok': True})


class RequestChangeView(APIView):
    allow_unverified = True
    throttle_scope = 'auth'

    def post(self, request):
        user = request.user
        b = request.data if isinstance(request.data, dict) else {}
        from . import methods
        if not methods.confirm(user, b.get('password')):
            return Response({'ok': False, 'error': methods.confirm_error(user)}, status=400)
        new = str(b.get('email') or '').strip().lower()
        try:
            validate_email(new)
        except ValidationError:
            return Response({'ok': False, 'error': 'Enter a full email address, like name@university.edu.'}, status=400)
        if new == user.email:
            return Response({'ok': False, 'error': 'That is already your address.'}, status=400)
        if taken(new, user):
            return Response({'ok': False, 'error': 'An account with this address already exists.'}, status=400)
        if ratelimit.hit('email-change', user.pk, 5, window_seconds=3600):
            return Response({'ok': False, 'error': 'Too many attempts. Try again later.'}, status=429)
        with transaction.atomic():
            EmailAddress.objects.filter(user=user, primary=False, verified=False).delete()
            try:
                with transaction.atomic():
                    EmailAddress.objects.create(user=user, email=new, primary=False, verified=False)
            except IntegrityError:
                return Response({'ok': False, 'error': 'An account with this address already exists.'}, status=400)
        token = signing.TimestampSigner(salt=SALT).sign(f'{user.pk}|{user.email}|{new}')
        name = user.name or user.email
        mail.send_template(new, 'email_change_confirm', {'name': name, 'link': mail.app_link(f'/confirm-email?token={token}')})
        mail.send_template(user.email, 'email_change_requested', {'name': name, 'new_email': new})
        return Response({'ok': True, 'pending': new})


class ConfirmChangeView(APIView):
    """POST {token}: public, because the link may be opened in a browser that is not signed in."""
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_scope = 'auth'

    def post(self, request):
        token = str((request.data or {}).get('token') or '')
        try:
            uid, old, new = signing.TimestampSigner(salt=SALT).unsign(token, max_age=MAX_AGE).split('|', 2)
        except signing.BadSignature:
            return Response({'ok': False, 'error': BAD_LINK}, status=400)
        try:
            with transaction.atomic():
                user = User.objects.select_for_update().get(pk=uid, email=old, is_active=True)
                if taken(new, user) or not EmailAddress.objects.filter(user=user, email=new, verified=False).exists():
                    return Response({'ok': False, 'error': BAD_LINK}, status=400)  # cancelled, replaced or taken meanwhile
                user.email = new
                user.save(update_fields=['email'])
                EmailAddress.objects.filter(user=user).exclude(email__iexact=new).delete()
                mark_verified(user)  # also accepts workspace invitations waiting for the new address
                revoke_refresh_tokens(user)
        except (User.DoesNotExist, ValueError, IntegrityError):
            return Response({'ok': False, 'error': BAD_LINK}, status=400)
        mail.send_template(old, 'email_changed', {'name': user.name or new, 'new_email': new})
        return Response({'ok': True, 'email': new})
