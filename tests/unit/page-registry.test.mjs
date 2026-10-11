import test from 'node:test';
import assert from 'node:assert/strict';
import { PageRegistry } from '../../extension/page-registry.js';
import { ExecutionFence } from '../../shared/execution-fence.js';

function fixture() {
  const main = {
    alias: 'main',
    tabId: 1,
    windowId: 7,
    origin: 'https://app.test',
    url: 'https://app.test/',
    owned: false,
  };
  const secondary = {
    ...main,
    alias: 'login',
    tabId: 2,
    origin: 'https://login.test',
    url: 'https://login.test/',
  };
  const state = {
    target: { ...main },
    pages: { main, login: secondary },
    currentPage: 'main',
    runId: 'run',
    cancelled: false,
  };
  const tabs = new Map([
    [1, { id: 1, ...main }],
    [2, { id: 2, ...secondary }],
  ]);
  const removed = [],
    commands = [];
  let nextId = 3;
  const chrome = {
    tabs: {
      get: async (id) => {
        if (!tabs.has(id)) throw new Error('Tab missing');
        return tabs.get(id);
      },
      create: async (p) => {
        const t = { id: nextId++, ...p };
        tabs.set(t.id, t);
        return t;
      },
      update: async (id, p) => Object.assign(tabs.get(id), p),
      remove: async (id) => {
        removed.push(id);
        tabs.delete(id);
      },
    },
    windows: { update: async () => {} },
  };
  const fence = new ExecutionFence();
  const registry = new PageRegistry({
    state,
    chrome,
    fence,
    detach: async () => {},
    attach: async () => {},
    command: async (...args) => commands.push(args),
    save: async () => {},
    viewport: () => ({ width: 390, height: 844 }),
  });
  return {
    state,
    tabs,
    removed,
    commands,
    registry,
    fence,
    chrome,
    token: () => fence.token('run', state.target.tabId),
  };
}

test('tab operations reject unshared origins and cannot close user-shared tabs', async () => {
  const f = fixture();
  await assert.rejects(
    f.registry.open('evil', 'https://unapproved.test/', f.token()),
    /explicitly shared/,
  );
  await assert.rejects(f.registry.close('login', f.token()), /created by this run/);
  assert.equal(f.tabs.size, 2);
  assert.deepEqual(f.removed, []);
});

test('owned tabs switch the execution identity and restore responsive metrics', async () => {
  const f = fixture();
  const old = f.token();
  await f.registry.open('child', 'https://login.test/flow', old);
  assert.equal(f.state.currentPage, 'child');
  assert.equal(f.state.target.origin, 'https://login.test');
  assert.throws(() => f.fence.check(old, f.state), /superseded/);
  assert.equal(f.commands.at(-1)[1].width, 390);
  await f.registry.close('child', f.token());
  assert.equal(f.state.currentPage, 'main');
  assert.deepEqual(f.removed, [3]);
  assert.equal(f.tabs.has(2), true);
});

test('cancellation during tab creation removes only that created tab without activating it', async () => {
  const f = fixture();
  const create = f.chrome.tabs.create;
  f.chrome.tabs.create = async (p) => {
    const tab = await create(p);
    f.fence.invalidate();
    return tab;
  };
  await assert.rejects(f.registry.open('child', 'https://app.test/child', f.token()), /superseded/);
  assert.equal(f.state.target.tabId, 1);
  assert.deepEqual(f.removed, [3]);
  assert.equal(f.tabs.has(2), true);
});

test('cleanup leaves user tabs and escaped created tabs intact', async () => {
  const f = fixture();
  await f.registry.open('child', 'https://app.test/child', f.token());
  f.tabs.get(3).url = 'https://unapproved.test/';
  await f.registry.cleanupCreated();
  assert.deepEqual(f.removed, []);
  assert.equal(f.tabs.has(3), true);
  assert.equal(f.state.currentPage, 'main');
  assert.equal(f.registry.publicPages().length, 2);
});

test('activating the same page after detach reapplies responsive metrics', async () => {
  const f = fixture();
  await f.registry.activate('main', f.token());
  assert.equal(f.commands.at(-1)[0], 'Emulation.setDeviceMetricsOverride');
});

test('new tabs wait for a committed approved document before switching execution', async () => {
  const f = fixture();
  const create = f.chrome.tabs.create,
    get = f.chrome.tabs.get;
  let polls = 0;
  f.chrome.tabs.create = async (p) => {
    const tab = await create(p);
    Object.assign(tab, { pendingUrl: p.url, url: 'about:blank', status: 'loading' });
    return tab;
  };
  f.chrome.tabs.get = async (id) => {
    const tab = await get(id);
    if (id === 3 && ++polls === 2) Object.assign(tab, { url: tab.pendingUrl, status: 'complete' });
    return tab;
  };
  await f.registry.open('child', 'https://app.test/child', f.token());
  assert.equal(f.state.currentPage, 'child');
  assert.ok(polls >= 2);
});

test('cancelled new-tab load cannot activate and cleanup removes the pending owned tab', async () => {
  const f = fixture();
  const create = f.chrome.tabs.create,
    get = f.chrome.tabs.get;
  f.chrome.tabs.create = async (p) => {
    const tab = await create(p);
    Object.assign(tab, { pendingUrl: p.url, url: 'about:blank', status: 'loading' });
    return tab;
  };
  f.chrome.tabs.get = async (id) => {
    const tab = await get(id);
    if (id === 3) f.fence.invalidate();
    return tab;
  };
  await assert.rejects(f.registry.open('child', 'https://app.test/child', f.token()), /superseded/);
  assert.equal(f.state.target.tabId, 1);
  await f.registry.cleanupCreated();
  assert.deepEqual(f.removed, [3]);
  assert.equal(f.tabs.has(2), true);
});
