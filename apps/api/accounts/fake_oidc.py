"""A fake OpenID Connect provider for tests and the browser suite (v0.1.4): discovery-free, one RSA key, any client.

As a library, `FakeOidc.start()` serves /authorize, /token and /jwks on a local port in a thread; tests choose who signs
in with `fake.identity = {...}`. As a script (`python -m accounts.fake_oidc 9097`) it is the e2e dev server: the browser
follows /authorize to a page that immediately redirects back with a code for the identity set at
POST /identity {"sub":..,"email":..,"email_verified":true,"name":..}."""
import base64
import json
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa


def _b64(n):
    raw = n.to_bytes((n.bit_length() + 7) // 8, 'big')
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode()


class FakeOidc:
    def __init__(self, client_id='client-1', host='127.0.0.1', port=0, public_host=None):
        self.client_id, self.issuer_override = client_id, None
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.identity = {'sub': 'sub-1', 'email': 'ann@example.com', 'email_verified': True, 'name': 'Ann'}
        self.codes, self.sign_with = {}, None
        self.tamper = None   # callable(claims) -> claims, for negative tests
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, status, body, ctype='application/json', headers=None):
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Type', ctype)
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                url = urlparse(self.path)
                q = {k: v[0] for k, v in parse_qs(url.query).items()}
                if url.path == '/jwks':
                    pub = outer.key.public_key().public_numbers()
                    return self._send(200, {'keys': [{'kty': 'RSA', 'kid': 'k1', 'use': 'sig', 'alg': 'RS256', 'n': _b64(pub.n), 'e': _b64(pub.e)}]})
                if url.path == '/authorize':
                    code = secrets.token_urlsafe(16)
                    outer.codes[code] = {'nonce': q.get('nonce'), 'client_id': q.get('client_id'), 'identity': dict(outer.identity)}
                    back = {'code': code, 'state': q.get('state')}
                    return self._send(302, b'', headers={'Location': q['redirect_uri'] + '?' + urlencode(back)})
                self._send(404, {'error': 'not found'})

            def do_POST(self):
                length = int(self.headers.get('Content-Length') or 0)
                raw = self.rfile.read(length).decode()
                if self.path == '/identity':   # e2e: choose who signs in next
                    outer.identity = json.loads(raw)
                    return self._send(200, {'ok': True})
                if self.path == '/token':
                    form = {k: v[0] for k, v in parse_qs(raw).items()}
                    entry = outer.codes.pop(form.get('code'), None)
                    if entry is None or form.get('client_id') != outer.client_id or not form.get('code_verifier'):
                        return self._send(400, {'error': 'invalid_grant'})
                    now = int(time.time())
                    claims = {'iss': outer.issuer_override or outer.issuer, 'aud': outer.client_id, 'iat': now, 'exp': now + 300,
                              'nonce': entry['nonce'], **entry['identity']}
                    claims = outer.tamper(claims) if outer.tamper else claims
                    token = jwt.encode(claims, outer.sign_with or outer.key, algorithm='RS256', headers={'kid': 'k1'})
                    return self._send(200, {'access_token': 'x', 'token_type': 'Bearer', 'id_token': token})
                self._send(404, {'error': 'not found'})

        self.httpd = ThreadingHTTPServer((host, port), Handler)
        self.public_host = public_host or host

    @property
    def base(self):
        return f'http://{self.public_host}:{self.httpd.server_address[1]}'

    issuer = property(lambda self: self.base)

    def settings(self, name='google', secret='s3cret'):
        """A SOCIAL_PROVIDERS entry pointing at this server."""
        return {name: {'label': name.title(), 'issuer': self.issuer, 'auth_url': self.base + '/authorize', 'token_url': self.base + '/token',
                       'jwks_url': self.base + '/jwks', 'scope': 'openid email', 'client_id': self.client_id, 'client_secret': secret}}

    def start(self):
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


if __name__ == '__main__':   # python -m accounts.fake_oidc 9097 [public host]
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9097
    fake = FakeOidc(client_id='e2e-client', host='0.0.0.0', port=port, public_host=sys.argv[2] if len(sys.argv) > 2 else 'localhost')
    print(f'fake OIDC provider on {fake.base}', flush=True)
    fake.httpd.serve_forever()
