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


def keys():
    return [k.strip() for k in settings.CREDENTIAL_ENCRYPTION_KEY.split(',') if k.strip()]


def is_current(token):
    """True when the first (encrypting) key can open this token, i.e. it needs no re-encryption."""
    try:
        Fernet(keys()[0]).decrypt(bytes(token))
        return True
    except InvalidToken:
        return False


def rotate(token):
    """Re-encrypt a token under the first key. Raises ValueError if no listed key can open it."""
    try:
        return _fernet().rotate(bytes(token))
    except InvalidToken:
        raise ValueError('no configured CREDENTIAL_ENCRYPTION_KEY can decrypt this value') from None
