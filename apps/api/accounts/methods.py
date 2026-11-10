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
