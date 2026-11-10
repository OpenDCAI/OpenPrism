"""Recent sign-ins (v0.1.4, #100): every successful sign-in is recorded for the account's own list, with the address cut
to its network (IPv4 /24, IPv6 /48) so it shows where from without being a tracking log."""
import ipaddress
from datetime import timedelta

from django.conf import settings
from django.utils import timezone
from rest_framework.response import Response
from rest_framework.throttling import BaseThrottle
from rest_framework.views import APIView

from .models import SignInEvent


def network_of(address):
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return ''
    prefix = 24 if ip.version == 4 else 48
    return str(ipaddress.ip_network(f'{ip}/{prefix}', strict=False))


def record(user, method, request):
    """Never lets a failure here stop a sign-in."""
    if user is None:
        return
    try:
        SignInEvent.objects.create(user=user, method=method, network=network_of(BaseThrottle().get_ident(request)),
                                   user_agent=str(request.META.get('HTTP_USER_AGENT', ''))[:200])
    except Exception:  # noqa: BLE001
        pass


def prune():
    cutoff = timezone.now() - timedelta(days=settings.SIGNIN_KEEP_DAYS)
    return SignInEvent.objects.filter(created_at__lt=cutoff).delete()[0]


class SignInsView(APIView):
    """GET: the signed-in account's newest 20 sign-ins. Nobody else's."""
    allow_unverified = True

    def get(self, request):
        rows = request.user.sign_ins.order_by('-created_at')[:20]
        return Response({'ok': True, 'signIns': [{'method': r.method, 'at': r.created_at, 'network': r.network, 'userAgent': r.user_agent} for r in rows]})
