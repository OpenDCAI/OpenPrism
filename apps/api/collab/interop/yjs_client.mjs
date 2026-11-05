// Interop check: the real Yjs/y-protocols stack (what the browser uses) against the Django collab server.
// The message handling below is copied from apps/frontend/src/collab/provider.ts.
// Usage (from the repo root, with the stack running):
//   node apps/api/collab/interop/yjs_client.mjs <baseUrl> <token> <projectId> <file> [<secondReplicaBaseUrl>]
// <token> is an invite token or an access token; like the browser, the script exchanges it for a URL token first.
// With a second base URL, bob and carol connect to that replica, so every check also exercises Redis fan-out.
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';

const [base, credential, projectId, file, base2 = base] = process.argv.slice(2);
const minted = await fetch(`${base}/api/url-token`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
  body: JSON.stringify({ scope: 'project', projectId })
}).then((r) => r.json());
if (!minted.token) throw new Error(`Could not mint a URL token: ${JSON.stringify(minted)}`);
const token = minted.token;
const MESSAGE_SYNC = 0, MESSAGE_AWARENESS = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(name, server = base) {
  const doc = new Y.Doc();
  const text = doc.getText('content');
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalStateField('user', { name, color: '#abc' });
  const qs = new URLSearchParams({ projectId, file, token });
  const ws = new WebSocket(`${server.replace(/^http/, 'ws')}/api/collab?${qs}`);
  ws.binaryType = 'arraybuffer';
  const client = { name, doc, text, awareness, ws, closeCode: null };
  doc.on('update', (update, origin) => {
    if (origin === client || ws.readyState !== WebSocket.OPEN) return;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MESSAGE_SYNC);
    syncProtocol.writeUpdate(e, update);
    ws.send(encoding.toUint8Array(e));
  });
  awareness.on('update', ({ added, updated, removed }, origin) => {
    if (origin === client || ws.readyState !== WebSocket.OPEN) return;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(awareness, added.concat(updated).concat(removed)));
    ws.send(encoding.toUint8Array(e));
  });
  ws.on('open', () => {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(e, doc);
    ws.send(encoding.toUint8Array(e));
    const local = awareness.getLocalState();
    if (local) awareness.setLocalState(local);
  });
  ws.on('message', (data) => {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, e, doc, client);
      if (encoding.length(e) > 1) ws.send(encoding.toUint8Array(e));
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), client);
    }
  });
  ws.on('close', (code, reason) => { client.closeCode = [code, reason.toString()]; });
  return client;
}

const checks = [];
const check = (name, ok, detail = '') => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); };
const others = (c) => [...c.awareness.getStates().entries()].filter(([id]) => id !== c.doc.clientID).map(([, s]) => s.user?.name);

const a = connect('alice');
await sleep(600);
a.doc.transact(() => a.text.insert(0, 'Hello from alice'));
await sleep(400);
const b = connect('bob', base2);
await sleep(800);
check('late joiner receives existing content', b.text.toString() === 'Hello from alice', b.text.toString());
check('awareness: bob sees alice', others(b).includes('alice'), JSON.stringify(others(b)));
check('awareness: alice sees bob', others(a).includes('bob'), JSON.stringify(others(a)));

b.doc.transact(() => b.text.insert(b.text.length, ' + bob'));
a.doc.transact(() => a.text.insert(0, '>> '));
await sleep(600);
const expected = a.text.toString();
check('concurrent edits converge on both clients', expected === b.text.toString() && expected.includes('bob') && expected.startsWith('>> '),
      `${JSON.stringify(a.text.toString())} vs ${JSON.stringify(b.text.toString())}`);

a.ws.close();
await sleep(600);
check("awareness: alice's cursor is removed when she disconnects", !others(b).includes('alice'), JSON.stringify(others(b)));
const c = connect('carol', base2);
await sleep(800);
check('third client gets the merged document', c.text.toString() === expected, c.text.toString());
console.log('FINAL_TEXT=' + JSON.stringify(expected));
b.ws.close(); c.ws.close();
await sleep(200);
process.exit(checks.every(Boolean) ? 0 : 1);
