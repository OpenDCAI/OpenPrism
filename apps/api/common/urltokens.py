"""Short-lived, narrowly scoped credentials for URLs (`?token=`), for what cannot send an Authorization header:
<img>/<object> (project files, PDFs), EventSource (arXiv import) and the collaboration websocket.

A token is `ut1.` + a signed, timestamped payload naming its principal (an account or an invite-link guest), its scope
(`project` with a project id, or `import`) and nothing else; it lives URL_TOKEN_SECONDS. The principal is re-checked on
every use, so removing someone from a workspace or revoking their invite link takes effect at once."""
from dataclasses import dataclass

from django.conf import settings
from django.core import signing
from django.utils import timezone
from datetime import timedelta

PREFIX = 'ut1.'
SALT = 'openprism.url-token'
PROJECT, IMPORT = 'project', 'import'


class InvalidUrlToken(Exception):
    pass


@dataclass(frozen=True)
class UrlClaims:
    """What a URL token allows (DRF puts it in request.auth)."""
    scope: str
    project_id: str | None


def mint(principal, scope, project_id=None):
    """(token, expires_at) for an account (User) or a guest (collab.auth.GuestUser)."""
    if scope not in (PROJECT, IMPORT) or (scope == PROJECT) != bool(project_id):
        raise ValueError('bad scope')
    who = {'g': principal.invite_id} if getattr(principal, 'is_guest', False) else {'u': str(principal.id)}
    token = PREFIX + signing.dumps({**who, 's': scope, 'p': str(project_id) if project_id else None}, salt=SALT, compress=False)
    return token, timezone.now() + timedelta(seconds=settings.URL_TOKEN_SECONDS)


def verify(token):
    """(principal, UrlClaims) for a valid, unexpired token whose principal still exists; else InvalidUrlToken."""
    from collab.auth import GuestUser
    from collab.models import CollabInvite
    from django.contrib.auth import get_user_model
    if not isinstance(token, str) or not token.startswith(PREFIX):
        raise InvalidUrlToken('Not a URL token.')
    try:
        data = signing.loads(token[len(PREFIX):], salt=SALT, max_age=settings.URL_TOKEN_SECONDS)
    except signing.SignatureExpired:
        raise InvalidUrlToken('This link has expired.') from None
    except signing.BadSignature:
        raise InvalidUrlToken('Invalid URL token.') from None
    claims = UrlClaims(data.get('s'), data.get('p'))
    if data.get('g'):
        invite = CollabInvite.objects.filter(pk=data['g'], expires_at__gt=timezone.now()).first()
        if invite is None or (claims.project_id and str(invite.project_id) != claims.project_id):
            raise InvalidUrlToken('The invite link was revoked or has expired.')
        return GuestUser(invite), claims
    user = get_user_model().objects.filter(pk=data.get('u'), is_active=True).first()
    if user is None:
        raise InvalidUrlToken('Invalid URL token.')
    return user, claims


def claims_of(request):
    auth = getattr(request, 'auth', None)
    return auth if isinstance(auth, UrlClaims) else None


def allows_project(request, project_id):
    """False when the request came with a URL token that is not for this project (a header credential is not limited)."""
    claims = claims_of(request)
    return claims is None or (claims.scope == PROJECT and claims.project_id == str(project_id))
