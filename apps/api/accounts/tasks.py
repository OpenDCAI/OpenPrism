import logging
import smtplib
import socket

from celery import shared_task

from . import mail

log = logging.getLogger(__name__)


@shared_task(name='accounts.tasks.send_email', bind=True, max_retries=5, ignore_result=True)
def send_email(self, to, template, context):
    """Send one templated mail, retrying with backoff (30 s, 1, 2, 4, 8 min) if the mail server is unavailable."""
    try:
        mail.deliver(to, template, context)
    except (smtplib.SMTPException, OSError, socket.timeout) as exc:
        # Log the failure, never the body: it may contain a password-reset or verification link.
        log.warning('mail %s to %s failed (attempt %s): %s', template, to, self.request.retries + 1, exc.__class__.__name__)
        raise self.retry(exc=exc, countdown=30 * (2 ** self.request.retries))
