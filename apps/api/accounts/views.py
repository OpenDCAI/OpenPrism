from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

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
        return Response(
            {'ok': True, 'user': UserSerializer(user).data, **_tokens(user)},
            status=status.HTTP_201_CREATED,
        )


class MeView(APIView):
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
        return Response({'ok': True})


class LogoutView(APIView):
    """Revoke a refresh token (the access token simply expires)."""
    permission_classes = [AllowAny]
    throttle_scope = 'auth'

    def post(self, request):
        try:
            RefreshToken((request.data or {}).get('refresh', '')).blacklist()
        except TokenError:
            pass  # already invalid: nothing to revoke
        return Response({'ok': True})


class LoginSerializer(TokenObtainPairSerializer):
    def validate(self, attrs):
        attrs[self.username_field] = str(attrs.get(self.username_field, '')).strip().lower()  # emails are stored lower-case
        return super().validate(attrs)


class LoginView(TokenObtainPairView):
    serializer_class = LoginSerializer
    throttle_scope = 'auth'


class RefreshView(TokenRefreshView):
    throttle_scope = 'auth'
