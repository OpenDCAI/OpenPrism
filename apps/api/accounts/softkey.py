"""A software WebAuthn authenticator for tests (a platform passkey that always passes user verification)."""
import hashlib
import json
import os
import struct

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from fido2 import cbor
from fido2.cose import ES256
from fido2.utils import websafe_decode, websafe_encode
from fido2.webauthn import AttestedCredentialData


class SoftKey:
    def __init__(self, origin='http://localhost:5173', rp_id='localhost'):
        self.origin, self.rp_id = origin, rp_id
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.credential_id = os.urandom(32)
        self.user_handle = None
        self.counter = 0

    def _client_data(self, kind, challenge):
        return json.dumps({'type': kind, 'challenge': challenge, 'origin': self.origin, 'crossOrigin': False}).encode()

    def _auth_data(self, flags, attested=b''):
        self.counter += 1
        return hashlib.sha256(self.rp_id.encode()).digest() + bytes([flags]) + struct.pack('>I', self.counter) + attested

    def create(self, options):
        pk = options['publicKey']
        self.user_handle = websafe_decode(pk['user']['id'])
        cose = dict(ES256.from_cryptography_key(self.key.public_key()))
        attested = bytes(AttestedCredentialData.create(b'\0' * 16, self.credential_id, cose))
        auth_data = self._auth_data(0x01 | 0x04 | 0x40, attested)  # user present, user verified, attested data
        attestation = cbor.encode({'fmt': 'none', 'attStmt': {}, 'authData': auth_data})
        client = self._client_data('webauthn.create', pk['challenge'])
        return {'id': websafe_encode(self.credential_id), 'rawId': websafe_encode(self.credential_id), 'type': 'public-key',
                'authenticatorAttachment': 'platform', 'clientExtensionResults': {'credProps': {'rk': True}},
                'response': {'clientDataJSON': websafe_encode(client), 'attestationObject': websafe_encode(attestation),
                             'transports': ['internal']}}

    def get(self, options, user_handle=True):
        pk = options['publicKey']
        auth_data = self._auth_data(0x01 | 0x04)
        client = self._client_data('webauthn.get', pk['challenge'])
        signature = self.key.sign(auth_data + hashlib.sha256(client).digest(), ec.ECDSA(hashes.SHA256()))
        response = {'clientDataJSON': websafe_encode(client), 'authenticatorData': websafe_encode(auth_data),
                    'signature': websafe_encode(signature)}
        if user_handle and self.user_handle is not None:
            response['userHandle'] = websafe_encode(self.user_handle)
        return {'id': websafe_encode(self.credential_id), 'rawId': websafe_encode(self.credential_id), 'type': 'public-key',
                'clientExtensionResults': {}, 'response': response}
