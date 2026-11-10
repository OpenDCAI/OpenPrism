from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from . import cookies, mfa
from .serializers import RegisterSerializer, UserSerializer


def _tokens(user):
    refresh = RefreshToken.for_user(user)
    return {'access': str(refresh.access_token), 'refresh': str(refresh)}


class RegisterView(APIView):
    permission_classes = [AllowAny]
    throttle_scope = 'auth'

    def post(self, request):
        serializer = RegisterSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        tokens = _tokens(user)
        return cookies.with_session(Response({'ok': True, 'user': UserSerializer(user).data, **tokens},
                                             status=status.HTTP_201_CREATED), tokens)


class MeView(APIView):
    allow_unverified = True  # who am I / rename / delete account work before the address is verified
    def get(self, request):
        return Response({'ok': True, 'user': UserSerializer(request.user).data})

    def patch(self, request):
        name = str((request.data or {}).get('name') or '').strip()[:150]
        if not name:
            return Response({'ok': False, 'error': 'Enter your name.'}, status=400)
        request.user.name = name
        request.user.save(update_fields=['name'])
        return Response({'ok': True, 'user': UserSerializer(request.user).data})

    def delete(self, request):
        """Delete the signed-in account (password required). See accounts/deletion.py for what goes and what blocks."""
        from .deletion import blocking_workspaces, delete_account
        user = request.user
        if not user.check_password(str((request.data or {}).get('password') or '')):
            return Response({'ok': False, 'error': 'Your password is not correct.'}, status=400)
        blocked = blocking_workspaces(user)
        if blocked:
            return Response({'ok': False, 'workspaces': [{'id': str(w.id), 'name': w.name} for w in blocked],
                             'error': 'You are the only owner of workspaces other people use. Make one of them an owner first.'},
                            status=409)
        delete_account(user)
        return cookies.clear_refresh_cookie(Response({'ok': True}))


def _blacklist(token):
    try:
        RefreshToken(str(token)).blacklist()
    except TokenError:
        pass  # already invalid: nothing to revoke


class LogoutView(APIView):
    """Revoke the refresh token (the cookie's, or `refresh` in the body for API clients) and clear the cookie. The
    access token simply expires."""
    allow_unverified = True
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_scope = 'auth'

    def post(self, request):
        body_token = request.data.get('refresh') if isinstance(request.data, dict) else None
        if body_token:  # an API client revoking its own token: the cookie is not involved
            _blacklist(body_token)
            return Response({'ok': True})
        token = cookies.cookie_token(request)
        if token and not cookies.cookie_request_allowed(request):
            return Response({'ok': False, 'error': 'Refused.'}, status=403)
        _blacklist(token)
        return cookies.clear_refresh_cookie(Response({'ok': True}))


class LoginSerializer(TokenObtainPairSerializer):
    def validate(self, attrs):
        attrs[self.username_field] = str(attrs.get(self.username_field, '')).strip().lower()  # emails are stored lower-case
        data = super().validate(attrs)
        if mfa.enabled(self.user):  # the password is right, the second factor is still owed: no tokens yet (accounts/mfa.py)
            return {'mfaRequired': True, 'ticket': mfa.make_ticket(self.user)}
        return data


class LoginView(TokenObtainPairView):
    serializer_class = LoginSerializer
    throttle_scope = 'auth'

    def post(self, request, *args, **kwargs):
        response = super().post(request, *args, **kwargs)
        return cookies.with_session(response, dict(response.data)) if response.status_code == 200 else response


class RefreshView(TokenRefreshView):
    """New tokens for the refresh token in the cookie (browsers: needs X-OpenPrism-Refresh: 1 and a trusted Origin; the
    rotated token goes back into the cookie, the body has only `access`), or for `refresh` in the body (API clients,
    answered in the body as before; with the browser header it is an older build's stored token moving into the cookie)."""
    throttle_scope = 'refresh'

    def post(self, request, *args, **kwargs):
        token = cookies.cookie_token(request)
        body_token = request.data.get('refresh') if isinstance(request.data, dict) else None
        browser = request.META.get(cookies.HEADER) == '1'
        if body_token and not browser:
            return super().post(request, *args, **kwargs)
        if not body_token and not token:
            return Response({'ok': False, 'error': 'Not signed in.', 'code': 'no_session'}, status=401)
        if not cookies.cookie_request_allowed(request):
            return Response({'ok': False, 'error': 'Refused.'}, status=403)
        # a browser: its cookie, or a refresh token an older build left in its storage, moving into the cookie now
        serializer = self.get_serializer(data={'refresh': body_token or token})
        try:
            serializer.is_valid(raise_exception=True)
        except (TokenError, InvalidToken):
            # Expired, revoked or rotated, or "not yet valid": a token minted a moment ago is refused while the clock
            # has stepped back, so the cookie is kept and the client retries once; a dead cookie is cleared by logout.
            return Response({'ok': False, 'error': 'Sign in again.'}, status=401)
        tokens = dict(serializer.validated_data)
        return cookies.with_session(Response({'ok': True, **tokens}), tokens)
