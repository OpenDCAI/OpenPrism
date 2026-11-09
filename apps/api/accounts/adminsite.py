"""The Django admin for superadmins only (v0.1.1, #80).

Django lets any `is_staff` account in. Here only active superusers may, both to log in and for every admin page, so
handing someone `is_staff` (or per-model permissions) never opens the back end. The login form is rate limited per
client address: it is the one password prompt on the internet that is not behind the app's own throttle."""
from django.conf import settings
from django.contrib.admin import AdminSite
from django.contrib.admin.forms import AdminAuthenticationForm
from django.http import HttpResponse
from rest_framework.throttling import BaseThrottle

from common import ratelimit


class SuperuserAuthenticationForm(AdminAuthenticationForm):
    def confirm_login_allowed(self, user):
        super().confirm_login_allowed(user)  # active, and staff
        if not user.is_superuser:
            # The same message as a wrong password: do not say that the address belongs to an account.
            raise self.get_invalid_login_error()


class SuperuserAdminSite(AdminSite):
    login_form = SuperuserAuthenticationForm

    def has_permission(self, request):
        user = request.user
        return bool(user.is_active and user.is_superuser)

    def login(self, request, extra_context=None):
        if request.method == 'POST':
            wait = ratelimit.hit('admin-login', BaseThrottle().get_ident(request),
                                 settings.ADMIN_LOGIN_RATE_PER_15_MIN, 15 * 60)
            if wait:
                return HttpResponse('Too many login attempts. Try again later.', status=429, content_type='text/plain',
                                    headers={'Retry-After': str(wait)})
        return super().login(request, extra_context)
