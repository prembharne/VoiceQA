import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validCode } from './totp.mjs';
const assets = new Map(
  await Promise.all(
    [
      ['/workspace/assets/app.js', 'workspace-client.js', 'text/javascript'],
      ['/workspace/assets/app.css', 'workspace.css', 'text/css'],
    ].map(async ([url, file, type]) => [
      url,
      { body: await readFile(new URL(file, import.meta.url)), type },
    ]),
  ),
);
const html = await readFile(new URL('workspace.html', import.meta.url), 'utf8');
const sessions = new Map();
const users = {
  alice: { id: 'alice', name: 'Alice Morgan', role: 'analyst' },
  bob: { id: 'bob', name: 'Bob Chen', role: 'manager' },
};
const products = [
  { id: 'studio-display', name: 'Studio display', price: 120 },
  { id: 'usb-dock', name: 'USB-C dock', price: 80 },
  { id: 'desk-lamp', name: 'Task lamp', price: 45 },
];
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
};
const initialOrders = () =>
  Array.from({ length: 6 }, (_, i) => ({
    id: 'ORD-' + (2001 + i),
    owner: i === 1 ? 'bob' : 'alice',
    customer: [
      'Northstar Studio',
      'Cedar Labs',
      'Orbit Design',
      'Vela Collective',
      'Juniper Works',
      'Pine Agency',
    ][i],
    email: 'qa@relay.test',
    product: 'studio-display',
    quantity: 1,
    shipping: 'standard',
    total: 120,
    status: i % 3 === 0 ? 'Draft' : i % 3 === 1 ? 'Confirmed' : 'Pending',
    created: Date.now() - i * 86400000,
  }));
function reset(session, { guest = false, bug = '' } = {}) {
  Object.assign(session, {
    user: guest ? null : 'alice',
    bug: [
      'price',
      'ownership',
      'role',
      'csrf',
      'duplicate',
      'search',
      'settings',
      'async',
    ].includes(bug)
      ? bug
      : '',
    orders: new Map(initialOrders().map((o) => [o.id, o])),
    keys: new Map(),
    preferences: { notifications: true, timezone: 'UTC' },
    challenge: false,
  });
}
async function jsonBody(req) {
  let bytes = 0;
  const parts = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 8000) throw new Error('Request too large');
    parts.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('Expected an object');
  return body;
}
export async function workspaceRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const document =
    url.pathname === '/' ||
    /^\/app\/(orders|projects|settings|compatibility|security|auth|layout)$/.test(url.pathname) ||
    /^\/app\/invoices\/[A-Za-z0-9-]+$/.test(url.pathname);
  if (!document && !url.pathname.startsWith('/workspace/')) return false;
  const asset = assets.get(url.pathname);
  if (asset) {
    res.writeHead(200, { ...headers, 'Content-Type': asset.type });
    res.end(asset.body);
    return true;
  }
  const cookie = (req.headers.cookie || '')
    .split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith('relay_session='));
  let id = cookie?.slice('relay_session='.length),
    s = sessions.get(id);
  if (!s && !document) {
    res.writeHead(401, { ...headers, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session missing or expired. Reload the workspace.' }));
    return true;
  }
  if (!s) {
    id = randomUUID();
    s = { csrf: randomUUID() };
    reset(s);
    sessions.set(id, s);
    if (sessions.size > 100) sessions.delete(sessions.keys().next().value);
  }
  const reply = (status, data) => {
    res.writeHead(status, {
      ...headers,
      'Content-Type': 'application/json',
      'Set-Cookie': `relay_session=${id}; HttpOnly; SameSite=Strict; Path=/`,
    });
    res.end(JSON.stringify(data));
    return true;
  };
  if (document) {
    if (url.searchParams.get('reset') === '1' || url.pathname === '/app/auth')
      reset(s, {
        guest: url.searchParams.get('guest') === '1' || url.pathname === '/app/auth',
        bug: url.searchParams.get('bug') || '',
      });
    const marker =
      url.pathname === '/app/auth'
        ? 'voiceqa-workspace-auth-v1'
        : url.pathname === '/app/layout'
          ? 'voiceqa-workspace-layout-v1'
          : 'voiceqa-workspace-v1';
    res.writeHead(200, {
      ...headers,
      'Content-Type': 'text/html',
      'Set-Cookie': `relay_session=${id}; HttpOnly; SameSite=Strict; Path=/`,
    });
    res.end(html.replace('__FIXTURE__', marker).replace('__CSRF__', s.csrf));
    return true;
  }
  try {
    if (url.pathname === '/workspace/api/bootstrap' && req.method === 'GET') {
      const visibleOrders = [...s.orders.values()].filter((o) => o.owner === s.user);
      return reply(200, {
        user: users[s.user] || null,
        products,
        preferences: s.preferences,
        stats: {
          orders: visibleOrders.length,
          revenue: visibleOrders.reduce((n, o) => n + o.total, 0),
          pending: visibleOrders.filter((o) => o.status === 'Pending').length,
        },
      });
    }
    if (req.method !== 'GET' && req.headers['x-csrf-token'] !== s.csrf && s.bug !== 'csrf')
      return reply(403, { error: 'CSRF token required' });
    if (url.pathname === '/workspace/fixture/reset' && req.method === 'POST') {
      reset(s);
      return reply(200, { ok: true });
    }
    if (url.pathname === '/workspace/fixture/identity' && req.method === 'POST') {
      const b = await jsonBody(req);
      if (!Object.hasOwn(users, b.user)) return reply(400, { error: 'Unknown test identity' });
      s.user = b.user;
      return reply(200, { user: users[s.user] });
    }
    if (url.pathname === '/workspace/fixture/challenge' && req.method === 'POST') {
      s.challenge = true;
      return reply(200, { completed: true });
    }
    if (url.pathname === '/workspace/api/logout' && req.method === 'POST') {
      s.user = null;
      return reply(200, { signedIn: false });
    }
    if (url.pathname === '/workspace/api/login' && req.method === 'POST') {
      const b = await jsonBody(req);
      if (b.username !== 'qa@voiceqa.test' || b.password !== 'fixture-only' || !validCode(b.code))
        return reply(401, { error: 'Credentials or verification code rejected' });
      s.user = 'alice';
      return reply(200, { user: users.alice });
    }
    if (!s.user) return reply(401, { error: 'Sign in required' });
    if (url.pathname === '/workspace/api/admin' && req.method === 'GET')
      return reply(users[s.user].role === 'manager' || s.bug === 'role' ? 200 : 403, {
        allowed: users[s.user].role === 'manager' || s.bug === 'role',
      });
    if (url.pathname === '/workspace/api/preferences') {
      if (req.method === 'GET') return reply(200, s.preferences);
      if (req.method === 'PUT') {
        const b = await jsonBody(req);
        if (
          typeof b.notifications !== 'boolean' ||
          !['UTC', 'Asia/Kolkata', 'America/New_York'].includes(b.timezone)
        )
          return reply(400, { error: 'Invalid preferences' });
        if (s.bug !== 'settings')
          s.preferences = { notifications: b.notifications, timezone: b.timezone };
        return reply(200, s.preferences);
      }
    }
    if (url.pathname === '/workspace/api/orders') {
      if (req.method === 'GET') {
        // Real asynchronous response; the client must fence stale searches/navigation.
        await new Promise((r) => setTimeout(r, 180));
        const q = (url.searchParams.get('q') || '').toLowerCase(),
          status = url.searchParams.get('status') || 'all',
          sort = url.searchParams.get('sort') || 'newest';
        let items = [...s.orders.values()].filter((o) => o.owner === s.user);
        if (s.bug !== 'search')
          items = items.filter(
            (o) =>
              (!q || (o.customer + ' ' + o.id).toLowerCase().includes(q)) &&
              (status === 'all' || o.status === status),
          );
        items.sort((a, b) => (sort === 'amount' ? b.total - a.total : b.created - a.created));
        const total = items.length,
          page = Math.max(1, Math.min(100, Number(url.searchParams.get('page')) || 1));
        return reply(200, {
          items: items.slice((page - 1) * 3, page * 3),
          total,
          page,
          pages: Math.max(1, Math.ceil(total / 3)),
        });
      }
      if (req.method === 'POST') {
        const b = await jsonBody(req),
          product = products.find((p) => p.id === b.product);
        if (
          !product ||
          !Number.isInteger(b.quantity) ||
          b.quantity < 1 ||
          b.quantity > 5 ||
          !['standard', 'express'].includes(b.shipping) ||
          typeof b.customer !== 'string' ||
          b.customer.trim().length < 2 ||
          b.customer.length > 80 ||
          typeof b.email !== 'string' ||
          b.email.length > 120 ||
          !/^\S+@\S+\.\S+$/.test(b.email)
        )
          return reply(422, {
            error: 'Valid customer, email, product, quantity and shipping are required',
          });
        if (b.coupon && b.coupon !== 'WELCOME10')
          return reply(422, { error: 'Coupon not recognized' });
        const key = req.headers['idempotency-key'];
        if (key && (key.length > 100 || /[\r\n]/.test(key)))
          return reply(400, { error: 'Invalid submission key' });
        const fingerprint = JSON.stringify([
          b.customer.trim(),
          b.email,
          b.product,
          b.quantity,
          b.shipping,
          b.coupon || '',
        ]);
        if (key && s.keys.has(key) && s.bug !== 'duplicate') {
          const prior = s.keys.get(key);
          if (prior.fingerprint !== fingerprint)
            return reply(409, {
              error: 'Submission key already used with different order details',
            });
          return reply(200, s.orders.get(prior.id));
        }
        if (s.orders.size >= 100)
          return reply(429, { error: 'Reset the sandbox before creating more orders' });
        const total =
          (s.bug === 'price' ? Number(b.price) || 0.01 : product.price) *
            b.quantity *
            (b.coupon === 'WELCOME10' ? 0.9 : 1) +
          (b.shipping === 'express' ? 15 : 0);
        const order = {
          id: 'ORD-' + randomUUID().slice(0, 8),
          owner: s.user,
          customer: b.customer.trim(),
          email: b.email,
          product: product.id,
          quantity: b.quantity,
          shipping: b.shipping,
          total: Math.round(total * 100) / 100,
          status: 'Pending',
          created: Date.now(),
          readyAt: Date.now() + 600,
        };
        s.orders.set(order.id, order);
        if (key) s.keys.set(key, { id: order.id, fingerprint });
        return reply(201, order);
      }
    }
    const match = url.pathname.match(/^\/workspace\/api\/orders\/([A-Za-z0-9-]+)(\/approve)?$/);
    if (match) {
      const o = s.orders.get(match[1]);
      if (!o) return reply(404, { error: 'Order not found' });
      if (o.owner !== s.user && s.bug !== 'ownership')
        return reply(403, { error: 'This order belongs to another account' });
      if (match[2] && req.method === 'POST') {
        if (users[s.user].role !== 'manager' && s.bug !== 'role')
          return reply(403, { error: 'Manager approval required' });
        o.status = 'Approved';
        return reply(200, o);
      }
      if (!match[2] && req.method === 'GET') {
        if (o.readyAt && Date.now() >= o.readyAt && s.bug !== 'async') o.status = 'Confirmed';
        return reply(200, o);
      }
    }
    return reply(404, { error: 'Unknown workspace route' });
  } catch {
    return reply(400, { error: 'Invalid bounded JSON request' });
  }
}
