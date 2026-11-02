"""A fake Zotero for manual QA and the browser test: `python -m integrations.devserver [port]` inside the api container,
then restart the api with ZOTERO_API_BASE=http://localhost:<port> (the default port is 9099). Any API key is accepted."""
import sys
import time

from common.testing import FakeZotero

LIB = {
    'ATTN0001': ('Attention Is All You Need', 'Vaswani', 'Ashish', 2017, 'vaswani_attention_2017'),
    'BERT0002': ('BERT: Pre-training of Deep Bidirectional Transformers', 'Devlin', 'Jacob', 2019, 'devlin_bert_2019'),
    'LORA0003': ('LoRA: Low-Rank Adaptation of Large Language Models', 'Hu', 'Edward', 2021, 'hu_lora_2021'),
}


def _data(key):
    title, last, first, year, _ = LIB[key]
    return {'key': key, 'itemType': 'conferencePaper', 'title': title, 'date': str(year),
            'creators': [{'creatorType': 'author', 'firstName': first, 'lastName': last}]}


def _bibtex(key):
    title, last, first, year, cite = LIB[key]
    return f'@inproceedings{{{cite},\n\ttitle = {{{title}}},\n\tauthor = {{{last}, {first}}},\n\tyear = {{{year}}},\n}}'


def _items_top(query):
    q = query.get('q', '').lower()
    keys = [k for k in LIB if q in LIB[k][0].lower() or q in LIB[k][1].lower()]
    return 200, [{'key': k, 'data': _data(k)} for k in keys], {'Total-Results': len(keys)}


def _items(query):
    fmt = query['include'].split(',')[1]
    return 200, [{'key': k, 'data': _data(k), fmt: _bibtex(k)} for k in query['itemKey'].split(',') if k in LIB]


def build(port=0):
    fake = FakeZotero({
        '/keys/current': (200, {'userID': 4242, 'username': 'demo-user'}),
        '/users/4242/groups': (200, [{'id': 77, 'data': {'name': 'Demo Lab'}}]),
        '/users/4242/collections': (200, [{'key': 'COLL0001', 'data': {'name': 'Transformers', 'parentCollection': False}}]),
        '/users/4242/items/top': _items_top,
        '/users/4242/collections/COLL0001/items/top': _items_top,
        '/users/4242/items': _items,
    })
    return fake


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9099
    # FakeZotero binds an ephemeral port on 127.0.0.1; rebuild it on the requested one.
    from http.server import HTTPServer
    fake = build()
    fake.server.shutdown(); fake.server.server_close()
    fake.server = HTTPServer(('127.0.0.1', port), fake.server.RequestHandlerClass)
    import threading
    threading.Thread(target=fake.server.serve_forever, daemon=True).start()
    print(f'fake Zotero on http://127.0.0.1:{port}', flush=True)
    while True:
        time.sleep(3600)
