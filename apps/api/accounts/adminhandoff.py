"""One sign-in for the app and the Django admin (v0.1.3, #94).

A superadmin signed in to the app asks `POST /api/auth/admin-handoff` for a code: random, valid 60 seconds, usable once,
only its hash is kept (in the shared cache). The app submits it as a form POST (so it is never in a URL, a log or the
history) to `/admin/handoff/`, which turns it into the admin's own session: its own cookie, lifetime and rate limit,
SameSite=Strict. The app's weaker session never *is* the admin session, and the code is only given to someone whose
access token is a superadmin's (a token exists only after the second factor, see mfa.py)."""
import hashlib
import secrets

from django.conf import settings
from django.contrib.auth import get_user_model, login
from django.core.cache import cache
from django.http import HttpResponseNotAllowed, HttpResponseRedirect
from django.views.decorators.csrf import csrf_exempt
from rest_framework.response import Response
from rest_framework.throttling import BaseThrottle
from rest_framework.views import APIView

from common import ratelimit

SECONDS = 60
User = get_user_model()


def _key(code):
    return 'admin-handoff:' + hashlib.sha256(code.encode()).hexdigest()


def allowed(user):
    """An active superadmin who has what the admin demands (a second factor when SUPERADMIN_REQUIRE_MFA)."""
    from . import mfa
    if not (user.is_active and user.is_superuser):
        return False
    return not settings.SUPERADMIN_REQUIRE_MFA or mfa.enabled(user)


def issue(user):
    code = secrets.token_urlsafe(32)
    cache.set(_key(code), str(user.pk), SECONDS)
    return code


def redeem(code):
    """The user the code was issued for, once; None for anything else."""
    code = str(code or '')[:100]
    if not code:
        return None
    key = _key(code)
    uid = cache.get(key)
    if uid is None or not cache.delete(key):  # whoever deletes it first wins: a second request finds nothing
        return None
    user = User.objects.filter(pk=uid).first()
    return user if user and allowed(user) else None


class AdminHandoffView(APIView):
    """POST: a one-time code for /admin/handoff/ (real accounts only; superadmins only)."""
    throttle_scope = 'auth'

    def post(self, request):
        user = request.user
        if not allowed(user):
            return Response({'ok': False, 'error': 'Not available.'}, status=403)
        return Response({'ok': True, 'code': issue(user), 'expiresIn': SECONDS})


@csrf_exempt  # the one-time code is the proof; there is no cookie to ride on
def handoff(request):
    if request.method != 'POST':
        return HttpResponseNotAllowed(['POST'])
    # abuse control only: codes are 256-bit, and this must not eat the login form's budget
    if ratelimit.hit('admin-handoff', BaseThrottle().get_ident(request), 6 * settings.ADMIN_LOGIN_RATE_PER_15_MIN, 15 * 60):
        return HttpResponseRedirect('/admin/login/')
    user = redeem(request.POST.get('code'))
    if user is None:
        return HttpResponseRedirect('/admin/login/')
    login(request, user, backend='django.contrib.auth.backends.ModelBackend')
    return HttpResponseRedirect('/admin/')
