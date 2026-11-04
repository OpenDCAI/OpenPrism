from django.core.management.base import BaseCommand

from accounts import mail


class Command(BaseCommand):
    help = 'Send a test mail synchronously with the configured EMAIL_* settings (checks a deployment can send mail).'

    def add_arguments(self, parser):
        parser.add_argument('to')

    def handle(self, *args, to, **options):
        mail.deliver(to, 'test', {})
        self.stdout.write(f'sent to {to}')
