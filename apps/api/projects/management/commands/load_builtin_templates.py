"""Create or update the built-in templates shipped in the image (run after `migrate` on every release).

Idempotent: built-ins are rewritten to match `builtin_templates/`, user-uploaded templates are never touched, and no
projects are imported.
"""
from django.core.management import call_command
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = 'Load or refresh the built-in templates from the image (idempotent).'

    def handle(self, *a, **opts):
        call_command('import_legacy', skip_projects=True, stdout=self.stdout)
