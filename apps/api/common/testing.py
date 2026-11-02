"""Helpers shared by test modules."""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer


class FakeLLM:
    """A tiny OpenAI-compatible server. `replies` are popped per request; each request is recorded."""

    def __init__(self, replies):
        self.replies, self.requests = list(replies), []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                outer.requests.append({'path': self.path, 'auth': self.headers.get('Authorization'), 'body': body})
                reply = outer.replies.pop(0) if outer.replies else {'content': 'default'}
                if isinstance(reply, tuple):  # (status, text) for error responses
                    self.send_response(reply[0])
                    self.end_headers()
                    self.wfile.write(reply[1].encode())
                    return
                payload = json.dumps({'choices': [{'message': reply}]}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *a):
                pass

        self.server = HTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_port}/v1'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def tool_call(name, args, call_id='c1'):
    return {'content': None, 'tool_calls': [{'id': call_id, 'type': 'function',
                                             'function': {'name': name, 'arguments': json.dumps(args)}}]}


class FakeZotero:
    """A stand-in for api.zotero.org. `routes` maps a request path (no query) to a reply: (status, body, headers) where
    body is JSON-serialisable or a str (sent as is), or a callable(handler_query_dict) returning such a tuple. Every
    request is recorded as {'path', 'query', 'key', 'version'}. Use with override_settings(ZOTERO_API_BASE=fake.url)."""

    def __init__(self, routes=None):
        from urllib.parse import parse_qs, urlparse
        self.routes, self.requests = dict(routes or {}), []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                url = urlparse(self.path)
                query = {k: v[0] for k, v in parse_qs(url.query).items()}
                outer.requests.append({'path': url.path, 'query': query, 'key': self.headers.get('Zotero-API-Key'),
                                       'version': self.headers.get('Zotero-API-Version')})
                reply = outer.routes.get(url.path, (404, 'not found', {}))
                if callable(reply):
                    reply = reply(query)
                status, body, headers = (tuple(reply) + ({},))[:3]
                payload = (body if isinstance(body, str) else json.dumps(body)).encode()
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, str(v))
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *a):
                pass

        self.server = HTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
