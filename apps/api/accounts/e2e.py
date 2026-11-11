"""A throwaway superuser for the browser suite (#106), so it can run against a stack the runner has no Docker access to.

Off unless BOTH hold: the server runs in debug mode (never true in Kubernetes) and `E2E_SUPERUSER_TOKEN` is set, and then
only a request that carries that token gets anything. Everywhere else the route answers 404, as if it did not exist.
"""
import hmac

from django.conf import settings
from django.http import Http404
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from projects.models import Membership, Workspace

from .models import User


def enabled():
    return bool(settings.E2E_SUPERUSER_TOKEN) and (settings.DEBUG or settings.TESTING)


class E2ESuperuserView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        sent = request.headers.get('X-E2E-Token', '')
        if not enabled() or not hmac.compare_digest(sent.encode(), settings.E2E_SUPERUSER_TOKEN.encode()):
            raise Http404
        b = request.data if isinstance(request.data, dict) else {}
        email, password = str(b.get('email') or '').strip().lower(), str(b.get('password') or '')
        if not email or not password or User.objects.filter(email=email).exists():
            return Response({'ok': False, 'error': 'An unused email and a password are needed.'}, status=400)
        user = User.objects.create_user(email, password, is_staff=True, is_superuser=bool(b.get('superuser', True)))
        # a personal workspace, so the account can also use the app
        Membership.objects.create(workspace=Workspace.objects.create(name='Personal', kind=Workspace.PERSONAL, color='#5b6573'),
                                  user=user, role=Membership.OWNER)
        return Response({'ok': True, 'email': email})
