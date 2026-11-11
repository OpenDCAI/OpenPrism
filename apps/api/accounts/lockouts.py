"""What a superadmin can undo for someone who is locked out or locked out of trying (#110).

Everything here is a counter in the shared cache, keyed by the account: wrong second-factor codes, enrolment attempts,
passkey sign-in attempts and email-change requests. Nothing is ever shown or set about a password.
"""
from django.core.cache import cache

from common import ratelimit

COUNTERS = (('mfa-wrong', 900), ('mfa-enable', 900), ('passkey-login', 900), ('email-change', 3600))


def clear(user):
    """Lift the account's sign-in lockouts and attempt counters."""
    cache.delete(f'mfa-locked:{user.pk}')
    for scope, window in COUNTERS:
        ratelimit.reset(scope, user.pk, window)


def send_password_reset(user, actor):
    """Mail the account a reset link and sign it out everywhere (the admin does not know the password and never sets
    one). Returns False for an inactive account, whose reset the public flow would not send either."""
    from django.contrib.admin.models import CHANGE, LogEntry
    from django.contrib.contenttypes.models import ContentType
    from . import passwords
    if not user.is_active:
        return False
    passwords.revoke_refresh_tokens(user)
    passwords.send_reset_mail(user)
    LogEntry.objects.create(user=actor, content_type=ContentType.objects.get_for_model(user), object_id=str(user.pk),
                            object_repr=str(user), action_flag=CHANGE, change_message='Password reset link sent.')
    return True
