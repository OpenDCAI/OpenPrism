"""allauth keeps authenticator secrets in the database as given; ours are encrypted like every other stored credential."""
from allauth.mfa.adapter import DefaultMFAAdapter

from integrations import crypto


class FernetMFAAdapter(DefaultMFAAdapter):
    def encrypt(self, text):
        return crypto.encrypt(text).decode()

    def decrypt(self, encrypted_text):
        return crypto.decrypt(encrypted_text.encode())
