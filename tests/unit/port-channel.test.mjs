import test from 'node:test';
import assert from 'node:assert/strict';
import { PortChannel } from '../../shared/port-channel.js';
import { nativeTimeout, panelTimeout } from '../../shared/request-timeouts.js';
function event() {
  const listeners = [];
  return {
    addListener: (callback) => listeners.push(callback),
    emit: (value) => listeners.forEach((callback) => callback(value)),
  };
}
function port() {
  return {
    onMessage: event(),
    onDisconnect: event(),
    sent: [],
    closed: false,
    postMessage(message) {
      if (this.closed) throw new Error('Attempting to use a disconnected port object');
      this.sent.push(message);
    },
    disconnect() {
      this.closed = true;
      this.onDisconnect.emit();
    },
  };
}
function fixture() {
  const ports = [];
  let count = 0;
  const channel = new PortChannel({
    createPort: () => {
      const p = port();
      ports.push(p);
      return p;
    },
    makeRequest: (type, payload) => ({ id: String(++count), type, payload }),
    responseID: (message) => message.id,
    timeout: 1000,
  });
  return { ports, channel };
}
test('a synchronous stale-port send clears the port and the next request reconnects', async () => {
  const { ports, channel } = fixture();
  channel.open();
  ports[0].closed = true;
  await assert.rejects(channel.request('hello'), /disconnected port/);
  assert.equal(channel.port, null);
  assert.equal(channel.pending.size, 0);
  const retry = channel.request('hello');
  ports[1].onMessage.emit({ id: '2', result: { ready: true } });
  assert.deepEqual(await retry, { ready: true });
  assert.equal(ports[1].sent.length, 1);
});
test('late disconnect events from an old generation cannot close a new connection', async () => {
  const { ports, channel } = fixture();
  const first = channel.request('hello');
  ports[0].disconnect();
  await assert.rejects(first, /interrupted/);
  const second = channel.request('hello');
  ports[0].onDisconnect.emit();
  assert.equal(channel.port, ports[1]);
  ports[1].onMessage.emit({ id: '2', result: 'connected' });
  assert.equal(await second, 'connected');
});
test('disconnected mutating requests are rejected and never replayed', async () => {
  const { ports, channel } = fixture();
  const action = channel.request('run.start');
  ports[0].disconnect();
  await assert.rejects(action);
  const hello = channel.request('hello');
  assert.deepEqual(
    ports[1].sent.map((m) => m.type),
    ['hello'],
  );
  ports[1].onMessage.emit({ id: '2', result: 'ready' });
  await hello;
});
test('planning deadlines outlive the companion while ordinary methods keep their limits', () => {
  assert.ok(nativeTimeout('plan.propose') > 300000);
  assert.ok(panelTimeout('plan.propose') > nativeTimeout('plan.propose'));
  for (const method of ['hello', 'audio.complete', 'run.start', 'speech.synthesize']) {
    assert.equal(nativeTimeout(method), 120000);
    assert.equal(panelTimeout(method), 150000);
  }
});
test('a short request expiring does not interrupt a longer planning request', async () => {
  const { ports, channel } = fixture();
  channel.timeout = (type) => (type === 'plan.propose' ? 2000 : 10);
  const planning = channel.request('plan.propose');
  await assert.rejects(channel.request('hello'), /timed out/);
  assert.equal(channel.pending.size, 1);
  ports[0].onMessage.emit({ id: '1', result: { draft: true } });
  assert.deepEqual(await planning, { draft: true });
});
