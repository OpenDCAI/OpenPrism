"""HTTP side of social sign-in (v0.1.4, #98). The browser is sent through these by top-level navigation, so the answers
are redirects (never JSON) and errors are short codes in the query string that the sign-in page turns into a message."""
from django.conf import settings
from django.http import HttpResponseRedirect
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import BaseThrottle
from rest_framework.views import APIView

from common import ratelimit

from . import cookies, methods, mfa, social
from .models import LinkedIdentity

ERRORS = ('denied', 'expired', 'failed', 'not_invited', 'verify_first', 'no_email', 'linked_elsewhere', 'unavailable')


def to_login(code):
    return HttpResponseRedirect(f'/login?error={code if code in ERRORS else "failed"}')


class StartView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request, name):
        if ratelimit.hit('social-start', BaseThrottle().get_ident(request), 30):
            return to_login('failed')
        try:
            url = social.start_url(name, request.query_params.get('intent', 'login'), request.query_params.get('ticket', ''),
                                   request.query_params.get('next', '/'))
        except social.SocialError as e:
            return to_login(e.code)
        return HttpResponseRedirect(url)


class CallbackView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request, name):
        if ratelimit.hit('social-callback', BaseThrottle().get_ident(request), 60):
            return to_login('failed')
        try:
            user, state = social.callback(name, request.query_params)
        except social.SocialError as e:
            return to_login(e.code)
        if state['intent'] == 'link':
            return HttpResponseRedirect(f'/account?linked={name}')
        ticket = social.second_step(user)
        if ticket:   # the same second step as a password: nothing is issued before the code
            return HttpResponseRedirect(f"/login?mfa={ticket}&next={state['next']}")
        from .views import _tokens
        tokens = _tokens(user)
        return cookies.set_refresh_cookie(HttpResponseRedirect(state['next']), tokens['refresh'])


class LinkTicketView(APIView):
    """POST {password}: a one-time ticket so the browser can start linking `name` by navigation."""
    allow_unverified = True
    throttle_scope = 'auth'

    def post(self, request, name):
        user = request.user
        if name not in settings.SOCIAL_PROVIDERS:
            return Response({'ok': False, 'error': 'That sign-in is not available.'}, status=404)
        if user.has_usable_password():
            try:
                mfa.require_password(user, (request.data or {}).get('password'))
            except mfa.MfaError as e:
                return mfa.fail(e)
        return Response({'ok': True, 'ticket': social.make_link_ticket(user)})


def describe(identity):
    return {'id': str(identity.pk), 'provider': identity.provider, 'email': identity.email, 'createdAt': identity.created_at,
            'lastLoginAt': identity.last_login_at}


class IdentitiesView(APIView):
    allow_unverified = True

    def get(self, request):
        linked = {i.provider: describe(i) for i in request.user.identities.all()}
        return Response({'ok': True, 'providers': [{'name': n, 'label': label, 'linked': linked.get(n)} for n, label in social.enabled().items()]})


class IdentityView(APIView):
    allow_unverified = True
    throttle_scope = 'auth'

    def delete(self, request, pk):
        """Unlink (password needed unless the account has none). Refused when it is the last way to sign in."""
        user = request.user
        if user.has_usable_password():
            try:
                mfa.require_password(user, (request.data or {}).get('password'))
            except mfa.MfaError as e:
                return mfa.fail(e)
        try:
            identity = LinkedIdentity.objects.filter(user=user, pk=pk).first()
        except (ValueError, TypeError):
            identity = None
        if identity is None:
            return Response({'ok': False, 'error': 'Not found.'}, status=404)
        if not methods.others_remain(user, identity=identity):
            return Response({'ok': False, 'error': methods.LAST_METHOD}, status=400)
        identity.delete()
        return mfa.fresh_session(user, {})
