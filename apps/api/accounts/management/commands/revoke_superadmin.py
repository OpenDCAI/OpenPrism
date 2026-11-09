from django.core.management.base import BaseCommand, CommandError

from accounts import superadmins


class Command(BaseCommand):
    help = 'Remove an account\'s access to the Django admin. The account itself stays. The last superadmin cannot be removed.'

    def add_arguments(self, parser):
        parser.add_argument('email')

    def handle(self, *args, email, **options):
        try:
            user = superadmins.revoke(email)
        except superadmins.SuperadminError as e:
            raise CommandError(str(e))
        self.stdout.write(f'{user.email} is no longer a superadmin.')
