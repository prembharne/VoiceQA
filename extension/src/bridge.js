import { id } from '../../shared/protocol.js';
import { PortChannel } from '../../shared/port-channel.js';
const subscribers = new Set();
const channel = new PortChannel({
  createPort: () => chrome.runtime.connect({ name: 'voiceqa-panel' }),
  makeRequest: (method, payload) => ({ type: 'request', id: id(), method, payload }),
  responseID: (message) => (message.type === 'response' ? message.id : null),
  lastError: () => chrome.runtime.lastError?.message || '',
  timeout: 150000,
  onMessage: (message) => {
    for (const callback of subscribers) callback(message);
  },
  onDisconnect: (error) => {
    for (const callback of subscribers) callback({ type: 'disconnect', error: error.message });
  },
});
channel.open();
export function subscribe(callback) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}
export function rpc(method, payload = {}) {
  return channel.request(method, payload);
}
export async function artifact(id) {
  let offset = 0;
  const parts = [];
  while (true) {
    const r = await rpc('artifact.get', { id, offset });
    parts.push(Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)));
    offset = r.next;
    if (r.done) break;
  }
  return new Blob(parts);
}
