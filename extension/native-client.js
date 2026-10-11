import validate from '../shared/envelope-validator.js';
import { envelope, HOST_NAME, MAX_CHUNK_BYTES } from '../shared/protocol.js';
import { PortChannel } from '../shared/port-channel.js';
import { nativeTimeout } from '../shared/request-timeouts.js';

export class NativeClient {
  connected = false;
  constructor(onMessage, onDisconnect) {
    this.onMessage = onMessage;
    this.onDisconnect = onDisconnect;
    this.channel = new PortChannel({
      createPort: () => chrome.runtime.connectNative(HOST_NAME),
      makeRequest: envelope,
      timeout: nativeTimeout,
      responseID: (message) => (message.type === 'rpc.result' ? message.payload.requestId : null),
      validate,
      lastError: () => chrome.runtime.lastError?.message || '',
      onMessage,
      onDisconnect: (error) => {
        this.connected = false;
        return onDisconnect(error);
      },
    });
  }
  connect() {
    this.channel.open();
  }
  get port() {
    return this.channel.port;
  }
  disconnect(error) {
    this.channel.drop(error);
  }
  send(message) {
    this.channel.send(message);
  }
  async rpc(type, payload = {}, extra = {}) {
    return this.channel.request(type, payload, extra);
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
