"""Invite links in the Django admin (v0.1.1, #81): who made which link and when it expires. The token's hash is never
shown, and `CollabDoc` (the Yjs state of open files) is not registered."""
from django.contrib import admin

from common.admin import ReadOnlyAdmin

from .models import CollabInvite


@admin.register(CollabInvite)
class CollabInviteAdmin(ReadOnlyAdmin):
    list_display = ('id', 'project', 'role', 'created_by', 'created_at', 'expires_at')
    list_filter = ('role',)
    search_fields = ('project__name', 'created_by__email')
    fields = ('id', 'project', 'role', 'created_by', 'created_at', 'expires_at')
    list_select_related = ('project', 'created_by')
