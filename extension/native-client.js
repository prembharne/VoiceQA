import validate from '../shared/envelope-validator.js';
import { envelope, HOST_NAME, MAX_CHUNK_BYTES } from '../shared/protocol.js';

export class NativeClient {
  port = null;
  pending = new Map();
  connected = false;
  constructor(onMessage, onDisconnect) {
    this.onMessage = onMessage;
    this.onDisconnect = onDisconnect;
  }
  connect() {
    if (this.port) return;
    this.port = chrome.runtime.connectNative(HOST_NAME);
    this.port.onMessage.addListener((message) => {
      if (!validate(message)) {
        this.disconnect(new Error('Companion sent an invalid protocol envelope'));
        return;
      }
      if (message.type === 'rpc.result') {
        const p = this.pending.get(message.payload.requestId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(message.payload.requestId);
        if (message.payload.error) p.reject(new Error(message.payload.error));
        else p.resolve(message.payload.result);
      } else this.onMessage(message);
    });
    this.port.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message || 'Companion disconnected';
      this.disconnect(new Error(message));
    });
  }
  disconnect(error) {
    this.port = null;
    this.connected = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.onDisconnect(error);
  }
  send(message) {
    if (!this.port) throw new Error('Companion is not connected');
    this.port.postMessage(message);
  }
  async rpc(type, payload = {}, extra = {}) {
    this.connect();
    const message = envelope(type, payload, extra);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id);
        reject(new Error('Companion request timed out'));
      }, 120000);
      this.pending.set(message.id, { resolve, reject, timer });
      try {
        this.send(message);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(message.id);
        reject(e);
      }
    });
  }
  async upload(bytes, mime) {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const sha = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const { id } = await this.rpc('upload.begin', { size: bytes.length, mime, sha });
    let seq = 0;
    for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK_BYTES) {
      const part = bytes.subarray(offset, offset + MAX_CHUNK_BYTES);
      let binary = '';
      for (let i = 0; i < part.length; i += 8192)
        binary += String.fromCharCode(...part.subarray(i, i + 8192));
      await this.rpc('upload.chunk', { id, seq: seq++, data: btoa(binary) });
    }
    return this.rpc('upload.complete', { id });
  }
}
