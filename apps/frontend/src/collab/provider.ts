import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export type CollabStatus = 'disconnected' | 'connecting' | 'connected';

/** Why the server ended the session for good: the file was renamed (`to` is its new path) or deleted. */
export type CollabClosed = { reason: 'renamed' | 'deleted'; path: string; to: string | null };
/** Close code for "this file is gone"; the server sends a CollabClosed text frame first. Never reconnect after it. */
const CLOSE_FILE_GONE = 4404;

type ProviderOptions = {
  serverUrl: string;
  /** The credential, or a function returning it (or a promise of it). A function is called on every (re)connect, so it
   * can fetch a fresh URL token. */
  token?: string | (() => string | Promise<string>);
  projectId: string;
  filePath: string;
  doc: Y.Doc;
  awareness: Awareness;
  onStatus?: (status: CollabStatus) => void;
  onError?: (error: string) => void;
  onClosed?: (info: CollabClosed) => void;
};

export class CollabProvider {
  private serverUrl: string;
  private token: string | (() => string | Promise<string>);
  private projectId: string;
  private filePath: string;
  private doc: Y.Doc;
  private awareness: Awareness;
  private ws: WebSocket | null = null;
  private shouldReconnect = false;
  /** bumped by connect/disconnect, so a socket whose token arrives after either is not opened */
  private generation = 0;
  private reconnectAttempts = 0;
  private onStatus?: (status: CollabStatus) => void;
  private onError?: (error: string) => void;
  private onClosed?: (info: CollabClosed) => void;
  private docUpdateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;
  private awarenessUpdateHandler:
    | ((update: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void)
    | null = null;

  constructor(options: ProviderOptions) {
    this.serverUrl = options.serverUrl.replace(/\/$/, '');
    this.token = options.token || '';
    this.projectId = options.projectId;
    this.filePath = options.filePath;
    this.doc = options.doc;
    this.awareness = options.awareness;
    this.onStatus = options.onStatus;
    this.onError = options.onError;
    this.onClosed = options.onClosed;
  }

  connect() {
    this.generation += 1;
    this.shouldReconnect = true;
    void this.openWebSocket();
    this.attachDocListeners();
  }

  disconnect() {
    this.generation += 1;
    this.shouldReconnect = false;
    this.detachDocListeners();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    } else if (this.ws) {
      this.ws.close();
    }
    this.ws = null;
    this.onStatus?.('disconnected');
  }

  updateUser(user: { name: string; color: string }) {
    this.awareness.setLocalStateField('user', user);
  }

  private attachDocListeners() {
    if (this.docUpdateHandler) return;
    this.docUpdateHandler = (update, origin) => {
      if (origin === this) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.ws.send(encoding.toUint8Array(encoder));
    };
    this.awarenessUpdateHandler = ({ added, updated, removed }, origin) => {
      if (origin === this) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const update = awarenessProtocol.encodeAwarenessUpdate(
        this.awareness,
        added.concat(updated).concat(removed)
      );
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, update);
      this.ws.send(encoding.toUint8Array(encoder));
    };
    this.doc.on('update', this.docUpdateHandler);
    this.awareness.on('update', this.awarenessUpdateHandler);
  }

  private detachDocListeners() {
    if (this.docUpdateHandler) {
      this.doc.off('update', this.docUpdateHandler);
      this.docUpdateHandler = null;
    }
    if (this.awarenessUpdateHandler) {
      this.awareness.off('update', this.awarenessUpdateHandler);
      this.awarenessUpdateHandler = null;
    }
  }

  private scheduleReconnect() {
    if (!this.shouldReconnect) return;
    const retryDelay = Math.min(10_000, 800 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts += 1;
    window.setTimeout(() => void this.openWebSocket(), retryDelay);
  }

  private async openWebSocket() {
    if (!this.serverUrl) {
      this.onError?.('Missing server url');
      return;
    }
    const wsBase = this.serverUrl.replace(/^http/, 'ws');
    const qs = new URLSearchParams({
      projectId: this.projectId,
      file: this.filePath
    });
    const generation = this.generation;
    let token: string;
    try {
      token = await (typeof this.token === 'function' ? this.token() : this.token);
    } catch {
      this.onStatus?.('disconnected');
      this.scheduleReconnect(); // could not get a token (offline, signed out): try again later
      return;
    }
    if (!this.shouldReconnect || generation !== this.generation) return; // disconnected (or reconnected) meanwhile
    if (token) {
      qs.set('token', token);
    }
    const wsUrl = `${wsBase}/api/collab?${qs.toString()}`;
    this.onStatus?.('connecting');
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    let closedInfo: CollabClosed | null = null;
    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.onStatus?.('connected');
      const syncEncoder = encoding.createEncoder();
      encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(syncEncoder, this.doc);
      ws.send(encoding.toUint8Array(syncEncoder));
      const localState = this.awareness.getLocalState();
      if (localState) {
        this.awareness.setLocalState(localState);
      }
    };
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data) as { type?: string } & CollabClosed;
          if (message.type === 'closed') closedInfo = { reason: message.reason, path: message.path, to: message.to ?? null };
        } catch {
          // not ours: ignore
        }
        return;
      }
      if (event.data instanceof Blob) {
        event.data.arrayBuffer().then((buffer) => this.handleMessage(ws, new Uint8Array(buffer)));
        return;
      }
      this.handleMessage(ws, new Uint8Array(event.data));
    };
    ws.onerror = () => {
      this.onError?.('WebSocket error');
    };
    ws.onclose = (event) => {
      if (generation !== this.generation) return; // a socket we already left
      this.onStatus?.('disconnected');
      if (event.code === CLOSE_FILE_GONE) {
        this.shouldReconnect = false;
        this.onClosed?.(closedInfo || { reason: 'deleted', path: this.filePath, to: null });
        return;
      }
      this.scheduleReconnect();
    };
    this.ws = ws;
  }

  private handleMessage(ws: WebSocket, data: Uint8Array) {
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);
    if (messageType === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (encoding.length(encoder) > 1) {
        ws.send(encoding.toUint8Array(encoder));
      }
      return;
    }
    if (messageType === MESSAGE_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder);
      awarenessProtocol.applyAwarenessUpdate(this.awareness, update, this);
    }
  }
}
