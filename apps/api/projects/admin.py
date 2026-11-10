"""Workspaces, memberships, invitations and projects in the Django admin (v0.1.1, #81): look only. File contents
(`ProjectFile`, uploads) are not registered, and nothing here can delete a workspace or project, which would skip
`files.delete_project_files` and leave their storage behind."""
from django.contrib import admin

from common.admin import ReadOnlyAdmin

from .models import Membership, Project, Workspace, WorkspaceInvite


@admin.register(Workspace)
class WorkspaceAdmin(ReadOnlyAdmin):
    list_display = ('name', 'kind', 'version_retention_days', 'created_at')
    list_filter = ('kind',)
    search_fields = ('name', 'memberships__user__email')
    fields = ('id', 'name', 'kind', 'color', 'version_retention_days', 'created_at')


@admin.register(Membership)
class MembershipAdmin(ReadOnlyAdmin):
    list_display = ('workspace', 'user', 'role')
    list_filter = ('role',)
    search_fields = ('user__email', 'workspace__name')
    fields = ('workspace', 'user', 'role')
    list_select_related = ('workspace', 'user')


@admin.register(WorkspaceInvite)
class WorkspaceInviteAdmin(ReadOnlyAdmin):
    list_display = ('email', 'workspace', 'role', 'invited_by', 'created_at', 'last_sent_at', 'send_failed')
    list_filter = ('role', 'send_failed')
    search_fields = ('email', 'workspace__name')
    fields = ('email', 'workspace', 'role', 'invited_by', 'created_at', 'last_sent_at', 'send_failed')
    list_select_related = ('workspace', 'invited_by')


@admin.register(Project)
class ProjectAdmin(ReadOnlyAdmin):
    list_display = ('name', 'workspace', 'created_by', 'archived', 'trashed', 'updated_at')
    list_filter = ('archived', 'trashed')
    search_fields = ('name', 'workspace__name', 'created_by__email')
    fields = ('id', 'name', 'workspace', 'created_by', 'archived', 'trashed', 'trashed_at', 'created_at', 'updated_at')
    list_select_related = ('workspace', 'created_by')
