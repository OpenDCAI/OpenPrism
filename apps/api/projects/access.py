from django.core.exceptions import ValidationError
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework_simplejwt.authentication import JWTAuthentication

from .models import Membership, Project


def get_project(request, project_id, write=False):
    """Return the project if the user belongs to its workspace (with a write role when write=True)."""
    from common.urltokens import allows_project
    try:
        project = Project.objects.select_related('workspace').get(pk=project_id)
    except (Project.DoesNotExist, ValidationError):  # unknown or malformed id -> same 404
        raise NotFound('Project not found')
    if not allows_project(request, project.id):  # a URL token opens its one project only
        raise NotFound('Project not found')
    user = request.user
    if getattr(user, 'is_guest', False):  # invite-link guest: exactly one project, role from the invite
        if str(project.id) != user.project_id:
            raise NotFound('Project not found')
        if write and not user.can_write:
            raise PermissionDenied('You have read-only access to this project.')
        return project
    membership = Membership.objects.filter(workspace=project.workspace, user=user).first()
    if membership is None:
        raise NotFound('Project not found')  # do not reveal existence
    if write and membership.role not in Membership.WRITE_ROLES:
        raise PermissionDenied('You have read-only access to this project.')
    return project


def user_projects(user):
    return Project.objects.filter(workspace__memberships__user=user)


class UrlTokenAuthentication(JWTAuthentication):
    """The usual header credentials (invite token, then JWT), or a scoped URL token (common.urltokens) in `?token=`.

    Only for endpoints loaded by <img>/<object>/EventSource, which cannot set headers. `?token=` accepts nothing else:
    an account's access token or an invite token in a URL is refused (401). request.auth is then the token's UrlClaims,
    which get_project()/allows_project() hold to its one project."""
    def authenticate(self, request):
        from rest_framework.exceptions import AuthenticationFailed
        from collab.auth import InviteAuthentication
        from common import urltokens
        result = InviteAuthentication().authenticate(request) or super().authenticate(request)
        if result is not None:
            return result
        token = request.query_params.get('token')
        if not token:
            return None
        try:
            return urltokens.verify(token)
        except urltokens.InvalidUrlToken as exc:
            raise AuthenticationFailed(str(exc))
