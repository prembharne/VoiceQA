import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { workspaceRequest } from '../../demo/workspace-server.mjs';
let server, origin;
before(async () => {
  server = http.createServer(async (req, res) => {
    if (!(await workspaceRequest(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
async function client(path = '/?reset=1') {
  const document = await fetch(origin + path);
  const html = await document.text();
  const cookie = document.headers.get('set-cookie').split(';')[0];
  const csrf = html.match(/name="workspace-csrf" content="([^"]+)"/)[1];
  return async (path, { method = 'GET', body, token = true, key } = {}) => {
    const r = await fetch(origin + '/workspace/' + path, {
      method,
      headers: {
        Cookie: cookie,
        ...(token ? { 'X-CSRF-Token': csrf } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
}
const order = {
  customer: 'Northstar Studio',
  email: 'qa@relay.test',
  product: 'studio-display',
  quantity: 2,
  shipping: 'express',
  price: 0.01,
};
test('workspace stats and order APIs expose only the current test account', async () => {
  const api = await client();
  assert.deepEqual((await api('api/bootstrap')).body.stats, {
    orders: 5,
    revenue: 600,
    pending: 2,
  });
  assert.equal((await api('api/orders/ORD-2001')).status, 200);
  assert.equal((await api('api/orders/ORD-2002')).status, 403);
  const guest = await client('/?reset=1&guest=1');
  assert.equal((await guest('api/orders/ORD-2001')).status, 401);
  assert.deepEqual((await guest('api/bootstrap')).body.stats, {
    orders: 0,
    revenue: 0,
    pending: 0,
  });
});
test('server validates writes, rejects missing CSRF and ignores a client price', async () => {
  const api = await client();
  assert.equal(
    (await api('api/orders', { method: 'POST', body: order, token: false })).status,
    403,
  );
  assert.equal(
    (await api('api/orders', { method: 'POST', body: { ...order, quantity: 1.5 } })).status,
    422,
  );
  const created = await api('api/orders', { method: 'POST', body: order });
  assert.equal(created.status, 201);
  assert.equal(created.body.total, 255);
  assert.equal((await api('api/admin')).status, 403);
});
test('idempotency binds the same key to the same order details', async () => {
  const api = await client();
  const first = await api('api/orders', { method: 'POST', body: order, key: 'one' });
  assert.equal(first.status, 201);
  const same = await api('api/orders', { method: 'POST', body: order, key: 'one' });
  assert.equal(same.status, 200);
  assert.equal(same.body.id, first.body.id);
  const changed = await api('api/orders', {
    method: 'POST',
    body: { ...order, quantity: 3 },
    key: 'one',
  });
  assert.equal(changed.status, 409);
  assert.equal((await api('api/bootstrap')).body.stats.orders, 6);
});
test('authentication rejects invalid TOTP and preferences survive round trips', async () => {
  const api = await client('/app/auth');
  const invalid = await api('api/login', {
    method: 'POST',
    body: { username: 'qa@voiceqa.test', password: 'fixture-only', code: 'not-a-code' },
  });
  assert.equal(invalid.status, 401);
  const signedIn = await client();
  const preferences = { notifications: false, timezone: 'Asia/Kolkata' };
  assert.equal(
    (await signedIn('api/preferences', { method: 'PUT', body: preferences })).status,
    200,
  );
  assert.deepEqual((await signedIn('api/preferences')).body, preferences);
});

test('unknown API clients do not mint or receive a test session', async () => {
  const response = await fetch(origin + '/workspace/api/bootstrap');
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
  const unknown = await fetch(origin + '/workspace/api/orders', {
    headers: { Cookie: 'relay_session=unknown' },
  });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.headers.get('set-cookie'), null);
});

test('a replay returns its original order even when the sandbox is at capacity', async () => {
  const api = await client();
  const first = await api('api/orders', { method: 'POST', body: order, key: 'capacity-replay' });
  for (let i = 0; i < 93; i++)
    assert.equal((await api('api/orders', { method: 'POST', body: order })).status, 201);
  assert.equal((await api('api/orders', { method: 'POST', body: order })).status, 429);
  const replay = await api('api/orders', { method: 'POST', body: order, key: 'capacity-replay' });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, first.body.id);
});
