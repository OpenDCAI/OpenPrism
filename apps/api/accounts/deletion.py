"""Deleting your own account (DELETE /api/auth/me).

What goes: the personal workspace, every team workspace where you are the only member, and all their projects (rows,
files in storage, versions); your memberships elsewhere; your refresh tokens; your stored Zotero key (cascade). What
blocks: a team workspace where you are the only owner and other people remain, because they would be left with a
workspace nobody can administer. Make one of them an owner first."""
from django.db import transaction

from projects import files as pfiles
from projects.models import Membership, Workspace

from .passwords import revoke_refresh_tokens


def blocking_workspaces(user):
    """Team workspaces the user alone owns while others are members."""
    blocked = []
    for m in Membership.objects.filter(user=user, role=Membership.OWNER, workspace__kind=Workspace.TEAM).select_related('workspace'):
        others = m.workspace.memberships.exclude(user=user)
        if others.exists() and not others.filter(role=Membership.OWNER).exists():
            blocked.append(m.workspace)
    return blocked


def workspaces_to_delete(user):
    """The personal workspace and team workspaces with no other member."""
    return [m.workspace for m in Membership.objects.filter(user=user).select_related('workspace')
            if m.workspace.kind == Workspace.PERSONAL or not m.workspace.memberships.exclude(user=user).exists()]


def delete_account(user):
    workspaces = workspaces_to_delete(user)
    projects = [p for w in workspaces for p in w.projects.all()]
    with transaction.atomic():
        revoke_refresh_tokens(user)
        for workspace in workspaces:
            workspace.delete()  # cascades to projects, files, versions, invites
        user.delete()  # cascades to memberships and the Zotero connection
    for project in projects:  # storage last: a failure above leaves everything as it was
        pfiles.delete_project_files(project)
