from allauth.account.models import EmailAddress
from django.test import TestCase
from django.utils import timezone

from accounts import emails
from accounts.models import User
from accounts.verification import mark_verified


class EmailAddressMirrorTests(TestCase):
    def rows(self, user):
        return list(EmailAddress.objects.filter(user=user).values_list('email', 'primary', 'verified'))

    def test_a_new_account_gets_one_unverified_primary_row(self):
        user = User.objects.create_user(email='ann@example.com', password='x')
        self.assertEqual(self.rows(user), [('ann@example.com', True, False)])

    def test_verifying_and_the_admin_action_keep_it_in_step(self):
        user = User.objects.create_user(email='ann@example.com', password='x')
        mark_verified(user)
        self.assertEqual(self.rows(user), [('ann@example.com', True, True)])
        other = User.objects.create_user(email='bob@example.com', password='x')
        other.email_verified_at = timezone.now()
        other.save()
        self.assertEqual(self.rows(other), [('bob@example.com', True, True)])

    def test_a_changed_address_moves_the_primary_row(self):
        user = User.objects.create_user(email='ann@example.com', password='x')
        user.email = 'ann2@example.com'
        user.save()
        self.assertEqual(sorted(self.rows(user)), [('ann2@example.com', True, False), ('ann@example.com', False, False)])

    def test_bulk_update_needs_sync_and_sync_repairs_it(self):
        user = User.objects.create_user(email='ann@example.com', password='x')
        User.objects.filter(pk=user.pk).update(email_verified_at=timezone.now())
        self.assertEqual(self.rows(user), [('ann@example.com', True, False)])
        emails.sync(User.objects.get(pk=user.pk))
        self.assertEqual(self.rows(user), [('ann@example.com', True, True)])

    def test_the_migration_covers_accounts_that_already_exist(self):
        verified = User.objects.create_user(email='v@example.com', password='x', email_verified_at=timezone.now())
        plain = User.objects.create_user(email='p@example.com', password='x')
        EmailAddress.objects.all().delete()
        from importlib import import_module
        from django.apps import apps
        import_module('accounts.migrations.0004_email_addresses').mirror(apps, None)
        self.assertEqual(self.rows(verified), [('v@example.com', True, True)])
        self.assertEqual(self.rows(plain), [('p@example.com', True, False)])
