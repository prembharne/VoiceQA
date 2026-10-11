import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const html = await readFile(new URL('lab.html', import.meta.url), 'utf8');
const sessions = new Map();
const cookies = (req) =>
  Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((x) => x.trim().split('='))
      .filter((x) => x.length === 2),
  );
const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
};
async function body(req) {
  let value = '';
  for await (const chunk of req) {
    value += chunk;
    if (value.length > 8000) throw new Error('oversize');
  }
  return value ? JSON.parse(value) : {};
}
export async function labRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (!url.pathname.startsWith('/security') && url.pathname !== '/workflows') return false;
  const requestCookies = cookies(req);
  let id = requestCookies.vqa_session,
    session = sessions.get(id);
  if (!session) {
    id = randomUUID();
    session = {
      csrf: randomUUID(),
      user: null,
      orders: new Map(),
      keys: new Map(),
      bug: '',
      serial: 0,
    };
    sessions.set(id, session);
    if (sessions.size > 200) sessions.delete(sessions.keys().next().value);
  }
  const json = (status, value) => {
    res.writeHead(status, headers);
    res.end(JSON.stringify(value));
    return true;
  };
  if (url.pathname === '/security' || url.pathname === '/workflows') {
    Object.assign(session, {
      user: null,
      bug: ['idor', 'price', 'role', 'csrf', 'idempotency'].includes(url.searchParams.get('bug'))
        ? url.searchParams.get('bug')
        : '',
      orders: new Map([
        ['alice-order', { id: 'alice-order', owner: 'alice', total: 12 }],
        ['bob-order', { id: 'bob-order', owner: 'bob', total: 12 }],
      ]),
      keys: new Map(),
      serial: 0,
    });
    res.writeHead(200, {
      ...headers,
      'Content-Type': 'text/html',
      'Set-Cookie': [
        `vqa_session=${id}; Path=/; HttpOnly; SameSite=Strict`,
        'vqa_client_role=; Path=/; Max-Age=0; SameSite=Strict',
      ],
    });
    res.end(
      html
        .replace('__CSRF__', session.csrf)
        .replace(
          '__FIXTURE__',
          url.pathname === '/workflows' ? 'voiceqa-workflow-v1' : 'voiceqa-security-v1',
        ),
    );
    return true;
  }
  try {
    if (url.pathname === '/security/fixture-login' && req.method === 'POST') {
      const input = await body(req);
      if (!['alice', 'bob'].includes(input.user))
        return json(400, { error: 'Unknown fixture account' });
      session.user = input.user;
      session.bearer = randomUUID();
      return json(200, { user: input.user, accessToken: session.bearer });
    }
    if (!session.user) return json(401, { error: 'Authentication required' });
    if (url.pathname === '/security/api/admin')
      return session.bug === 'role' && requestCookies.vqa_client_role === 'admin'
        ? json(200, { authorized: true })
        : json(403, { error: 'Forbidden' });
    if (url.pathname === '/security/api/transfer' && req.method === 'POST') {
      await body(req);
      return session.bug === 'csrf' || req.headers['x-csrf-token'] === session.csrf
        ? json(200, { accepted: true })
        : json(403, { error: 'CSRF verification required' });
    }
    if (url.pathname === '/security/api/orders' && req.method === 'POST') {
      const input = await body(req);
      const quantity = Number(input.quantity);
      if (input.sku !== 'studio-mug' || !Number.isInteger(quantity) || quantity < 1 || quantity > 5)
        return json(422, { error: 'Invalid test order' });
      const key = req.headers['idempotency-key'];
      if (key && session.keys.has(key) && session.bug !== 'idempotency')
        return json(200, session.orders.get(session.keys.get(key)));
      const price = session.bug === 'price' && typeof input.price === 'number' ? input.price : 12;
      const order = {
        id: `${session.user}-created-${++session.serial}-${randomUUID()}`,
        owner: session.user,
        total: price * quantity,
      };
      session.orders.set(order.id, order);
      if (key) session.keys.set(key, order.id);
      return json(201, order);
    }
    if (url.pathname.startsWith('/security/api/bearer/orders/') && req.method === 'GET') {
      if (req.headers.authorization !== `Bearer ${session.bearer}`)
        return json(401, { error: 'Bearer authentication required' });
      const order = session.orders.get(
        decodeURIComponent(url.pathname.slice('/security/api/bearer/orders/'.length)),
      );
      if (!order) return json(404, { error: 'Order not found' });
      if (order.owner !== session.user && session.bug !== 'idor')
        return json(403, { error: 'Forbidden' });
      return json(200, order);
    }
    if (url.pathname.startsWith('/security/api/orders/') && req.method === 'GET') {
      const order = session.orders.get(
        decodeURIComponent(url.pathname.slice('/security/api/orders/'.length)),
      );
      if (!order) return json(404, { error: 'Order not found' });
      if (order.owner !== session.user && session.bug !== 'idor')
        return json(403, { error: 'Forbidden' });
      return json(200, order);
    }
    return json(404, { error: 'Unknown fixture route' });
  } catch {
    return json(400, { error: 'Invalid fixture request' });
  }
}
