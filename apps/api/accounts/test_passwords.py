import re
from unittest import mock

from django.core import mail as outbox
from django.test import TestCase
from rest_framework.test import APIClient

PASSWORD = 'correct-horse-battery'


def sync_mail(to, template, context):
    from accounts import mail
    mail.deliver(to, template, context)


@mock.patch('accounts.tasks.send_email.delay', side_effect=sync_mail)
class PasswordTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        res = self.client.post('/api/auth/register', {'email': 'ann@example.com', 'password': PASSWORD}, format='json')
        self.refresh = res.data['refresh']
        self.access = res.data['access']

    def reset_link(self):
        body = outbox.outbox[-1].body
        uid, token = re.search(r'/reset-password\?uid=([^&\s]+)&token=(\S+)', body).groups()
        return uid, token

    def login(self, password):
        return self.client.post('/api/auth/login', {'email': 'ann@example.com', 'password': password}, format='json')

    def test_forgot_answers_the_same_for_unknown_and_known_addresses(self, _):
        unknown = self.client.post('/api/auth/password/forgot', {'email': 'nobody@example.com'}, format='json')
        self.assertEqual(len(outbox.outbox), 0)
        known = self.client.post('/api/auth/password/forgot', {'email': 'ANN@example.com'}, format='json')
        self.assertEqual((unknown.status_code, unknown.data), (known.status_code, known.data))
        self.assertEqual(len(outbox.outbox), 1)
        msg = outbox.outbox[0]
        self.assertEqual((msg.to, msg.subject), (['ann@example.com'], 'Reset your OpenPrism password'))
        self.assertIn('http://localhost:5173/reset-password?uid=', msg.body)

    def test_reset_sets_the_password_once_and_signs_out_other_sessions(self, _):
        self.client.post('/api/auth/password/forgot', {'email': 'ann@example.com'}, format='json')
        uid, token = self.reset_link()
        weak = self.client.post('/api/auth/password/reset', {'uid': uid, 'token': token, 'password': '123'}, format='json')
        self.assertEqual(weak.status_code, 400)
        ok = self.client.post('/api/auth/password/reset', {'uid': uid, 'token': token, 'password': 'new-horse-battery-9'}, format='json')
        self.assertEqual(ok.data, {'ok': True})
        self.assertEqual(self.login('new-horse-battery-9').status_code, 200)
        self.assertEqual(self.login(PASSWORD).status_code, 401)
        again = self.client.post('/api/auth/password/reset', {'uid': uid, 'token': token, 'password': 'other-horse-battery-9'}, format='json')
        self.assertEqual(again.status_code, 400)
        self.assertIn('invalid or has expired', again.data['error'])
        self.assertEqual(self.client.post('/api/auth/refresh', {'refresh': self.refresh}, format='json').status_code, 401)
        self.assertEqual(outbox.outbox[-1].subject, 'Your OpenPrism password was changed')

    def test_reset_rejects_bad_and_expired_tokens(self, _):
        for body in ({'uid': 'garbage', 'token': 'x'}, {'uid': '', 'token': ''}, {}):
            self.assertEqual(self.client.post('/api/auth/password/reset', {**body, 'password': 'new-horse-battery-9'}, format='json').status_code, 400)
        self.client.post('/api/auth/password/forgot', {'email': 'ann@example.com'}, format='json')
        uid, token = self.reset_link()
        with self.settings(PASSWORD_RESET_TIMEOUT=-1):
            res = self.client.post('/api/auth/password/reset', {'uid': uid, 'token': token, 'password': 'new-horse-battery-9'}, format='json')
        self.assertEqual(res.status_code, 400)

    def test_change_password(self, _):
        self.assertEqual(self.client.post('/api/auth/password/change', {'current': PASSWORD, 'password': 'new-horse-battery-9'}, format='json').status_code, 401)
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {self.access}')
        wrong = self.client.post('/api/auth/password/change', {'current': 'nope', 'password': 'new-horse-battery-9'}, format='json')
        self.assertIn('not correct', wrong.data['error'])
        weak = self.client.post('/api/auth/password/change', {'current': PASSWORD, 'password': 'short'}, format='json')
        self.assertEqual(weak.status_code, 400)
        ok = self.client.post('/api/auth/password/change', {'current': PASSWORD, 'password': 'new-horse-battery-9'}, format='json')
        self.assertTrue(ok.data['ok'])
        self.assertEqual(self.client.post('/api/auth/refresh', {'refresh': self.refresh}, format='json').status_code, 401)  # old session
        self.assertEqual(self.client.post('/api/auth/refresh', {'refresh': ok.data['refresh']}, format='json').status_code, 200)  # this one
        self.assertEqual(self.login('new-horse-battery-9').status_code, 200)
