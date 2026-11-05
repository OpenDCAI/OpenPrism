"""Project-scoped guests: people who joined through an invite link and have no account."""
from rest_framework.authentication import BaseAuthentication, get_authorization_header
from rest_framework.exceptions import AuthenticationFailed
from rest_framework.permissions import BasePermission

from . import tokens


class GuestUser:
    """Stands in for request.user for invite-token requests. It can only ever touch `project_id`."""
    is_authenticated = True
    is_guest = True
    is_staff = False
    id = None

    def __init__(self, invite):
        self.project_id = str(invite.project_id)
        self.role = invite.role
        self.invite_id = str(invite.id)  # a guest's identity for "my comments"

    @property
    def can_write(self):
        return self.role in ('editor', 'admin')


class InviteAuthentication(BaseAuthentication):
    """`Authorization: Bearer op2.…`. Other bearer tokens fall through to JWT."""
    keyword = b'bearer'

    def authenticate(self, request):
        header = get_authorization_header(request).split()
        if len(header) != 2 or header[0].lower() != self.keyword or not header[1].startswith(tokens.PREFIX.encode()):
            return None
        invite = tokens.lookup(header[1].decode())
        if invite is None:
            raise AuthenticationFailed('Invalid or expired invite.')
        return GuestUser(invite), invite

    def authenticate_header(self, request):
        return 'Bearer'  # makes DRF answer 401 (not 403) when an invite token is rejected


def is_guest(user):
    return getattr(user, 'is_guest', False)


def verified_enough(request, view):
    """With REQUIRE_EMAIL_VERIFICATION, an account that has not verified its address reaches only views marked
    `allow_unverified` (who am I, verify, resend, sign out, change password, delete account). Guests are unaffected."""
    from django.conf import settings
    from rest_framework.exceptions import PermissionDenied
    user = request.user
    if not settings.REQUIRE_EMAIL_VERIFICATION or is_guest(user) or getattr(user, 'email_verified_at', None):
        return True
    if getattr(view, 'allow_unverified', False):
        return True
    raise PermissionDenied('Verify your email address first: open the link we sent you.')


class IsRealUser(BasePermission):
    """Default: signed-in accounts only. Guests are refused everywhere that has not opted in."""

    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and not is_guest(request.user)) and verified_enough(request, view)


class IsUserOrGuest(BasePermission):
    """For project-scoped views. Whether a guest may touch *this* project, and write, is decided in get_project()."""

    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated) and verified_enough(request, view)
