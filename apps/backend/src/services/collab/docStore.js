import path from 'path';
import { promises as fs } from 'fs';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { Awareness } from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { ensureDir, readJson, writeJson } from '../../utils/fsUtils.js';
import { COLLAB_FLUSH_DEBOUNCE_MS } from '../../config/constants.js';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

const docs = new Map();

function readAwarenessClients(update) {
  try {
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);
    const clients = [];
    for (let i = 0; i < count; i += 1) {
      const clientId = decoding.readVarUint(decoder);
      decoding.readVarUint(decoder);
      decoding.readVarString(decoder);
      clients.push(clientId);
    }
    return clients;
  } catch {
    return [];
  }
}

function sendMessage(conn, payload) {
  if (conn.socket.readyState !== 1) return;
  conn.socket.send(payload);
}

function broadcast(doc, payload, origin) {
  for (const conn of doc.conns) {
    if (origin && conn === origin) continue;
    sendMessage(conn, payload);
  }
}

async function flushDoc(doc) {
  const text = doc.text.toString();
  await ensureDir(path.dirname(doc.absPath));
  await fs.writeFile(doc.absPath, text, 'utf8');
  if (doc.metaPath) {
    try {
      const meta = await readJson(doc.metaPath);
      const next = { ...meta, updatedAt: new Date().toISOString() };
      await writeJson(doc.metaPath, next);
    } catch {
      // ignore
    }
  }
}

function scheduleFlush(doc) {
  if (doc.flushTimer) return;
  doc.flushTimer = setTimeout(async () => {
    doc.flushTimer = null;
    try {
      await flushDoc(doc);
    } catch (err) {
      doc.lastError = String(err);
    }
  }, COLLAB_FLUSH_DEBOUNCE_MS);
}

function registerDocHandlers(doc) {
  doc.ydoc.on('update', (update, origin) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    broadcast(doc, encoding.toUint8Array(encoder), origin);
    scheduleFlush(doc);
  });

  doc.awareness.on('update', ({ added, updated, removed }, origin) => {
    const update = awarenessProtocol.encodeAwarenessUpdate(
      doc.awareness,
      added.concat(updated).concat(removed)
    );
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, update);
    broadcast(doc, encoding.toUint8Array(encoder), origin);
  });
}

export async function getOrCreateDoc({ key, absPath, metaPath }) {
  let doc = docs.get(key);
  if (doc) return doc;
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const text = ydoc.getText('content');
  let content = '';
  try {
    content = await fs.readFile(absPath, 'utf8');
  } catch {
    content = '';
  }
  if (text.length === 0 && content) {
    text.insert(0, content);
  }
  doc = {
    key,
    absPath,
    metaPath,
    ydoc,
    awareness,
    text,
    conns: new Set(),
    flushTimer: null,
    lastError: null,
    cleanupTimer: null
  };
  registerDocHandlers(doc);
  docs.set(key, doc);
  return doc;
}

export function setupConnection(doc, socket) {
  const conn = { socket, awarenessClientIds: new Set() };
  doc.conns.add(conn);
  if (doc.cleanupTimer) {
    clearTimeout(doc.cleanupTimer);
    doc.cleanupTimer = null;
  }

  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc.ydoc);
  sendMessage(conn, encoding.toUint8Array(encoder));

  if (doc.awareness.getStates().size > 0) {
    const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(
      doc.awareness,
      Array.from(doc.awareness.getStates().keys())
    );
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(awarenessEncoder, awarenessUpdate);
    sendMessage(conn, encoding.toUint8Array(awarenessEncoder));
  }

  socket.on('message', (data) => {
    const buffer = data instanceof Buffer ? data : Buffer.from(data);
    const decoder = decoding.createDecoder(buffer);
    const messageType = decoding.readVarUint(decoder);
    if (messageType === MESSAGE_SYNC) {
      const replyEncoder = encoding.createEncoder();
      encoding.writeVarUint(replyEncoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, replyEncoder, doc.ydoc, conn);
      if (encoding.length(replyEncoder) > 1) {
        sendMessage(conn, encoding.toUint8Array(replyEncoder));
      }
      return;
    }
    if (messageType === MESSAGE_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder);
      const clients = readAwarenessClients(update);
      clients.forEach((id) => conn.awarenessClientIds.add(id));
      awarenessProtocol.applyAwarenessUpdate(doc.awareness, update, conn);
    }
  });

  socket.on('close', () => {
    doc.conns.delete(conn);
    if (conn.awarenessClientIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(conn.awarenessClientIds), conn);
    }
    if (doc.conns.size === 0) {
      doc.cleanupTimer = setTimeout(() => {
        docs.delete(doc.key);
      }, 60_000);
    }
  });

  socket.on('error', () => {
    // ignore
  });
}

export function getDocDiagnostics(key) {
  const doc = docs.get(key);
  if (!doc) return null;
  return {
    conns: doc.conns.size,
    lastError: doc.lastError
  };
}

export async function flushDocNow(key) {
  const doc = docs.get(key);
  if (!doc) return;
  await flushDoc(doc);
}
