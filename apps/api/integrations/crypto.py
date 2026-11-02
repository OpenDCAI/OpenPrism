"""Encryption at rest for third-party credentials. The only place that holds the plaintext of a stored key."""
from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from django.conf import settings


def _fernet():
    keys = [k.strip() for k in settings.CREDENTIAL_ENCRYPTION_KEY.split(',') if k.strip()]
    return MultiFernet([Fernet(k) for k in keys])


def encrypt(plaintext):
    return _fernet().encrypt(plaintext.encode())


def decrypt(token):
    try:
        return _fernet().decrypt(bytes(token)).decode()
    except InvalidToken:
        raise ValueError('Stored credential cannot be decrypted (was CREDENTIAL_ENCRYPTION_KEY changed?)') from None
