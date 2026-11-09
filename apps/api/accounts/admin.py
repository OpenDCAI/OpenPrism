"""Accounts in the Django admin (v0.1.1, #81). Superadmins can look accounts up and switch the flags that need a human;
passwords and tokens are not shown, accounts are created by registration (or `make_superadmin`) and deleted through
`accounts/deletion.py`, which also removes the account's storage."""
from django.contrib import admin
from django.contrib.admin.models import LogEntry
from django import forms
from django.contrib.auth.models import Group
from django.utils import timezone
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken

from common.admin import ReadOnlyAdmin

from . import superadmins
from .models import User

admin.site.unregister(Group)  # permissions and groups mean nothing here: only superusers use the admin
# simplejwt registers these itself. OutstandingToken holds whole refresh tokens, which are credentials: never list them.
admin.site.unregister(OutstandingToken)
admin.site.unregister(BlacklistedToken)


class UserForm(forms.ModelForm):
    class Meta:
        model = User
        fields = ('name', 'is_active', 'is_staff', 'is_superuser')

    def clean(self):
        data = super().clean()
        if self.instance.pk and not self.errors:
            try:
                u = self.instance  # a flag the form does not carry (read-only for this viewer) keeps its value
                superadmins.check_not_last(u, active=data.get('is_active', u.is_active),
                                           superuser=data.get('is_superuser', u.is_superuser),
                                           staff=data.get('is_staff', u.is_staff))
            except superadmins.SuperadminError as e:
                raise forms.ValidationError(str(e))
        return data


@admin.register(User)
class UserAdmin(admin.ModelAdmin):
    form = UserForm
    list_display = ('email', 'name', 'is_active', 'is_staff', 'is_superuser', 'verified', 'created_at')
    list_filter = ('is_active', 'is_staff', 'is_superuser')
    search_fields = ('email', 'name')
    ordering = ('-created_at',)
    fields = ('email', 'name', 'is_active', 'is_staff', 'is_superuser', 'email_verified_at', 'created_at', 'id')
    readonly_fields = ('email', 'email_verified_at', 'created_at', 'id')  # the address is the login: it is not edited here
    actions = ['mark_email_verified']
    list_per_page = 50

    def get_readonly_fields(self, request, obj=None):
        # Only a superuser changes who is staff or superuser (every admin user is one, but do not rely on that).
        extra = () if request.user.is_superuser else ('is_staff', 'is_superuser')
        return (*super().get_readonly_fields(request, obj), *extra)

    @admin.display(boolean=True, description='Email verified', ordering='email_verified_at')
    def verified(self, obj):
        return obj.email_verified_at is not None

    def has_add_permission(self, request):
        return False  # people register themselves

    def has_delete_permission(self, request, obj=None):
        return False  # deleting an account has storage to clean up: accounts/deletion.py

    @admin.action(description='Mark the selected accounts\' email addresses as verified')
    def mark_email_verified(self, request, queryset):
        count = queryset.filter(email_verified_at__isnull=True).update(email_verified_at=timezone.now())
        self.message_user(request, f'{count} account(s) marked verified.')


@admin.register(LogEntry)
class LogEntryAdmin(ReadOnlyAdmin):
    """What superadmins changed in this admin."""
    list_display = ('action_time', 'user', 'content_type', 'object_repr', 'action_flag', 'change_message')
    list_filter = ('action_flag', 'content_type')
    search_fields = ('object_repr', 'change_message', 'user__email')
    fields = ('action_time', 'user', 'content_type', 'object_id', 'object_repr', 'action_flag', 'change_message')
    date_hierarchy = 'action_time'
    list_select_related = ('user', 'content_type')
