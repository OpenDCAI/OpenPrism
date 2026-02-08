import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export type CollabStatus = 'disconnected' | 'connecting' | 'connected';

type ProviderOptions = {
  serverUrl: string;
  token?: string;
  projectId: string;
  filePath: string;
  doc: Y.Doc;
  awareness: Awareness;
  onStatus?: (status: CollabStatus) => void;
  onError?: (error: string) => void;
};

export class CollabProvider {
  private serverUrl: string;
  private token: string;
  private projectId: string;
  private filePath: string;
  private doc: Y.Doc;
  private awareness: Awareness;
  private ws: WebSocket | null = null;
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private onStatus?: (status: CollabStatus) => void;
  private onError?: (error: string) => void;
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
  }

  connect() {
    this.shouldReconnect = true;
    this.openWebSocket();
    this.attachDocListeners();
  }

  disconnect() {
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

  private openWebSocket() {
    if (!this.serverUrl) {
      this.onError?.('Missing server url');
      return;
    }
    const wsBase = this.serverUrl.replace(/^http/, 'ws');
    const qs = new URLSearchParams({
      projectId: this.projectId,
      file: this.filePath
    });
    if (this.token) {
      qs.set('token', this.token);
    }
    const wsUrl = `${wsBase}/api/collab?${qs.toString()}`;
    this.onStatus?.('connecting');
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.onStatus?.('connected');
      const localState = this.awareness.getLocalState();
      if (localState) {
        this.awareness.setLocalState(localState);
      }
    };
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') return;
      if (event.data instanceof Blob) {
        event.data.arrayBuffer().then((buffer) => this.handleMessage(ws, new Uint8Array(buffer)));
        return;
      }
      this.handleMessage(ws, new Uint8Array(event.data));
    };
    ws.onerror = () => {
      this.onError?.('WebSocket error');
    };
    ws.onclose = () => {
      this.onStatus?.('disconnected');
      if (this.shouldReconnect) {
        const retryDelay = Math.min(10_000, 800 * Math.pow(2, this.reconnectAttempts));
        this.reconnectAttempts += 1;
        window.setTimeout(() => this.openWebSocket(), retryDelay);
      }
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
