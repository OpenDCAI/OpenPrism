"""Refuses placeholder and weak secrets on a real deployment (#117). Standard library only, so the deploy workflow can run
it as a plain script (`python3 apps/api/common/secretcheck.py`) and settings can import it. It never prints a secret."""
import base64
import binascii
import os
import sys

# Values that ship in .env.sample, compose.yaml, the test settings and the Helm CI values. None may reach a real deploy.
KNOWN_PLACEHOLDERS = {
    'dev-insecure-change-me',
    'test-only-secret',
    'not-a-real-key',
    'b3BlbnByaXNtLWRldi1rZXktbm90LXNlY3JldC0wMTI=',   # .env.sample / compose
    'b3BlbnByaXNtLXRlc3Qta2V5LW5vdC1zZWNyZXQtMDE=',   # test settings
}
PLACEHOLDER_WORDS = ('change-me', 'changeme', 'insecure', 'placeholder', 'not-a-real', 'example', 'secret-key-here')
MIN_SECRET_KEY_LENGTH = 32


def _placeholder(value):
    v = (value or '').strip()
    return v in KNOWN_PLACEHOLDERS or any(w in v.lower() for w in PLACEHOLDER_WORDS)


def _valid_fernet_key(key):
    try:
        return len(base64.urlsafe_b64decode(key.encode())) == 32
    except (binascii.Error, ValueError):
        return False


def problems(secret_key, encryption_keys):
    """List of reasons these secrets are not fit for a real deployment (empty = fine)."""
    out = []
    if not secret_key:
        out.append('DJANGO_SECRET_KEY is empty')
    elif _placeholder(secret_key):
        out.append('DJANGO_SECRET_KEY is a placeholder value')
    elif len(secret_key) < MIN_SECRET_KEY_LENGTH or len(set(secret_key)) < 8:
        out.append(f'DJANGO_SECRET_KEY is weak (needs at least {MIN_SECRET_KEY_LENGTH} characters and some variety)')
    keys = [k.strip() for k in (encryption_keys or '').split(',') if k.strip()]
    if not keys:
        out.append('CREDENTIAL_ENCRYPTION_KEY is empty')
    for i, k in enumerate(keys, 1):
        if _placeholder(k):
            out.append(f'CREDENTIAL_ENCRYPTION_KEY #{i} is a placeholder value')
        elif not _valid_fernet_key(k):
            out.append(f'CREDENTIAL_ENCRYPTION_KEY #{i} is not a valid Fernet key (32 bytes, url-safe base64)')
    return out


def main(environ=os.environ):
    found = problems(environ.get('DJANGO_SECRET_KEY', ''), environ.get('CREDENTIAL_ENCRYPTION_KEY', ''))
    for f in found:
        print(f'::error::{f}')
    if found:
        print('Refusing to deploy with placeholder or weak secrets; see deploy/helm/README.md, "Secrets".')
        return 1
    print('Secrets look fit for a deployment (not placeholders; formats valid).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
