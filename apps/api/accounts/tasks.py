import logging
import smtplib
import socket

from celery import shared_task

from . import mail

log = logging.getLogger(__name__)


def _record(invite_id, failed, platform_invite_id=None):
    """Remember on an invitation whether its mail went out (the Members list and the admin show "email not sent")."""
    if invite_id:
        from projects.models import WorkspaceInvite
        WorkspaceInvite.objects.filter(pk=invite_id).update(send_failed=failed)
    if platform_invite_id:
        from .models import PlatformInvite
        PlatformInvite.objects.filter(pk=platform_invite_id).update(send_failed=failed)


@shared_task(name='accounts.tasks.send_email', bind=True, max_retries=5, ignore_result=True)
def send_email(self, to, template, context, invite_id=None, platform_invite_id=None):
    """Send one templated mail, retrying with backoff (30 s, 1, 2, 4, 8 min) if the mail server is unavailable."""
    try:
        mail.deliver(to, template, context)
    except (smtplib.SMTPException, OSError, socket.timeout) as exc:
        # Log the failure, never the body: it may contain a password-reset or verification link.
        log.warning('mail %s to %s failed (attempt %s): %s', template, to, self.request.retries + 1, exc.__class__.__name__)
        if self.request.retries >= self.max_retries:
            _record(invite_id, True, platform_invite_id)
            raise
        raise self.retry(exc=exc, countdown=30 * (2 ** self.request.retries))
    _record(invite_id, False, platform_invite_id)


@shared_task(name='accounts.tasks.prune_sign_ins')
def prune_sign_ins():
    from .signins import prune
    return prune()
