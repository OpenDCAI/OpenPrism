"""Accounts in the Django admin (v0.1.1, #81). Superadmins can look accounts up and switch the flags that need a human;
passwords and tokens are not shown, accounts are created by registration (or `make_superadmin`) and deleted through
`accounts/deletion.py`, which also removes the account's storage."""
from django.conf import settings
from django.contrib import admin
from django.contrib.admin.models import LogEntry
from django.template.response import TemplateResponse
from django.urls import path
from django import forms
from django.contrib.auth.models import Group
from django.utils import timezone
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken

from common.admin import ReadOnlyAdmin

from allauth.account.models import EmailAddress
from allauth.mfa.models import Authenticator

from . import invitations, superadmins
from .models import PlatformInvite, User

admin.site.unregister(Group)  # permissions and groups mean nothing here: only superusers use the admin
# simplejwt registers these itself. OutstandingToken holds whole refresh tokens, which are credentials: never list them.
admin.site.unregister(OutstandingToken)
admin.site.unregister(BlacklistedToken)
# allauth registers these itself. Authenticator holds second-factor secrets; EmailAddress is kept in step by accounts/emails.py.
admin.site.unregister(Authenticator)
admin.site.unregister(EmailAddress)


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
        count = 0
        for user in queryset.filter(email_verified_at__isnull=True):
            user.email_verified_at = timezone.now()
            user.save(update_fields=['email_verified_at'])  # the save also updates the allauth address row
            count += 1
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


MAX_PER_SUBMISSION = 200


def parse_addresses(text):
    """Addresses separated by new lines, commas, semicolons or spaces (a pasted CSV column works); an `email` header and
    surrounding quotes are ignored; each address once, in order."""
    import re
    seen, out = set(), []
    for part in re.split(r'[\s,;]+', text or ''):
        part = part.strip().strip('"\'<>').lower()
        if part and part != 'email' and part not in seen:
            seen.add(part)
            out.append(part)
    return out


class InviteForm(forms.Form):
    emails = forms.CharField(label='Email addresses', widget=forms.Textarea(attrs={'rows': 8, 'cols': 60}),
                             help_text='One per line, or separated by commas; a pasted CSV column works. Up to %d.' % MAX_PER_SUBMISSION)
    workspace = forms.ModelChoiceField(required=False, queryset=None, label='Workspace (optional)',
                                       help_text='The new account joins it when they register.')
    role = forms.ChoiceField(required=False, choices=[], help_text='Role in that workspace.')

    def __init__(self, *args, **kwargs):
        from projects.models import Membership, Workspace
        super().__init__(*args, **kwargs)
        self.fields['workspace'].queryset = Workspace.objects.filter(kind=Workspace.TEAM).order_by('name')
        self.fields['role'].choices = [(r, l) for r, l in Membership.ROLES if r in Membership.ASSIGNABLE]
        self.fields['role'].initial = Membership.EDITOR

    def clean_emails(self):
        addresses = parse_addresses(self.cleaned_data['emails'])
        if not addresses:
            raise forms.ValidationError('Enter at least one email address.')
        if len(addresses) > MAX_PER_SUBMISSION:
            raise forms.ValidationError(f'At most {MAX_PER_SUBMISSION} addresses at a time.')
        return addresses


@admin.register(PlatformInvite)
class PlatformInviteAdmin(ReadOnlyAdmin):
    """Superadmins invite people to register (v0.1.2, #85). The token and its hash are never shown; invitations are
    revoked, not deleted, so the history stays."""
    change_list_template = 'admin/accounts/platforminvite/change_list.html'
    list_display = ('email', 'state', 'invited_by', 'workspace', 'role', 'created_at', 'expires_at', 'last_sent_at')
    list_filter = ('workspace',)
    search_fields = ('email', 'invited_by__email')
    fields = ('email', 'state', 'invited_by', 'workspace', 'role', 'created_at', 'expires_at', 'last_sent_at', 'send_failed',
              'revoked_at', 'used_at', 'user')
    readonly_fields = ('state',)
    ordering = ('-created_at',)
    list_select_related = ('invited_by', 'workspace')
    actions = ['resend', 'revoke']

    @admin.display(description='Status')
    def state(self, obj):
        return {'sent': 'Sent', 'mail_failed': 'Mail failed', 'used': 'Used', 'expired': 'Expired',
                'revoked': 'Revoked'}[invitations.status(obj)]

    def get_urls(self):
        return [path('invite/', self.admin_site.admin_view(self.invite_view), name='accounts_platforminvite_invite'),
                *super().get_urls()]

    def invite_view(self, request):
        form = InviteForm(request.POST or None)
        results = None
        if request.method == 'POST' and form.is_valid():
            workspace, role = form.cleaned_data['workspace'], form.cleaned_data['role']
            results = []
            for email in form.cleaned_data['emails']:
                try:
                    invite, _ = invitations.create(email, request.user, workspace=workspace, role=role or None)
                except invitations.InviteError as e:
                    results.append((email, str(e), False))
                    continue
                self.log_addition(request, invite, f'Invited {email}' + (f' to {workspace.name} as {invite.role}' if workspace else ''))
                results.append((email, 'Invited', True))
        context = {**self.admin_site.each_context(request), 'title': 'Invite people', 'form': form, 'results': results,
                   'days': settings.PLATFORM_INVITE_DAYS, 'opts': self.model._meta, 'allow_workspace': True}
        return TemplateResponse(request, 'admin/accounts/platforminvite/invite.html', context)

    @admin.action(description='Send again (the earlier link stops working)')
    def resend(self, request, queryset):
        done = 0
        for invite in queryset:
            try:
                invitations.resend(invite)
            except invitations.InviteError as e:
                self.message_user(request, str(e), level='warning')
                continue
            self.log_change(request, invite, 'Invitation sent again')
            done += 1
        self.message_user(request, f'{done} invitation(s) sent again.')

    @admin.action(description='Revoke (the link stops working)')
    def revoke(self, request, queryset):
        done = 0
        for invite in queryset:
            try:
                invitations.revoke(invite)
            except invitations.InviteError as e:
                self.message_user(request, str(e), level='warning')
                continue
            self.log_change(request, invite, 'Invitation revoked')
            done += 1
        self.message_user(request, f'{done} invitation(s) revoked.')
