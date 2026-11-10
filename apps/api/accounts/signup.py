"""The one gate every sign-up goes through (v0.1.2, #84). `REGISTRATION_MODE=open` lets anyone register; `invite` needs a
platform invitation (accounts/invitations.py) or, unless WORKSPACE_INVITES_ALLOW_SIGNUP is off, a workspace invitation
for the address. The registration serializer calls it today and the allauth adapters' `is_open_for_signup` must call it
too (backlog B), so no new way to sign up can skip the invitation. Every way of being refused gives the same message:
it never says whether an address is invited, has an account, or whether a token is merely expired."""
from django.conf import settings
from rest_framework.exceptions import Throttled

from common import ratelimit

from . import invitations

REFUSED = 'This invitation is not valid or has expired. Ask for a new one.'
ATTEMPTS_PER_15_MIN = 10  # per address and per token


class SignupRefused(Exception):
    """The message is safe to show to anyone."""


def _limit(email, raw_token):
    for scope, ident in (('signup-email', email), ('signup-token', invitations.hash_token(raw_token) if raw_token else None)):
        if ident:
            wait = ratelimit.hit(scope, ident, ATTEMPTS_PER_15_MIN, window_seconds=900)
            if wait:
                raise Throttled(wait=wait, detail='Too many attempts: try again later.')


def check_signup(email, invite_token=None, address_verified=False):
    """Return the PlatformInvite that admits `email` (or None when the mode or a workspace invitation admits it); raise
    SignupRefused otherwise. `address_verified`: the caller has proof the person owns `email` (a social provider's verified
    email), so a live platform invitation for it counts without its token. Does not lock: registration re-checks inside its transaction (`invitations.claim`)."""
    email = str(email or '').strip().lower()
    if settings.REGISTRATION_MODE == 'open':
        # Anyone may register, but a valid invitation link still counts: it verifies the address and joins the workspace.
        if invite_token:
            return invitations.find_valid(email, invite_token)
        return invitations.find_for_address(email) if address_verified else None
    _limit(email, invite_token)
    invite = invitations.find_valid(email, invite_token) or (invitations.find_for_address(email) if address_verified else None)
    if invite is not None:
        return invite
    if settings.WORKSPACE_INVITES_ALLOW_SIGNUP:
        from projects.models import WorkspaceInvite
        if WorkspaceInvite.objects.filter(email=email).exists():
            return None
    raise SignupRefused(REFUSED)
