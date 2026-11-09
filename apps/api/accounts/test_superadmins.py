"""Making and removing superadmins, and the last-superadmin guard (v0.1.1, #82)."""
from io import StringIO
from unittest import mock

from django.contrib import admin
from django.contrib.admin.models import LogEntry
from django.contrib.auth import authenticate, get_user_model
from django.core.management import CommandError, call_command
from django.test import Client, RequestFactory, TestCase
from django.urls import reverse

from accounts import superadmins
from accounts.admin import UserAdmin
from projects.models import Membership

User = get_user_model()
PASSWORD = 'correct-horse-battery'
PROMPT = 'accounts.management.commands.make_superadmin.getpass'


def make(email='new@example.com', passwords=(PASSWORD, PASSWORD)):
    out = StringIO()
    with mock.patch(PROMPT, side_effect=list(passwords)):
        call_command('make_superadmin', email, stdout=out)
    return out.getvalue()


class MakeSuperadminTests(TestCase):
    def test_an_unknown_address_is_created_verified_and_can_use_the_admin(self):
        self.assertIn('account created', make())
        user = User.objects.get(email='new@example.com')
        self.assertEqual((user.is_active, user.is_staff, user.is_superuser), (True, True, True))
        self.assertIsNotNone(user.email_verified_at)
        self.assertTrue(Membership.objects.filter(user=user, workspace__kind='personal', role='owner').exists())
        self.assertEqual(authenticate(email='new@example.com', password=PASSWORD), user)
        client = Client()
        client.force_login(user)
        self.assertEqual(client.get('/admin/').status_code, 200)

    def test_an_existing_account_is_promoted_and_keeps_its_password(self):
        ann = User.objects.create_user('ann@example.com', 'ann-own-password-1')
        with mock.patch(PROMPT, side_effect=AssertionError('must not prompt')):
            call_command('make_superadmin', 'ANN@example.com', stdout=StringIO())
        ann.refresh_from_db()
        self.assertEqual((ann.is_staff, ann.is_superuser), (True, True))
        self.assertTrue(ann.check_password('ann-own-password-1'))
        self.assertIsNotNone(ann.email_verified_at)

    def test_mismatched_and_weak_passwords_create_nothing(self):
        for passwords in ((PASSWORD, 'something-else-entirely'), ('short', 'short')):
            with self.assertRaises(CommandError):
                make('x@example.com', passwords)
            self.assertFalse(User.objects.filter(email='x@example.com').exists())

    def test_the_command_is_logged_in_the_admin(self):
        make()
        user = User.objects.get(email='new@example.com')
        self.assertTrue(LogEntry.objects.filter(object_id=str(user.pk), change_message__contains='granted by management command').exists())


class RevokeSuperadminTests(TestCase):
    def setUp(self):
        self.root = User.objects.create_superuser('root@example.com', PASSWORD)
        self.other = User.objects.create_superuser('other@example.com', PASSWORD)

    def test_revoking_clears_both_flags_and_keeps_the_account(self):
        out = StringIO()
        call_command('revoke_superadmin', 'other@example.com', stdout=out)
        self.other.refresh_from_db()
        self.assertEqual((self.other.is_staff, self.other.is_superuser, self.other.is_active), (False, False, True))
        self.assertTrue(LogEntry.objects.filter(object_id=str(self.other.pk), change_message__contains='revoked by management command').exists())

    def test_the_last_superadmin_cannot_be_revoked(self):
        call_command('revoke_superadmin', 'other@example.com', stdout=StringIO())
        with self.assertRaisesMessage(CommandError, superadmins.LAST_ONE):
            call_command('revoke_superadmin', 'root@example.com', stdout=StringIO())
        self.root.refresh_from_db()
        self.assertTrue(self.root.is_superuser)

    def test_a_deactivated_superuser_does_not_count_as_one_that_remains(self):
        User.objects.filter(pk=self.other.pk).update(is_active=False)
        with self.assertRaisesMessage(CommandError, superadmins.LAST_ONE):
            call_command('revoke_superadmin', 'root@example.com', stdout=StringIO())

    def test_unknown_and_ordinary_accounts_are_reported(self):
        User.objects.create_user('plain@example.com', PASSWORD)
        for email in ('nobody@example.com', 'plain@example.com'):
            with self.assertRaises(CommandError):
                call_command('revoke_superadmin', email, stdout=StringIO())


class AdminFormGuardTests(TestCase):
    def setUp(self):
        self.root = User.objects.create_superuser('root@example.com', PASSWORD)
        self.client = Client()
        self.client.force_login(self.root)
        self.url = reverse('admin:accounts_user_change', args=[self.root.pk])

    def post(self, **flags):
        return self.client.post(self.url, {'name': 'Root', **flags})

    def test_the_last_superadmin_cannot_be_deactivated_or_demoted_in_the_form(self):
        for flags in ({'is_staff': 'on', 'is_superuser': 'on'},   # is_active unchecked
                      {'is_active': 'on', 'is_staff': 'on'},      # is_superuser unchecked
                      {'is_active': 'on', 'is_superuser': 'on'}):  # is_staff unchecked: could no longer log in
            res = self.post(**flags)
            self.assertContains(res, superadmins.LAST_ONE)
            self.root.refresh_from_db()
            self.assertTrue(superadmins.can_log_in_to_admin(self.root), flags)

    def test_with_another_superadmin_the_change_goes_through(self):
        User.objects.create_superuser('other@example.com', PASSWORD)
        self.assertEqual(self.post(is_active='on', is_staff='on').status_code, 302)  # superuser unchecked
        self.root.refresh_from_db()
        self.assertFalse(self.root.is_superuser)

    def test_saving_other_fields_of_the_last_superadmin_is_fine(self):
        self.assertEqual(self.post(is_active='on', is_staff='on', is_superuser='on').status_code, 302)

    def test_only_a_superuser_can_change_the_privilege_flags(self):
        request = RequestFactory().get('/')
        request.user = User.objects.create_user('plain@example.com', PASSWORD, is_staff=True)
        fields = UserAdmin(User, admin.site).get_readonly_fields(request)
        self.assertIn('is_superuser', fields)
        self.assertIn('is_staff', fields)
        request.user = self.root
        self.assertNotIn('is_superuser', UserAdmin(User, admin.site).get_readonly_fields(request))
