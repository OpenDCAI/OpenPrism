"""The admin's *Send a test email* page (#179)."""
from unittest import mock

from django.contrib.admin.models import LogEntry
from django.core import mail as outbox
from django.test import Client, TestCase, override_settings
from django.urls import reverse

from accounts import mailtest
from accounts.models import User

PW = 'a-long-test-password-123'


class MailTestPageTests(TestCase):
    def setUp(self):
        self.root = User.objects.create_superuser('root@example.com', PW)
        self.client = Client()
        self.client.force_login(self.root)
        self.url = reverse('admin:mail_test')
        outbox.outbox.clear()

    def test_page_shows_settings_without_the_password_and_defaults_to_me(self):
        with override_settings(EMAIL_HOST='smtp.example.org', EMAIL_HOST_PASSWORD='hunter2-secret'):
            r = self.client.get(self.url)
        self.assertContains(r, 'smtp.example.org')
        self.assertContains(r, 'value="root@example.com"')
        self.assertNotContains(r, 'hunter2-secret')
        self.assertContains(self.client.get(reverse('admin:index')), self.url)

    def test_send_works(self):
        r = self.client.post(self.url, {'to': 'ops@example.org'})
        self.assertContains(r, 'Sent to ops@example.org')
        self.assertEqual([m.to for m in outbox.outbox], [['ops@example.org']])
        self.assertIn('Test email to ops@example.org: sent', LogEntry.objects.get().change_message)

    @override_settings(EMAIL_HOST_PASSWORD='hunter2-secret')
    def test_failure_is_shown_without_the_password(self):
        boom = ConnectionRefusedError(111, 'refused, login hunter2-secret')
        with mock.patch('accounts.mail.deliver', side_effect=boom):
            r = self.client.post(self.url, {'to': 'ops@example.org'})
        self.assertContains(r, 'Not sent to ops@example.org: ConnectionRefusedError')
        self.assertNotContains(r, 'hunter2-secret')
        self.assertNotIn('hunter2-secret', LogEntry.objects.get().change_message)

    def test_no_worker_answer(self):
        from celery.exceptions import TimeoutError as CeleryTimeout
        result = mock.Mock(**{'get.side_effect': CeleryTimeout()})
        with override_settings(MAIL_SEND_INLINE=False), \
                mock.patch('accounts.tasks.send_test_email.delay', return_value=result):
            outcome = mailtest.run('ops@example.org')
        self.assertFalse(outcome['ok'])
        self.assertIn('No worker answered', outcome['error'])
        result.revoke.assert_called_once()

    def test_only_superadmins(self):
        staff = User.objects.create_user('staff@example.com', PW, is_staff=True)
        c = Client()
        c.force_login(staff)
        r = c.post(self.url, {'to': 'ops@example.org'})
        self.assertEqual(r.status_code, 302)
        self.assertIn('/admin/login/', r['Location'])
        self.assertEqual(outbox.outbox, [])
        anon = Client().get(self.url)
        self.assertEqual(anon.status_code, 302)
