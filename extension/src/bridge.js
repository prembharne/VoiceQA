import { id } from '../../shared/protocol.js';
const port = chrome.runtime.connect({ name: 'voiceqa-panel' });
const pending = new Map();
const subscribers = new Set();
port.onMessage.addListener((message) => {
  if (message.type === 'response') {
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timer);
    message.error ? task.reject(new Error(message.error)) : task.resolve(message.result);
  } else for (const callback of subscribers) callback(message);
});
port.onDisconnect.addListener(() => {
  for (const task of pending.values()) {
    clearTimeout(task.timer);
    task.reject(new Error('Extension connection lost. Reopen the panel.'));
  }
  pending.clear();
  for (const cb of subscribers) cb({ type: 'disconnect' });
});
export function subscribe(callback) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}
export function rpc(method, payload = {}) {
  const requestId = id();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('Request timed out'));
    }, 150000);
    pending.set(requestId, { resolve, reject, timer });
    port.postMessage({ type: 'request', id: requestId, method, payload });
  });
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
