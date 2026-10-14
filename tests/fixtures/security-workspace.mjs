// Owned, server-backed security acceptance app. No VoiceQA fixture metadata.
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const brokenOwnership = process.argv.includes('--broken-ownership');
const sessions = new Map();
const accounts = {
  'alice@parcel.test': {
    id: 'alice',
    tenant: 'north',
    role: 'member',
    password: 'synthetic-owner-password',
  },
  'manager@parcel.test': {
    id: 'manager',
    tenant: 'north',
    role: 'manager',
    password: 'synthetic-manager-password',
  },
};
const equal = (a, b) => {
  const left = Buffer.from(String(a)),
    right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};
function establish(res, account, workspace) {
  const id = randomBytes(20).toString('hex');
  const session = { account, workspace, csrf: randomBytes(20).toString('hex') };
  sessions.set(id, session);
  res.setHeader('Set-Cookie', `parcel_session=${id}; HttpOnly; SameSite=Strict; Path=/`);
  return session;
}
function session(req, res) {
  const id = /(?:^|;\s*)parcel_session=([a-f0-9]{40})/.exec(req.headers.cookie || '')?.[1];
  if (id && sessions.has(id)) return { id, value: sessions.get(id) };
  if (sessions.size > 100) sessions.delete(sessions.keys().next().value);
  const workspace = {
    orders: new Map([
      [
        'OA1001',
        {
          id: 'OA1001',
          owner: 'alice',
          tenant: 'north',
          sku: 'standard',
          quantity: 2,
          total: 70,
          status: 'draft',
        },
      ],
      [
        'OB2002',
        {
          id: 'OB2002',
          owner: 'bob',
          tenant: 'south',
          sku: 'standard',
          quantity: 1,
          total: 35,
          status: 'draft',
        },
      ],
    ]),
    idempotency: new Map(),
    events: [],
    creations: 0,
  };
  return { id: null, value: establish(res, accounts['alice@parcel.test'], workspace) };
}
function html(s, guide) {
  const content = guide
    ? `<h1>ParcelGate API guide</h1>
<p>This sandbox starts signed in as Alice, a North member. The saved owner and manager test profiles can switch accounts using the sign-in form. Account roles are verified on the server, not taken from request fields.</p>
<h2>Security requirements</h2><ul>
<li>GET /api/me returns the current role and account ID.</li>
<li>GET /api/orders/OA1001 returns the North order with HTTP 200. GET /api/orders/OB2002 must return HTTP 403 for North accounts: that order belongs to South. UI filtering alone does not prove this boundary.</li>
<li>POST /api/orders/OA1001/approve requires a North manager and a valid CSRF token: members receive 403, managers receive 200 and status approved. Repeating an authorized approval returns 200.</li>
<li>POST /api/orders creates a Standard order. Standard costs $35 per unit, quantity is 1–5. Invalid sku or quantity receives HTTP 422. The server ignores caller-supplied unitPrice and total fields and calculates its own total.</li>
<li>All POST requests require X-CSRF-Token from the csrf-token meta element. Missing token returns 403. Valid writes need a positive control.</li>
<li>Order creation requires an Idempotency-Key header (1–80 letters, digits, dash or underscore). Same key and same payload returns the same order ID with HTTP 201 and creates nothing extra. Same key with different payload returns 409.</li>
<li>A successful create response is {id,sku,quantity,total,status}. GET /api/orders/ORDER_ID returns those details. GET /api/orders returns the accessible orders and createdCount.</li>
</ul><p>Example public create payload: {"sku":"standard","quantity":2,"unitPrice":1}. It must still total $70. No real purchase or payment occurs.</p><a href="/">Return to workspace</a>`
    : `<h1>ParcelGate Orders</h1>
<p>Owned synthetic workspace. You start as Alice, a North member. Every transaction is test data. Use the API guide to discover expected server behavior.</p>
<a href="/guide">API guide and security requirements</a>
<h2>Current account</h2><output id="account-status" role="status"></output>
<form id="sign-in"><label>Account email<input id="account-email" type="email" autocomplete="username" required></label><label>Account password<input id="account-password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form>
<p id="sign-in-error" role="alert"></p>
<h2>Your North order</h2><output id="order-summary" role="status"></output>
<p>Standard costs $35 per unit. The seeded North order contains two units.</p>
<button id="approve">Approve North order</button><p id="approval-status" role="status"></p>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>ParcelGate ${guide ? 'API guide' : 'Orders'}</title><meta name="csrf-token" content="${s.csrf}">
<style>body{font:16px system-ui;background:#f5f7fb;color:#172a42;margin:40px;max-width:920px;line-height:1.65}label{display:block;margin:16px 0}input,button{font:inherit;padding:10px}output{display:block}li{margin:14px 0}a{color:#224fab}</style>${content}
<script>
const csrf=document.querySelector('meta[name=csrf-token]').content;
async function post(url,body){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)})}
async function refresh(){const me=await fetch('/api/me').then(r=>r.json());document.querySelector('#account-status').textContent='Account '+me.id+' | North | '+me.role;const order=await fetch('/api/orders/OA1001').then(r=>r.json());document.querySelector('#order-summary').textContent='Order '+order.id+' | '+order.quantity+' Standard units | $'+order.total.toFixed(2)+' | '+order.status}
if(document.querySelector('#sign-in')){refresh();document.querySelector('#sign-in').onsubmit=async e=>{e.preventDefault();const r=await post('/api/sign-in',{email:document.querySelector('#account-email').value,password:document.querySelector('#account-password').value});if(r.ok)location.assign('/');else document.querySelector('#sign-in-error').textContent='Sign-in rejected'};document.querySelector('#approve').onclick=async()=>{const r=await post('/api/orders/OA1001/approve',{});document.querySelector('#approval-status').textContent=r.ok?'Order approved':'Manager role required';await refresh()}}
</script></html>`;
}

const server = http.createServer(async (req, res) => {
  const current = session(req, res),
    s = current.value;
  const path = new URL(req.url, 'http://127.0.0.1:4180').pathname;
  const send = (status, body) => {
    s.workspace.events.push({
      method: req.method,
      path,
      status,
      actor: s.account.id,
      role: s.account.role,
      csrfAccepted: req.method !== 'POST' ? undefined : req.headers['x-csrf-token'] === s.csrf,
    });
    if (s.workspace.events.length > 200) s.workspace.events.shift();
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && ['/', '/guide'].includes(path)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html(s, path === '/guide'));
    return;
  }
  if (req.method === 'GET' && path === '/api/me') {
    send(200, { id: s.account.id, role: s.account.role });
    return;
  }
  if (req.method === 'GET' && path === '/api/testing-state') {
    send(200, {
      creations: s.workspace.creations,
      events: s.workspace.events,
      orders: [...s.workspace.orders.values()].filter((o) => o.tenant === 'north'),
    });
    return;
  }
  if (req.method === 'GET' && path === '/api/orders') {
    send(200, {
      orders: [...s.workspace.orders.values()].filter((o) => o.tenant === s.account.tenant),
      createdCount: s.workspace.creations,
    });
    return;
  }
  if (req.method === 'POST') {
    if (req.headers['x-csrf-token'] !== s.csrf) {
      send(403, { error: 'CSRF required' });
      return;
    }
    let text = '';
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 4096) {
        send(413, { error: 'Body too large' });
        return;
      }
    }
    let body;
    try {
      body = JSON.parse(text || '{}');
    } catch {
      send(400, { error: 'Invalid JSON' });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      send(422, { error: 'Object required' });
      return;
    }
    if (path === '/api/sign-in') {
      const account = accounts[body.email];
      if (!account || !equal(body.password, account.password)) {
        send(401, { error: 'Credentials rejected' });
        return;
      }
      establish(res, account, s.workspace);
      if (current.id) sessions.delete(current.id);
      send(200, { signedIn: true });
      return;
    }
    if (path === '/api/orders') {
      if (
        body.sku !== 'standard' ||
        !Number.isInteger(body.quantity) ||
        body.quantity < 1 ||
        body.quantity > 5
      ) {
        send(422, { error: 'Invalid order' });
        return;
      }
      const key = req.headers['idempotency-key'];
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(key || '')) {
        send(400, { error: 'Idempotency-Key required' });
        return;
      }
      const identity = s.account.tenant + ':' + key;
      const fingerprint = JSON.stringify(
        Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b))),
      );
      const prior = s.workspace.idempotency.get(identity);
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          send(409, { error: 'Key payload conflict' });
          return;
        }
        send(201, s.workspace.orders.get(prior.id));
        return;
      }
      const order = {
        id: 'PC' + randomBytes(4).toString('hex'),
        owner: s.account.id,
        tenant: s.account.tenant,
        sku: 'standard',
        quantity: body.quantity,
        total: body.quantity * 35,
        status: 'draft',
      };
      s.workspace.orders.set(order.id, order);
      s.workspace.idempotency.set(identity, { id: order.id, fingerprint });
      s.workspace.creations++;
      send(201, order);
      return;
    }
    const approval = /^\/api\/orders\/([A-Za-z0-9]+)\/approve$/.exec(path);
    if (approval) {
      const order = s.workspace.orders.get(approval[1]);
      if (!order || order.tenant !== s.account.tenant || s.account.role !== 'manager') {
        send(403, { error: 'Manager required in owning tenant' });
        return;
      }
      order.status = 'approved';
      send(200, { status: order.status });
      return;
    }
  }
  const orderPath = /^\/api\/orders\/([A-Za-z0-9]+)$/.exec(path);
  if (req.method === 'GET' && orderPath) {
    const order = s.workspace.orders.get(orderPath[1]);
    if (!order) {
      send(404, { error: 'Not found' });
      return;
    }
    if (!brokenOwnership && order.tenant !== s.account.tenant) {
      send(403, { error: 'Other tenant' });
      return;
    }
    send(200, order);
    return;
  }
  send(404, { error: 'Not found' });
});
server.listen(4180, '127.0.0.1', () =>
  console.log(`Owned ParcelGate app on 4180 (broken ownership: ${brokenOwnership})`),
);
