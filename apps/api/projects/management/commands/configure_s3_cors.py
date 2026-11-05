"""Let the app's pages PUT straight to the bucket (direct uploads): sets the bucket's CORS rules for APP_BASE_URL and
TRUSTED_ORIGINS, plus any origins given. Idempotent; deploy/garage-init.sh runs it."""
from django.conf import settings
from django.core.management.base import BaseCommand

from projects import storage


class Command(BaseCommand):
    help = 'Set the bucket CORS rules that direct uploads need.'

    def add_arguments(self, parser):
        parser.add_argument('origins', nargs='*', help='more origins, e.g. http://localhost:5173')

    def handle(self, *args, **opts):
        origins = sorted({*settings.TRUSTED_ORIGINS, *(o.rstrip('/') for o in opts['origins'])})
        storage.put_bucket_cors(origins)
        self.stdout.write(f"Bucket {settings.S3_BUCKET}: PUT allowed from {', '.join(origins)}")
