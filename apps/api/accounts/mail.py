"""Outgoing mail. Every message is a template under accounts/templates/email/: `<name>_subject.txt`, `<name>.txt` and
`<name>.html`, rendered with `context` plus `app_url` (APP_BASE_URL) and `link` built from it. Sending happens in the
`accounts.tasks.send_email` task, so a slow SMTP server never holds up a request. Bodies often carry one-time links:
never log them."""
from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.template import Context
from django.template.loader import get_template, render_to_string


def _plain(name, ctx):
    """Render a text part without HTML escaping (a link's `&` must stay `&`)."""
    return get_template(name).template.render(Context(ctx, autoescape=False))


def app_link(path):
    """An absolute link into the app for a mail (`path` starts with '/')."""
    return settings.APP_BASE_URL + path


def render(template, context):
    ctx = {'app_url': settings.APP_BASE_URL, **context}
    subject = ' '.join(_plain(f'email/{template}_subject.txt', ctx).split())  # one line, no stray whitespace
    return subject, _plain(f'email/{template}.txt', ctx), render_to_string(f'email/{template}.html', ctx)


def deliver(to, template, context):
    """Render and send now (the task calls this; tests may too)."""
    subject, text, html = render(template, context)
    message = EmailMultiAlternatives(subject, text, settings.DEFAULT_FROM_EMAIL, [to])
    message.attach_alternative(html, 'text/html')
    message.send()


def send_template(to, template, context, invite_id=None):
    """Queue a templated mail. Returns at once; delivery is retried by the task. `invite_id` ties the outcome to a
    WorkspaceInvite (`send_failed`)."""
    from .tasks import send_email
    if settings.MAIL_SEND_INLINE:  # tests: like the real task, a failure is recorded and never fails the request
        try:
            send_email.run(to, template, context, invite_id)
        except Exception:  # noqa: BLE001 - logged by the task
            pass
        return
    send_email.delay(to, template, context, invite_id)
