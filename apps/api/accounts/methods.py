"""The ways an account can sign in (v0.1.4): a usable password, passkeys, linked identities. Anything that removes one
asks `others_remain` first, so a person is never left with none."""
from allauth.mfa.models import Authenticator


def passkey_count(user):
    return Authenticator.objects.filter(user=user, type=Authenticator.Type.WEBAUTHN).count()


def others_remain(user, *, identity=None, passkey=None):
    """True when the account could still sign in after `identity` or `passkey` (a model instance) goes."""
    if user.has_usable_password():
        return True
    passkeys = passkey_count(user) - (1 if passkey is not None else 0)
    identities = user.identities.count() - (1 if identity is not None else 0)
    return passkeys + identities > 0


LAST_METHOD = 'This is your only way to sign in. Set a password or add another method first.'


NOT_CONFIRMED_PASSWORD = 'Your password is not correct.'
NOT_CONFIRMED_EMAIL = 'That is not the email address of this account.'


def confirm(user, value):
    """Re-confirm a signed-in person before something sensitive: their password, or for an account that has none (it
    signs in through a provider or a passkey) its own email address, typed."""
    value = str(value or '')
    if user.has_usable_password():
        return user.check_password(value)
    return value.strip().lower() == user.email


def confirm_error(user):
    return NOT_CONFIRMED_PASSWORD if user.has_usable_password() else NOT_CONFIRMED_EMAIL
