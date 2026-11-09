"""Making and removing superadmins (v0.1.1, #82). Used by the management commands and by the admin's user form, so the
rule that the last superadmin cannot be removed holds on every path."""
from django.contrib.admin.models import ADDITION, CHANGE, LogEntry
from django.contrib.contenttypes.models import ContentType
from django.db import transaction
from django.utils import timezone

from .models import User

LAST_ONE = 'At least one superadmin must remain.'


class SuperadminError(Exception):
    """Something that cannot be done; the message is shown to the person who asked."""


def can_log_in_to_admin(user):
    """What the admin's login form and pages require (accounts/adminsite.py)."""
    return bool(user.is_active and user.is_superuser and user.is_staff)


def others_remain(user):
    return User.objects.filter(is_active=True, is_superuser=True, is_staff=True).exclude(pk=user.pk).exists()


def check_not_last(user, *, active, superuser, staff):
    """Raise SuperadminError if saving `user` with these flags would leave no one who can use the admin."""
    would_work = active and superuser and staff
    if can_log_in_to_admin(user) and not would_work and not others_remain(user):
        raise SuperadminError(LAST_ONE)


def _log(user, flag, message):
    # The log needs a user: the account that was changed (a command has no signed-in actor).
    LogEntry.objects.create(user=user, content_type=ContentType.objects.get_for_model(User), object_id=str(user.pk),
                            object_repr=str(user), action_flag=flag, change_message=message)


@transaction.atomic
def grant(email, password=None):
    """Make `email` a superadmin. An existing account keeps its password; a new one needs `password`. Returns (user, created)."""
    email = email.strip().lower()
    user = User.objects.filter(email=email).first()
    created = user is None
    if created:
        if not password:
            raise SuperadminError(f'No account for {email}: a password is needed to create it.')
        from projects.models import Membership, Workspace
        user = User.objects.create_user(email, password)
        workspace = Workspace.objects.create(name='Personal', kind=Workspace.PERSONAL, color='#5b6573')
        Membership.objects.create(workspace=workspace, user=user, role=Membership.OWNER)
    user.is_active = user.is_staff = user.is_superuser = True
    if user.email_verified_at is None:
        user.email_verified_at = timezone.now()
    user.save()
    _log(user, ADDITION if created else CHANGE, 'Superadmin granted by management command' + (' (account created)' if created else ''))
    return user, created


@transaction.atomic
def revoke(email):
    user = User.objects.select_for_update().filter(email=email.strip().lower()).first()
    if user is None:
        raise SuperadminError(f'No account for {email}.')
    if not user.is_superuser and not user.is_staff:
        raise SuperadminError(f'{email} is not a superadmin.')
    check_not_last(user, active=user.is_active, superuser=False, staff=False)
    user.is_staff = user.is_superuser = False
    user.save(update_fields=['is_staff', 'is_superuser'])
    _log(user, CHANGE, 'Superadmin revoked by management command')
    return user
