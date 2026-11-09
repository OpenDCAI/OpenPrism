import smtplib
from unittest import mock

from django.core import mail as outbox
from django.core.management import call_command
from django.test import SimpleTestCase, override_settings

from . import mail
from .tasks import send_email


@override_settings(APP_BASE_URL='https://prism.example.edu', DEFAULT_FROM_EMAIL='OpenPrism <no-reply@example.edu>')
class MailTests(SimpleTestCase):
    def test_renders_one_line_subject_text_and_html(self):
        mail.deliver('ada@example.org', 'test', {})
        msg = outbox.outbox[-1]
        self.assertEqual((msg.subject, msg.to, msg.from_email),
                         ('OpenPrism test message', ['ada@example.org'], 'OpenPrism <no-reply@example.edu>'))
        self.assertIn('https://prism.example.edu', msg.body)
        html, kind = msg.alternatives[0]
        self.assertEqual(kind, 'text/html')
        self.assertIn('outgoing mail works', html)

    def test_links_use_the_app_url(self):
        self.assertEqual(mail.app_link('/reset-password?x=1'), 'https://prism.example.edu/reset-password?x=1')

    @override_settings(MAIL_SEND_INLINE=False)
    def test_send_template_queues_the_task(self):
        with mock.patch('accounts.tasks.send_email.delay') as delay:
            mail.send_template('ada@example.org', 'test', {'a': 1})
        delay.assert_called_once_with('ada@example.org', 'test', {'a': 1}, None, None)

    def test_smtp_failure_is_retried_and_the_body_is_not_logged(self):
        with mock.patch('accounts.mail.deliver', side_effect=smtplib.SMTPServerDisconnected('gone')), \
                mock.patch.object(send_email, 'retry', side_effect=RuntimeError('retry scheduled')) as retry, \
                self.assertLogs('accounts.tasks', 'WARNING') as logs:
            with self.assertRaisesMessage(RuntimeError, 'retry scheduled'):
                send_email.run('ada@example.org', 'test', {'link': 'https://secret-link'})
        self.assertEqual(retry.call_args.kwargs['countdown'], 30)
        self.assertNotIn('secret-link', '\n'.join(logs.output))
        self.assertIn('SMTPServerDisconnected', '\n'.join(logs.output))

    def test_management_command_sends_now(self):
        call_command('send_test_email', 'ops@example.org', stdout=mock.MagicMock())
        self.assertEqual(outbox.outbox[-1].to, ['ops@example.org'])
