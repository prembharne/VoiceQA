const main = document.querySelector('main'),
  dialog = document.querySelector('#order-dialog');
const csrf = document.querySelector('meta[name=workspace-csrf]').content;
const esc = (v) =>
  String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
const money = (v) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
let boot,
  generation = 0,
  pageController,
  searchTimer,
  toastTimer,
  wizardStep = 0,
  submitting = false;
let orderData = {},
  orderKey = '',
  table = { q: '', status: 'all', sort: 'newest', page: 1 };
const request = async (path, { method = 'GET', body, signal, key } = {}) => {
  const r = await fetch('/workspace/' + path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: {
      ...(method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await r.json();
  if (!r.ok) throw Object.assign(new Error(result.error || 'Request failed'), { status: r.status });
  return result;
};
function toast(message) {
  clearTimeout(toastTimer);
  const box = document.querySelector('#toast');
  box.textContent = message;
  box.hidden = false;
  toastTimer = setTimeout(() => (box.hidden = true), 3500);
}
function identity() {
  document.querySelector('#identity').textContent = boot.user?.name || 'Guest account';
}
function heading(title, description, action = '') {
  return `<div class="page-heading"><div><p class="eyebrow">NORTHSTAR WORKSPACE</p><h1>${esc(title)}</h1><p>${esc(description)}</p></div>${action}</div>`;
}
const newOrderButton =
  '<button class="button primary" data-command="new-order" data-testid="new-order"><span aria-hidden="true">+</span> New order</button>';
function nav(path) {
  if (location.pathname !== path) history.pushState({}, '', path);
  return render();
}
async function render() {
  clearTimeout(searchTimer);
  const id = ++generation;
  pageController?.abort();
  pageController = new AbortController();
  const path = location.pathname;
  let view = path.split('/')[2] || 'overview';
  if (view === 'layout') view = 'overview';
  document.querySelector('meta[name=voiceqa-fixture]').content =
    path === '/app/auth'
      ? 'voiceqa-workspace-auth-v1'
      : path === '/app/layout'
        ? 'voiceqa-workspace-layout-v1'
        : 'voiceqa-workspace-v1';
  document.querySelector('#breadcrumb').textContent = view.charAt(0).toUpperCase() + view.slice(1);
  document.querySelectorAll('[data-nav]').forEach((a) => {
    if (a.dataset.nav === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  main.setAttribute('aria-busy', 'true');
  try {
    boot = await request('api/bootstrap', { signal: pageController.signal });
    if (id !== generation) return;
    identity();
    document.querySelector('.nav-count').textContent = String(boot.stats.orders);
    if (view === 'overview') {
      main.innerHTML =
        heading(
          boot.user ? `Good morning, ${boot.user.name.split(' ')[0]}` : 'Welcome to RelayDesk',
          'Here’s what’s happening across your operations today.',
          newOrderButton,
        ) +
        `<div class="stats"><article class="stat"><p class="stat-label">Order volume</p><div class="stat-value" data-testid="order-volume">${boot.stats.orders}</div><span class="stat-note">Across the sandbox workspace</span></article><article class="stat"><p class="stat-label">Order value</p><div class="stat-value">${money(boot.stats.revenue)}</div><span class="stat-note">Calculated on the server</span></article><article class="stat"><p class="stat-label">Awaiting approval</p><div class="stat-value">${boot.stats.pending}</div><span class="stat-note">Manager review required</span></article><article class="stat"><p class="stat-label">Projects active</p><div class="stat-value">3</div><span class="stat-note">All teams on track</span></article></div><div class="dashboard-grid"><section class="card"><div class="card-header"><h2>Order activity</h2><small>Sample six-week trend</small></div><div class="card-body"><div class="revenue-label"><strong>${money(boot.stats.revenue)}</strong><span>Sandbox order value</span></div><div class="chart" role="img" aria-label="Sample order activity increases across six weeks"><div class="bar-1"></div><div class="bar-2"></div><div class="bar-3"></div><div class="bar-4"></div><div class="bar-5"></div><div class="bar-6"></div></div><div class="chart-labels"><span>Week 1</span><span>Week 2</span><span>Week 3</span><span>Week 4</span><span>Week 5</span><span>Week 6</span></div></div></section><section class="card"><div class="card-header"><h2>Recent activity</h2><small>Workspace feed</small></div><div class="card-body">${[
          ['N', 'Northstar Studio placed an order', 'Today · Orders'],
          ['C', 'Cedar Labs needs approval', 'Today · Approvals'],
          ['V', 'Vela project moved forward', 'Yesterday · Projects'],
        ]
          .map(
            ([icon, text, sub]) =>
              `<div class="activity-item"><span class="activity-icon" aria-hidden="true">${icon}</span><div><p>${text}</p><small>${sub}</small></div></div>`,
          )
          .join(
            '',
          )}</div></section></div><section class="testing-banner"><div><p class="eyebrow">BUILT FOR YOUR NEXT TEST</p><h3>A real workflow. More ways to break it.</h3><p>Explore forms, asynchronous updates, session checks and multi-tab invoices.</p></div><a class="button secondary" href="/app/compatibility">Open compatibility lab <span aria-hidden="true">→</span></a></section>`;
    } else if (view === 'orders') {
      table = { q: '', status: 'all', sort: 'newest', page: 1 };
      main.innerHTML =
        heading('Orders', 'Search, review and track your customer orders.', newOrderButton) +
        `<section class="card"><div class="toolbar"><label>Search orders<input type="search" data-testid="order-search" id="order-search" placeholder="Customer name or order ID"></label><label>Status<select id="order-filter" data-testid="order-filter"><option value="all">All statuses</option><option value="Draft">Draft</option><option value="Pending">Pending</option><option value="Confirmed">Confirmed</option></select></label><label>Sort by<select id="order-sort" data-testid="order-sort"><option value="newest">Newest first</option><option value="amount">Highest amount</option></select></label></div><div id="orders-content" aria-live="polite"></div></section>`;
      await loadOrders(id);
    } else if (view === 'projects') {
      main.innerHTML =
        heading('Projects', 'A shared view of your team’s active work.') +
        `<div class="project-grid">${[
          ['Workspace refresh', 'Design system & onboarding', 'Design team'],
          ['Spring launch', 'Customer rollout & operations', 'Operations team'],
          ['Customer portal', 'Order tracking & approvals', 'Platform team'],
        ]
          .map(
            ([name, desc, team]) =>
              `<article class="card project"><span class="status confirmed">On track</span><h2>${name}</h2><p>${desc}</p><div class="progress-line" role="img" aria-label="Sample project progress: 65 percent"></div><small>${team} · Sample progress 65%</small><a class="button secondary" href="/app/orders">View related orders</a></article>`,
          )
          .join('')}</div>`;
    } else if (view === 'settings') {
      main.innerHTML =
        heading(
          'Workspace settings',
          'Preferences are saved on the server and survive navigation.',
        ) +
        `<form id="settings-form" class="card settings-card"><h2>Notifications & regional preferences</h2><label class="check-label"><input type="checkbox" data-testid="notifications" id="notifications" ${boot.preferences.notifications ? 'checked' : ''}><span>Order notifications<small>Receive a workspace update when an order is confirmed.</small></span></label><label>Time zone<select id="timezone" data-testid="timezone">${[
          ['UTC', 'UTC'],
          ['Asia/Kolkata', 'India · Asia/Kolkata'],
          ['America/New_York', 'New York · America/New_York'],
        ]
          .map(
            ([v, l]) =>
              `<option value="${v}" ${boot.preferences.timezone === v ? 'selected' : ''}>${l}</option>`,
          )
          .join(
            '',
          )}</select></label><button type="submit" class="button primary" data-testid="save-settings">Save preferences</button><p role="status" data-testid="settings-result" id="settings-result"></p></form>`;
    } else if (view === 'compatibility') {
      main.innerHTML =
        heading(
          'Compatibility lab',
          'Choose a scenario, share this tab in VoiceQA, then review its demo suite.',
        ) +
        `<div class="scenario-grid">${[
          [
            '01',
            'Application workflows',
            'Order wizard, validation, async search, settings persistence, API evidence and an invoice in a separate tab.',
            '/',
            'Open application suite',
          ],
          [
            '02',
            'Responsive layout',
            'Run layout and accessibility checks at desktop and mobile widths.',
            '/app/layout',
            'Open responsive suite',
          ],
          [
            '03',
            'Authentication',
            'Saved credentials, server-verified TOTP and an operator checkpoint for a synthetic challenge.',
            '/app/auth',
            'Open authentication suite',
          ],
          [
            '04',
            'Logical security',
            'Positive and negative server controls for ownership, roles, CSRF, trusted pricing and idempotency.',
            '/app/security',
            'Open security suite',
          ],
        ]
          .map(
            ([n, title, desc, url, label]) =>
              `<article class="card scenario"><p class="eyebrow">SCENARIO ${n}</p><h2>${title}</h2><p>${desc}</p><a class="button secondary" href="${url}">${label}</a></article>`,
          )
          .join(
            '',
          )}</div><section class="card coverage"><h2>What compatibility means here</h2><ul><li>Tests execute the real extension, Go companion, DOM actions and server requests.</li><li>The demo suite is deterministic. A typed or spoken custom request exercises AI planning separately.</li><li>Use a saved profile: qa@voiceqa.test / fixture-only. TOTP seed: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ (SHA-1, 6 digits, 30 seconds).</li><li>Microphone input, speech playback and operator challenges need a separate interactive check. These are not proved by a fixture pass.</li><li>Native file dialogs, cross-origin embedded apps, canvas-only controls and production CAPTCHA solving are outside the current automated coverage.</li></ul><button class="button secondary" data-command="reset">Reset sandbox data</button></section>`;
    } else if (view === 'security') {
      main.innerHTML =
        heading(
          'Security scenarios',
          'Scoped tests for this synthetic workspace’s server-side rules.',
        ) +
        `<section class="card settings-card"><h2>Test account controls</h2><p>Choose an account to inspect the protected order and approval routes.</p><button class="button secondary" data-command="identity-alice" data-testid="login-alice">Use Alice test account</button> <button class="button secondary" data-command="identity-bob" data-testid="login-bob">Use Bob test account</button><p data-testid="client-role" id="client-role">Client claims analyst</p><button class="button secondary" data-command="client-admin" data-testid="client-admin">Claim admin on the client</button><div class="notice">Alice is an analyst; Bob is a manager. Client role claims never grant server permissions in the healthy sandbox.</div><p>Known resources: ORD-2001 belongs to Alice; ORD-2002 belongs to Bob.</p><p>Studio display: $120.00. Express shipping: $15.00. CSRF is required for writes. Reusing a submission key must return the same order.</p><p>Select <strong>Logical security</strong> in VoiceQA and acknowledge authorization before running this suite.</p></section>`;
    } else if (view === 'auth') {
      main.innerHTML =
        heading(
          'Authentication lab',
          'Real server validation with synthetic credentials and local TOTP.',
        ) +
        `<section class="card auth-card"><h2>Sign in to Northstar</h2><p class="notice">Test account: qa@voiceqa.test / fixture-only. Save the documented TOTP profile in VoiceQA Settings.</p><form id="auth-form"><label>Email<input type="email" autocomplete="username" data-testid="auth-username" name="username" required></label><label>Password<input type="password" autocomplete="current-password" data-testid="auth-password" name="password" required></label><label>Verification code<input inputmode="numeric" autocomplete="one-time-code" data-testid="auth-otp" name="code" required></label><button class="button primary" data-testid="verify-login">Sign in securely</button><p role="status" data-testid="auth-result" id="auth-result">Not authenticated</p></form><div class="challenge"><h3>Operator challenge</h3><p>This is a synthetic checkpoint, not a production CAPTCHA solver.</p><label class="check-label"><input type="checkbox" id="challenge" data-testid="challenge"><span>I have completed the test challenge</span></label><p role="status" data-testid="challenge-result" id="challenge-result">Challenge awaiting operator</p></div></section>`;
    } else if (view === 'invoices') {
      const order = await request('api/orders/' + encodeURIComponent(path.split('/')[3]), {
        signal: pageController.signal,
      });
      if (id !== generation) return;
      main.innerHTML = `<article class="card invoice"><div class="invoice-head"><div><p class="eyebrow">RELAYDESK / INVOICE</p><h1>Order invoice</h1><p data-testid="invoice-id">${esc(order.id)}</p></div><div><span class="status confirmed">Synthetic transaction</span><p>Northstar workspace</p></div></div><div class="invoice-detail"><strong>${esc(order.customer)}</strong><p>${esc(order.quantity)} × ${esc(boot.products.find((p) => p.id === order.product)?.name || order.product)}<br>${esc(order.shipping)} shipping</p></div><div class="invoice-total"><span>Total</span><span data-testid="invoice-total">${money(order.total)}</span></div><p class="notice">This invoice belongs to the current test account. No payment has been taken.</p><a class="button secondary" href="/app/orders">Back to orders</a></article>`;
    }
  } catch (e) {
    if (e.name !== 'AbortError' && id === generation)
      main.innerHTML =
        heading('Workspace unavailable', 'The server could not complete this request.') +
        `<div class="card settings-card error-panel" role="alert">${esc(e.message)}</div>`;
  } finally {
    if (id === generation) main.removeAttribute('aria-busy');
  }
}
async function loadOrders(id = generation) {
  const box = document.querySelector('#orders-content');
  if (!box) return;
  box.innerHTML = '<div class="loading" role="status">Loading orders…</div>';
  const snapshot = JSON.stringify(table),
    q = new URLSearchParams(table);
  try {
    const data = await request('api/orders?' + q, { signal: pageController.signal });
    if (id !== generation || snapshot !== JSON.stringify(table)) return;
    box.innerHTML = data.items.length
      ? `<div class="table-wrap"><table><caption data-testid="orders-summary">${data.total} matching orders</caption><thead><tr><th scope="col">Order</th><th scope="col">Customer</th><th scope="col">Status</th><th scope="col">Amount</th><th scope="col">Details</th></tr></thead><tbody data-testid="orders-rows">${data.items.map((o) => `<tr><td data-label="Order"><strong>${esc(o.id)}</strong></td><td data-label="Customer"><strong>${esc(o.customer)}</strong></td><td data-label="Status"><span class="status ${o.status.toLowerCase()}">${esc(o.status)}</span></td><td data-label="Amount">${money(o.total)}</td><td data-label="Details"><a href="/app/invoices/${esc(o.id)}">View invoice <span class="sr-only">${esc(o.id)}</span></a></td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty"><h3 data-testid="empty-orders">No orders found</h3><p>Try another customer name or status.</p><button class="button secondary" data-command="clear-search">Clear filters</button></div>`;
    box.innerHTML += `<div class="pagination"><span data-testid="page-number">Page ${data.page} of ${data.pages}</span><div class="pagination-actions"><button class="button secondary" data-command="previous-page" ${data.page <= 1 ? 'disabled' : ''}>Previous</button><button class="button secondary" data-command="next-page" data-testid="next-page" ${data.page >= data.pages ? 'disabled' : ''}>Next page</button></div></div>`;
  } catch (e) {
    if (e.name !== 'AbortError' && id === generation && snapshot === JSON.stringify(table))
      box.innerHTML = `<p class="form-error" role="alert">${esc(e.message)}</p>`;
  }
}
function rememberWizard() {
  for (const input of dialog.querySelectorAll('[name]')) orderData[input.name] = input.value;
}
function renderWizard() {
  document
    .querySelectorAll('.wizard-progress li')
    .forEach((li, i) => li.classList.toggle('current', i === wizardStep));
  const box = document.querySelector('#wizard-body'),
    next = document.querySelector('[data-testid=wizard-next]');
  next.textContent = wizardStep === 2 ? 'Place test order' : 'Next';
  next.disabled = submitting;
  dialog.querySelector('[data-command=wizard-back]').disabled = wizardStep === 0 || submitting;
  if (wizardStep === 0)
    box.innerHTML = `<div class="form-grid"><label>Customer name<input name="customer" data-testid="customer-name" value="${esc(orderData.customer)}" aria-describedby="wizard-error" autocomplete="organization"></label><label>Contact email<input type="email" name="email" data-testid="customer-email" value="${esc(orderData.email)}" aria-describedby="wizard-error" autocomplete="off"></label></div><label>Delivery method<select name="shipping" data-testid="shipping-method"><option value="standard" ${orderData.shipping === 'standard' ? 'selected' : ''}>Standard · Free</option><option value="express" ${orderData.shipping === 'express' ? 'selected' : ''}>Express · $15.00</option></select></label>`;
  if (wizardStep === 1)
    box.innerHTML = `<div class="form-grid"><label>Product<select name="product" data-testid="order-product">${boot.products.map((p) => `<option value="${p.id}" ${orderData.product === p.id ? 'selected' : ''}>${p.name} · ${money(p.price)}</option>`).join('')}</select></label><label>Quantity<input type="number" min="1" max="5" name="quantity" data-testid="order-quantity" value="${esc(orderData.quantity)}" aria-describedby="wizard-error"></label></div><label>Discount code<input name="coupon" data-testid="order-coupon" value="${esc(orderData.coupon)}" aria-describedby="wizard-error" placeholder="Optional · WELCOME10"></label><p class="notice">Order totals are verified on the server. Invalid discount codes must be rejected.</p>`;
  if (wizardStep === 2) {
    const total = orderTotal();
    box.innerHTML = `<h3>Ready for review</h3><dl class="review-list"><dt>Customer</dt><dd>${esc(orderData.customer)}</dd><dt>Items</dt><dd>${esc(orderData.quantity)} × ${esc(boot.products.find((p) => p.id === orderData.product).name)}</dd><dt>Delivery</dt><dd>${esc(orderData.shipping)}</dd><dt>Total</dt><dd class="review-total" data-testid="review-total">${money(total)}</dd></dl><p class="notice">This creates a synthetic order and a protected invoice. No real payment is processed.</p>`;
  }
  box.innerHTML +=
    '<p class="form-error" role="alert" id="wizard-error" data-testid="wizard-error"></p>';
}
function orderTotal() {
  return (
    boot.products.find((p) => p.id === orderData.product).price *
      Number(orderData.quantity) *
      (orderData.coupon === 'WELCOME10' ? 0.9 : 1) +
    (orderData.shipping === 'express' ? 15 : 0)
  );
}
function openWizard() {
  wizardStep = 0;
  submitting = false;
  orderKey = crypto.randomUUID();
  orderData = {
    customer: '',
    email: '',
    shipping: 'standard',
    product: 'studio-display',
    quantity: '1',
    coupon: '',
  };
  renderWizard();
  dialog.showModal();
  dialog.querySelector('input')?.focus();
}
async function submitOrder() {
  if (submitting) return;
  rememberWizard();
  const error = document.querySelector('#wizard-error');
  if (wizardStep === 0 && (!orderData.customer.trim() || !/^\S+@\S+\.\S+$/.test(orderData.email))) {
    error.textContent = 'Enter a customer name and valid contact email.';
    return;
  }
  if (
    wizardStep === 1 &&
    (!Number.isInteger(Number(orderData.quantity)) ||
      Number(orderData.quantity) < 1 ||
      Number(orderData.quantity) > 5)
  ) {
    error.textContent = 'Quantity must be between 1 and 5.';
    return;
  }
  if (wizardStep === 1 && orderData.coupon && orderData.coupon !== 'WELCOME10') {
    error.textContent = 'Coupon not recognized';
    return;
  }
  if (wizardStep < 2) {
    wizardStep++;
    renderWizard();
    dialog.querySelector('input,select')?.focus();
    return;
  }
  submitting = true;
  renderWizard();
  const submitGeneration = generation;
  try {
    const order = await request('api/orders', {
      method: 'POST',
      body: { ...orderData, quantity: Number(orderData.quantity) },
      key: orderKey,
    });
    if (submitGeneration !== generation || !dialog.open) return;
    dialog.close();
    const expectedGeneration = generation + 1;
    await render();
    if (generation !== expectedGeneration) return;
    const id = expectedGeneration;
    main.insertAdjacentHTML(
      'afterbegin',
      `<section class="card order-complete"><p class="eyebrow">ORDER RECEIVED</p><h2 data-testid="order-result">Order submitted</h2><code data-testid="order-id">${esc(order.id)}</code><p>Order total <strong data-testid="order-total">${money(order.total)}</strong></p><p role="status" data-testid="order-status" id="order-status">Pending confirmation</p><a class="button secondary" href="/app/invoices/${esc(order.id)}" target="_blank" rel="noopener">Open invoice in a new tab</a></section>`,
    );
    for (let n = 0; n < 40 && id === generation; n++) {
      await new Promise((r) => setTimeout(r, 150));
      if (id !== generation) break;
      let latest;
      try {
        latest = await request('api/orders/' + encodeURIComponent(order.id), {
          signal: pageController.signal,
        });
      } catch (error) {
        if (error.name !== 'AbortError' && id === generation) {
          const statusElement = document.querySelector('#order-status');
          if (statusElement)
            statusElement.textContent = 'Confirmation unavailable. Review orders before retrying.';
        }
        break;
      }
      if (id !== generation) break;
      if (latest.status === 'Confirmed') {
        const statusElement = document.querySelector('#order-status');
        if (!statusElement) break;
        statusElement.textContent = 'Order confirmed';
        toast('Order confirmed and invoice ready');
        break;
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      if (dialog.open) document.querySelector('#wizard-error').textContent = e.message;
      else toast(e.message);
    }
  } finally {
    submitting = false;
    if (dialog.open) {
      const message = document.querySelector('#wizard-error')?.textContent || '';
      renderWizard();
      document.querySelector('#wizard-error').textContent = message;
    }
  }
}
document.addEventListener('click', async (e) => {
  const link = e.target.closest('a');
  if (
    link &&
    link.origin === location.origin &&
    !link.target &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.shiftKey &&
    e.button === 0 &&
    !link.hash
  ) {
    e.preventDefault();
    if (link.pathname === '/app/auth') {
      await request('api/logout', { method: 'POST' }).catch(() => {});
    }
    await nav(link.pathname);
    return;
  }
  const button = e.target.closest('[data-command]');
  if (!button) return;
  const command = button.dataset.command;
  try {
    if (command === 'new-order') {
      openWizard();
      return;
    }
    if (command === 'close-dialog') {
      dialog.close();
      return;
    }
    if (command === 'wizard-back') {
      rememberWizard();
      wizardStep = Math.max(0, wizardStep - 1);
      renderWizard();
      return;
    }
    if (command === 'next-page' || command === 'previous-page') {
      table.page += command === 'next-page' ? 1 : -1;
      await loadOrders();
      return;
    }
    if (command === 'clear-search') {
      table.q = '';
      table.status = 'all';
      table.page = 1;
      document.querySelector('#order-search').value = '';
      document.querySelector('#order-filter').value = 'all';
      await loadOrders();
      return;
    }
    if (command.startsWith('identity-')) {
      const value = await request('fixture/identity', {
        method: 'POST',
        body: { user: command.slice(9) },
      });
      boot.user = value.user;
      identity();
      return;
    }
    if (command === 'client-admin') {
      sessionStorage.setItem('relay-client-role', 'admin');
      document.querySelector('#client-role').textContent = 'Client claims admin';
      return;
    }
    if (command === 'reset') {
      await request('fixture/reset', { method: 'POST' });
      await nav('/');
      toast('Sandbox reset');
      return;
    }
  } catch (err) {
    toast(err.message);
  }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'order-search') {
    table.q = e.target.value;
    table.page = 1;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadOrders(), 200);
  }
});
document.addEventListener('change', async (e) => {
  if (e.target.id === 'order-filter' || e.target.id === 'order-sort') {
    table[e.target.id === 'order-filter' ? 'status' : 'sort'] = e.target.value;
    table.page = 1;
    await loadOrders();
  }
  if (e.target.id === 'challenge' && e.target.checked) {
    try {
      const r = await request('fixture/challenge', { method: 'POST' });
      if (r.completed)
        document.querySelector('#challenge-result').textContent = 'Challenge completed';
    } catch (err) {
      toast(err.message);
    }
  }
});
document.addEventListener('submit', async (e) => {
  if (e.target.id === 'order-form') {
    e.preventDefault();
    await submitOrder();
    return;
  }
  if (e.target.id === 'settings-form') {
    e.preventDefault();
    const button = e.target.querySelector('button');
    button.disabled = true;
    try {
      const preferences = await request('api/preferences', {
        method: 'PUT',
        body: {
          notifications: document.querySelector('#notifications').checked,
          timezone: document.querySelector('#timezone').value,
        },
      });
      boot.preferences = preferences;
      document.querySelector('#settings-result').textContent = 'Preferences saved';
      toast('Preferences saved');
    } catch (err) {
      toast(err.message);
    } finally {
      button.disabled = false;
    }
  }
  if (e.target.id === 'auth-form') {
    e.preventDefault();
    const button = e.target.querySelector('button');
    button.disabled = true;
    try {
      const form = new FormData(e.target);
      const r = await request('api/login', { method: 'POST', body: Object.fromEntries(form) });
      boot.user = r.user;
      identity();
      document.querySelector('#auth-result').textContent = 'Authenticated as Alice Morgan';
    } catch (err) {
      document.querySelector('#auth-result').textContent = err.message;
    } finally {
      button.disabled = false;
    }
  }
});
window.addEventListener('popstate', () => render());
render();
