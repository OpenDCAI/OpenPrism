"""*Send a test email* in the admin (#179): is outgoing mail working on this deployment?

The test mail goes through the mail worker's queue like every real mail, and the page waits for the outcome, so a broken
SMTP server, a worker that is down and a working setup each give a clear answer. Nothing secret is shown: the password
appears only as "set", and is cut out of any error text."""
from celery.exceptions import TimeoutError as CeleryTimeout
from django.conf import settings

from . import mail

WAIT_SECONDS = 30


def config():
    """The mail settings an operator needs to see, without secrets."""
    return [
        ('Backend', settings.EMAIL_BACKEND),
        ('Host', settings.EMAIL_HOST),
        ('Port', settings.EMAIL_PORT),
        ('STARTTLS (EMAIL_USE_TLS)', settings.EMAIL_USE_TLS),
        ('TLS (EMAIL_USE_SSL)', settings.EMAIL_USE_SSL),
        ('User', 'set' if settings.EMAIL_HOST_USER else 'not set'),
        ('Password', 'set' if settings.EMAIL_HOST_PASSWORD else 'not set'),
        ('From', settings.DEFAULT_FROM_EMAIL),
        ('Timeout (s)', settings.EMAIL_TIMEOUT),
    ]


def scrub(text):
    for secret in (settings.EMAIL_HOST_PASSWORD,):
        if secret:
            text = text.replace(secret, '***')
    return text


def attempt(to):
    """Send now (in whichever process runs this). {ok: True} or {ok: False, error: '<Class>: <message>'}."""
    try:
        mail.deliver(to, 'test', {})
    except Exception as exc:  # noqa: BLE001 - any failure is the answer the page shows
        return {'ok': False, 'error': scrub(f'{exc.__class__.__name__}: {exc}')[:500]}
    return {'ok': True}


def run(to):
    """Queue the test on the mail worker and wait for its outcome (inline under tests)."""
    from .tasks import send_test_email
    if settings.MAIL_SEND_INLINE:
        return send_test_email.run(to)
    result = send_test_email.delay(to)
    try:
        return result.get(timeout=WAIT_SECONDS)
    except CeleryTimeout:
        result.revoke()
        return {'ok': False, 'error': f'No worker answered within {WAIT_SECONDS} s: is worker-ai running and '
                                      'consuming the "import" queue?'}
    except Exception as exc:  # noqa: BLE001 - e.g. the result backend (Redis) is unreachable
        return {'ok': False, 'error': scrub(f'{exc.__class__.__name__}: {exc}')[:500]}
