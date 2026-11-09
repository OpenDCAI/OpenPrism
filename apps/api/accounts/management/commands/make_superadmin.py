from getpass import getpass

from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError

from accounts import superadmins


class Command(BaseCommand):
    help = ('Give an account access to the Django admin (/admin/). An existing account is promoted and keeps its password; '
            'an unknown address is created, verified, after a password prompt (never on the command line).')

    def add_arguments(self, parser):
        parser.add_argument('email')

    def handle(self, *args, email, **options):
        from accounts.models import User
        password = None
        if not User.objects.filter(email=email.strip().lower()).exists():
            password = getpass('Password for the new account: ')
            if password != getpass('Password (again): '):
                raise CommandError('The passwords do not match.')
            try:
                validate_password(password)
            except ValidationError as e:
                raise CommandError(' '.join(e.messages))
        try:
            user, created = superadmins.grant(email, password)
        except superadmins.SuperadminError as e:
            raise CommandError(str(e))
        self.stdout.write(f'{user.email} is a superadmin' + (' (account created)' if created else '') + '.')
