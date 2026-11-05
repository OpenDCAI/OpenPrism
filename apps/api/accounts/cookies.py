"""The refresh token travels in an httpOnly cookie, never in a response body or in browser storage; the access token is
returned in the body and kept in the page's memory. API requests authenticate with `Authorization: Bearer <access>`,
so only the endpoints that read this cookie (refresh, logout) can be reached by a cross-site request, and they demand:
SameSite=Strict (browsers do not send it cross-site), a custom header (a cross-site form or fetch cannot set one
without CORS, which the API does not grant), and, when the browser sends an Origin, one of TRUSTED_ORIGINS."""
from django.conf import settings
from rest_framework_simplejwt.settings import api_settings

HEADER = 'HTTP_X_OPENPRISM_REFRESH'  # X-OpenPrism-Refresh: 1
PATH = '/api/auth'


def set_refresh_cookie(response, refresh):
    response.set_cookie(settings.REFRESH_COOKIE_NAME, str(refresh), path=PATH, httponly=True, samesite='Strict',
                        secure=settings.REFRESH_COOKIE_SECURE,
                        max_age=int(api_settings.REFRESH_TOKEN_LIFETIME.total_seconds()))
    return response


def clear_refresh_cookie(response):
    response.delete_cookie(settings.REFRESH_COOKIE_NAME, path=PATH, samesite='Strict')
    return response


def cookie_token(request):
    return request.COOKIES.get(settings.REFRESH_COOKIE_NAME, '')


def cookie_request_allowed(request):
    """The CSRF checks for a request authenticated by the cookie."""
    if request.META.get(HEADER) != '1':
        return False
    origin = request.META.get('HTTP_ORIGIN')
    return origin is None or origin.rstrip('/') in settings.TRUSTED_ORIGINS


def with_session(response, tokens):
    """Move `tokens['refresh']` from the body into the cookie; the body keeps `access`."""
    refresh = tokens.get('refresh')
    if isinstance(response.data, dict):
        response.data.pop('refresh', None)
    return set_refresh_cookie(response, refresh) if refresh else response
