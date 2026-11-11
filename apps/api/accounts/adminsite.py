"""The Django admin for superadmins only (v0.1.1, #80).

Django lets any `is_staff` account in. Here only active superusers may, both to log in and for every admin page, so
handing someone `is_staff` (or per-model permissions) never opens the back end. The login form is rate limited per
client address: it is the one password prompt on the internet that is not behind the app's own throttle."""
from django import forms
from django.conf import settings
from django.contrib.admin import AdminSite
from django.contrib.admin.forms import AdminAuthenticationForm
from django.contrib.auth.forms import PasswordChangeForm
from django.contrib.auth.views import PasswordChangeView
from django.urls import reverse
from django.http import HttpResponse
from rest_framework.throttling import BaseThrottle

from common import ratelimit


NEEDS_MFA = 'Turn on two-factor authentication in the app (Account settings), then sign in here.'


class SuperuserAuthenticationForm(AdminAuthenticationForm):
    code = forms.CharField(label='Authentication code', required=False, max_length=20,
                           widget=forms.TextInput(attrs={'autocomplete': 'one-time-code', 'inputmode': 'numeric'}))

    def confirm_login_allowed(self, user):
        super().confirm_login_allowed(user)  # active, and staff
        if not user.is_superuser:
            # The same message as a wrong password: do not say that the address belongs to an account.
            raise self.get_invalid_login_error()
        # The second factor (v0.1.3, #93): asked whenever the account has one, so the admin cannot be used to get around
        # it; and with SUPERADMIN_REQUIRE_MFA a superadmin without one cannot sign in at all.
        from . import mfa
        if mfa.enabled(user):
            try:
                ok = mfa.check_code(user, self.cleaned_data.get('code'))
            except mfa.MfaError as e:
                raise forms.ValidationError(e.message, code='locked') from None
            if not ok:
                raise forms.ValidationError('Enter the code from your authenticator app, or a recovery code.', code='code')
        elif settings.SUPERADMIN_REQUIRE_MFA:
            raise forms.ValidationError(NEEDS_MFA, code='needs_mfa')


class SuperuserPasswordChangeForm(PasswordChangeForm):
    """The admin's own *Change password* page must do what the app's does (#103): revoke every refresh token of the
    account (Django already ends their other admin sessions, since the session hash follows the password) and mail the
    notice."""

    def save(self, commit=True):
        user = super().save(commit)
        if commit:
            from . import passwords
            passwords.password_changed(user)
        return user


class SuperuserAdminSite(AdminSite):
    login_form = SuperuserAuthenticationForm

    def password_change(self, request, extra_context=None):
        defaults = {
            'form_class': SuperuserPasswordChangeForm,
            'success_url': reverse('admin:password_change_done', current_app=self.name),
            'extra_context': {**self.each_context(request), **(extra_context or {})},
        }
        if self.password_change_template is not None:
            defaults['template_name'] = self.password_change_template
        request.current_app = self.name
        return PasswordChangeView.as_view(**defaults)(request)

    def has_permission(self, request):
        user = request.user
        if not (user.is_active and user.is_superuser):
            return False
        if settings.SUPERADMIN_REQUIRE_MFA:  # also ends sessions that predate the setting or a reset
            from . import mfa
            return mfa.enabled(user)
        return True

    def login(self, request, extra_context=None):
        if request.method == 'POST':
            wait = ratelimit.hit('admin-login', BaseThrottle().get_ident(request),
                                 settings.ADMIN_LOGIN_RATE_PER_15_MIN, 15 * 60)
            if wait:
                return HttpResponse('Too many login attempts. Try again later.', status=429, content_type='text/plain',
                                    headers={'Retry-After': str(wait)})
        return super().login(request, extra_context)
