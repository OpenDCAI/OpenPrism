"""Re-encrypt every stored credential under the first CREDENTIAL_ENCRYPTION_KEY (#117).

Rotating that key is two steps: (1) put the new key in front of the old one (comma-separated), deploy; new writes use it
and old values still open. (2) run this command, which rewrites every value still held under an older key. Once a
dry run reports nothing left, the old key can be removed from the list.

  manage.py reencrypt_credentials           # dry run: counts per kind, writes nothing
  manage.py reencrypt_credentials --apply   # rewrite what is not yet on the first key

A value that no listed key can open is reported and left alone (never removed); it means the key it was written with is
no longer in the list. Plaintext is never printed or logged.
"""
from allauth.mfa.models import Authenticator
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from integrations import crypto
from integrations.models import UserCredential, WorkspaceLlmConfig, ZoteroConnection

BINARY_MODELS = [(ZoteroConnection, 'Zotero keys'), (UserCredential, 'personal AI keys'),
                 (WorkspaceLlmConfig, 'workspace AI keys')]


def _text_rotate(value):
    """Authenticator values are stored as str (the MFA adapter's .decode()). Returns (new, state)."""
    raw = value.encode()
    if crypto.is_current(raw):
        return value, 'current'
    try:
        return crypto.rotate(raw).decode(), 'rotated'
    except ValueError:
        return value, 'undecryptable'


class Command(BaseCommand):
    help = 'Re-encrypt stored credentials under the first CREDENTIAL_ENCRYPTION_KEY (dry run unless --apply).'

    def add_arguments(self, parser):
        parser.add_argument('--apply', action='store_true', help='write the changes (default: only count them)')

    def handle(self, *args, apply=False, **opts):
        if len(crypto.keys()) < 1:
            raise CommandError('CREDENTIAL_ENCRYPTION_KEY is empty')
        totals = {'current': 0, 'rotated': 0, 'undecryptable': 0}

        def tally(state, label):
            totals[state] += 1
            if state == 'undecryptable':
                self.stderr.write(f'cannot decrypt a {label}; is its key still in CREDENTIAL_ENCRYPTION_KEY?')

        with transaction.atomic():
            for model, label in BINARY_MODELS:
                for row in model.objects.select_for_update().all():
                    token = bytes(row.api_key_encrypted)
                    if crypto.is_current(token):
                        tally('current', label)
                        continue
                    try:
                        new = crypto.rotate(token)
                    except ValueError:
                        tally('undecryptable', label)
                        continue
                    totals['rotated'] += 1
                    if apply:
                        row.api_key_encrypted = new
                        row.save(update_fields=['api_key_encrypted'])
            for auth in Authenticator.objects.select_for_update().filter(
                    type__in=[Authenticator.Type.TOTP, Authenticator.Type.RECOVERY_CODES]):
                data, changed = dict(auth.data), False
                for field in ('secret', 'seed'):
                    if isinstance(data.get(field), str):
                        data[field], state = _text_rotate(data[field])
                        tally(state, 'two-factor secret')
                        changed = changed or state == 'rotated'
                codes = data.get('migrated_codes')
                if isinstance(codes, list):
                    out = []
                    for c in codes:
                        n, state = _text_rotate(c) if isinstance(c, str) else (c, 'current')
                        tally(state, 'recovery code')
                        changed = changed or state == 'rotated'
                        out.append(n)
                    data['migrated_codes'] = out
                if changed and apply:
                    auth.data = data
                    auth.save(update_fields=['data'])
        verb = 'rewrote' if apply else 'would rewrite'
        self.stdout.write(f"{verb} {totals['rotated']}; already on the first key {totals['current']}; "
                          f"cannot decrypt {totals['undecryptable']}.")
        if totals['undecryptable']:
            raise CommandError('Some values cannot be decrypted with the listed keys; do NOT remove any key yet.')
        if not apply and totals['rotated']:
            self.stdout.write('Dry run: nothing written. Run with --apply.')
