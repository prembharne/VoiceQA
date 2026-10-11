import { PageRegistry } from './page-registry.js';
import { NativeClient } from './native-client.js';
import { envelope, validateAction, isAllowedURL } from '../shared/protocol.js';
import { ExecutionFence } from '../shared/execution-fence.js';

const fence = new ExecutionFence();

const panels = new Set();
let state = {
  connected: false,
  target: null,
  pages: {},
  currentPage: 'main',
  handoff: null,
  runId: null,
  paused: false,
  cancelled: false,
  attached: false,
  settings: null,
  lastEvent: null,
  error: '',
};
let journal = {};
let stopping = false;
let detaching = false;
const ready = (async () => {
  const saved = await chrome.storage.session.get(['session', 'journal']);
  if (saved.session) {
    Object.assign(state, saved.session, { connected: false, attached: false });
    if (state.runId) {
      state.cancelled = true;
      state.error = 'Extension restarted. The interrupted run will not be replayed.';
    }
  }
  journal = saved.journal || {};
})();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function broadcast(message) {
  for (const port of panels) {
    try {
      port.postMessage(message);
    } catch {
      panels.delete(port);
    }
  }
}
async function save() {
  const entries = Object.entries(journal);
  if (entries.length > 200) journal = Object.fromEntries(entries.slice(-200));
  await chrome.storage.session.set({ session: state, journal });
  broadcast({ type: 'state', state });
}
function fault(message, code = 'error') {
  const e = new Error(message);
  e.code = code;
  return e;
}
const native = new NativeClient(onNative, async (error) => {
  fence.invalidate();
  state.connected = false;
  state.error = error.message;
  if (state.runId) {
    state.cancelled = true;
    state.handoff = null;
    await cleanup();
    await registry.cleanupCreated();
  }
  await save();
});
let activeViewport = null;
const registry = new PageRegistry({
  state,
  chrome,
  fence,
  detach: cleanup,
  attach,
  command,
  save,
  viewport: () => activeViewport,
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'voiceqa-panel') return;
  panels.add(port);
  port.postMessage({ type: 'state', state });
  port.onMessage.addListener((m) => {
    if (m.type !== 'request') return;
    handlePanel(m.method, m.payload || {})
      .then((result) => port.postMessage({ type: 'response', id: m.id, result }))
      .catch((e) => {
        try {
          port.postMessage({ type: 'response', id: m.id, error: e.message });
        } catch {}
      });
  });
  port.onDisconnect.addListener(() => {
    panels.delete(port);
    if (panels.size === 0 && state.runId) void stop();
  });
});
async function handlePanel(method, payload) {
  await ready;
  registry.ensure();
  if (method === 'state') return state;
  if (method === 'system.info')
    return { extensionId: chrome.runtime.id, version: chrome.runtime.getManifest().version };
  if (method === 'connect') {
    const result = await native.rpc('hello');
    if (!native.port)
      throw new Error('Local engine disconnected during startup. Retry connection.');
    state.connected = true;
    native.connected = true;
    state.settings = result.settings;
    state.error = '';
    await save();
    return result;
  }
  if (method === 'bind') {
    if (state.runId) throw new Error('Cancel the active run before selecting another tab');
    const tab = await chrome.tabs.get(payload.tabId);
    const url = new URL(tab.url);
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('Choose an HTTP(S) website tab');
    const origin = url.origin;
    if (!(await chrome.permissions.contains({ origins: [origin + '/*'] })))
      throw new Error('Share the current tab and allow site access first');
    await cleanup();
    state.target = {
      tabId: tab.id,
      windowId: tab.windowId,
      origin,
      url: tab.url,
      title: tab.title,
    };
    state.pages = { main: { ...state.target, alias: 'main', owned: false } };
    state.currentPage = 'main';
    state.handoff = null;
    activeViewport = null;
    state.cancelled = false;
    state.paused = false;
    state.error = '';
    await native.rpc('project.configure', { origin, url: tab.url });
    await ensureContent();
    await save();
    return state.target;
  }
  if (method === 'unbind') {
    if (state.runId) throw new Error('Stop the active run before removing its website.');
    await cleanup();
    state.target = null;
    state.pages = {};
    state.currentPage = 'main';
    state.handoff = null;
    state.error = '';
    await save();
    return { unbound: true };
  }
  if (method === 'pages.list') return registry.publicPages();
  if (method === 'pages.share') {
    if (state.runId) throw new Error('Finish the run before changing shared pages.');
    const pages = registry.ensure();
    if (!pages.main) throw new Error('Share a main website first.');
    const tab = await chrome.tabs.get(payload.tabId);
    const origin = new URL(tab.url).origin;
    if (
      !isAllowedURL(tab.url, origin) ||
      tab.windowId !== pages.main.windowId ||
      Object.keys(pages).length >= 5
    )
      throw new Error('Share an HTTP(S) tab in the same window, within five pages.');
    if (!(await chrome.permissions.contains({ origins: [origin + '/*'] })))
      throw new Error('Allow access to the additional website first.');
    if (Object.values(pages).some((p) => p.tabId === tab.id))
      throw new Error('This tab is already shared.');
    const alias =
      payload.alias || ['page2', 'page3', 'page4', 'page5'].find((name) => !pages[name]);
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(alias) || pages[alias])
      throw new Error('Use a unique page alias.');
    pages[alias] = {
      alias,
      tabId: tab.id,
      windowId: tab.windowId,
      origin,
      url: tab.url,
      title: tab.title?.slice(0, 200),
      owned: false,
    };
    await chrome.tabs.update(pages.main.tabId, { active: true });
    await save();
    return registry.publicPages();
  }
  if (method === 'pages.remove') {
    if (state.runId || payload.alias === 'main')
      throw new Error('Only extra shared pages can be removed while idle.');
    delete registry.ensure()[payload.alias];
    await save();
    return registry.publicPages();
  }
  if (method === 'handoff.complete') {
    if (
      !state.runId ||
      !state.handoff ||
      payload.id !== state.handoff.id ||
      state.handoff.runId !== state.runId ||
      state.cancelled
    )
      throw new Error('This checkpoint is no longer active.');
    await checkTarget();
    state.handoff.completed = true;
    await save();
    return { completed: true };
  }
  if (method === 'observe') {
    return content({ type: 'vqa.observe', maskSelectors: state.settings?.maskSelectors });
  }
  if (method === 'cancel') {
    await stop();
    return { cancelled: true };
  }
  if (method === 'resume') {
    if (!state.runId || state.cancelled) throw new Error('There is no resumable run');
    await checkTarget();
    state.paused = false;
    await save();
    return { resumed: true };
  }
  if (method === 'transcribe') {
    const bytes = Uint8Array.from(atob(payload.data), (c) => c.charCodeAt(0));
    const uploaded = await native.upload(bytes, payload.mime);
    return native.rpc('audio.complete', { artifactId: uploaded.artifactId, mime: payload.mime });
  }
  if (method === 'plan.propose') {
    if (!state.target) throw new Error('Select a target tab first');
    if (state.runId) throw new Error('Finish the current run first');
    state.cancelled = false;
    const tab = await checkTarget();
    state.target.url = tab.url;
    const main = registry.primary();
    if (state.target.tabId !== main.tabId)
      throw new Error('Return to the main shared tab to create a plan.');
    main.url = tab.url;
    if (main.origin !== state.target.origin) {
      main.origin = state.target.origin;
      await native.rpc('project.configure', { origin: main.origin, url: tab.url });
    }
    await save();
    return native.rpc(method, {
      ...payload,
      url: tab.url,
      origin: registry.primary().origin,
      pages: registry.publicPages(),
    });
  }
  if (method === 'run.start') {
    if (!state.target) throw new Error('Select a target first');
    await checkTarget();
    state.cancelled = false;
    state.paused = false;
    state.error = '';
    diagnostics.length = 0;
    registry.ensure();
    const planned = await native.rpc('plan.get', { id: payload.planId });
    if (planned.origin !== registry.primary()?.origin)
      throw new Error("Share this plan\'s main website before running it.");
    for (const page of planned.pages || []) {
      const shared = state.pages[page.alias];
      if (!shared || shared.owned || shared.origin !== page.origin)
        throw new Error('A required page is no longer shared with its approved origin.');
    }
    await attach();
    try {
      const result = await native.rpc(method, payload);
      if (!state.runId) state.runId = result.runId;
      await save();
      return result;
    } catch (e) {
      await cleanup();
      throw e;
    }
  }
  if (method === 'settings.save') {
    const result = await native.rpc(method, payload);
    state.settings = result;
    await save();
    return result;
  }
  if (
    [
      'auth.list',
      'auth.save',
      'auth.delete',
      'settings.get',
      'plan.confirm',
      'plan.get',
      'plan.list',
      'run.get',
      'run.list',
      'baseline.approve',
      'report.export',
      'artifact.get',
      'speech.synthesize',
      'speech.cancel',
      'speech.release',
    ].includes(method)
  )
    return native.rpc(method, payload);
  throw new Error('Unsupported panel request');
}
async function stop() {
  if (stopping) return;
  stopping = true;
  fence.invalidate();
  state.cancelled = true;
  state.paused = false;
  state.handoff = null;
  await save();
  try {
    await cleanup();
    await registry.cleanupCreated();
    if (native.port) await native.rpc('run.cancel', {}, state.runId ? { runId: state.runId } : {});
  } catch (e) {
    state.error = e.message;
  } finally {
    stopping = false;
    await save();
  }
}
async function checkTarget() {
  if (!state.target) throw fault('No target is selected', 'blocked');
  const tab = await chrome.tabs.get(state.target.tabId);
  if (!registry.allows(tab.url)) throw fault('Target left explicitly approved origins', 'blocked');
  state.target.origin = new URL(tab.url).origin;
  if (!tab.active) throw fault('Return to the selected tab and say resume', 'paused');
  const win = await chrome.windows.get(tab.windowId);
  if (!win.focused) throw fault('Focus the target browser window and resume', 'paused');
  return tab;
}
async function waitForTarget(token) {
  while (true) {
    fence.check(token, state);
    if (state.cancelled) throw fault('Run cancelled', 'cancelled');
    try {
      await checkTarget();
      fence.check(token, state);
      if (!state.paused) return;
    } catch (e) {
      if (e.code !== 'paused') throw e;
      state.paused = true;
      await save();
    }
    await delay(200);
  }
}
async function ensureContent(token) {
  fence.check(token, state);
  if (!state.target) throw fault('No target', 'blocked');
  await chrome.scripting.executeScript({
    target: { tabId: token?.tabId || state.target.tabId },
    files: ['content.js'],
  });
}
async function content(message, token) {
  await ensureContent(token);
  fence.check(token, state);
  const response = await chrome.tabs.sendMessage(token?.tabId || state.target.tabId, message, {
    frameId: 0,
  });
  if (response.error) throw fault(response.error, response.code);
  if (message.type === 'vqa.observe' && !registry.allows(response.result.url))
    throw fault('Observation left explicitly approved origins.', 'blocked');
  return response.result;
}
async function attach(token) {
  fence.check(token, state);
  if (state.attached) return;
  const tabId = token?.tabId || state.target.tabId;
  await chrome.debugger.attach({ tabId }, '1.3');
  try {
    fence.check(token, state);
  } catch (error) {
    await chrome.debugger.detach({ tabId }).catch(() => {});
    throw error;
  }
  state.attached = true;
  await command('Page.enable', {}, token);
  await command('Runtime.enable', {}, token);
  await command('Log.enable', {}, token);
  await command('Network.enable', {}, token);
}
async function command(method, params = {}, token) {
  fence.check(token, state);
  if (!state.attached) throw fault('Debugger is detached', 'blocked');
  return chrome.debugger.sendCommand({ tabId: state.target.tabId }, method, params);
}
async function cleanup() {
  detaching = true;
  if (state.target) {
    try {
      await chrome.tabs.sendMessage(state.target.tabId, { type: 'vqa.cleanup' }, { frameId: 0 });
    } catch {}
  }
  if (state.attached) {
    try {
      await command('Emulation.clearDeviceMetricsOverride');
      await command('Emulation.setTouchEmulationEnabled', { enabled: false });
    } catch {}
    try {
      await chrome.debugger.detach({ tabId: state.target.tabId });
    } catch {}
  }
  state.attached = false;
  detaching = false;
}
async function key(value, modifiers = 0, token) {
  const table = {
    Tab: [9, 'Tab'],
    Enter: [13, 'Enter'],
    Escape: [27, 'Escape'],
    ArrowDown: [40, 'ArrowDown'],
    ArrowUp: [38, 'ArrowUp'],
    Space: [32, ' '],
    Home: [36, 'Home'],
    a: [65, 'a'],
  };
  const entry = table[value];
  if (!entry) throw fault('Unsupported keyboard input', 'blocked');
  const params = {
    key: entry[1],
    code: value === 'a' ? 'KeyA' : value,
    windowsVirtualKeyCode: entry[0],
    modifiers,
  };
  await command('Input.dispatchKeyEvent', { ...params, type: 'keyDown' }, token);
  try {
    fence.check(token, state);
  } finally {
    await chrome.debugger
      .sendCommand({ tabId: token?.tabId || state.target.tabId }, 'Input.dispatchKeyEvent', {
        ...params,
        type: 'keyUp',
      })
      .catch(() => {});
  }
}
async function click(target, token) {
  const r = await content({ type: 'vqa.resolve', target }, token);
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y }, token);
  await command(
    'Input.dispatchMouseEvent',
    {
      type: 'mousePressed',
      x: r.x,
      y: r.y,
      button: 'left',
      clickCount: 1,
    },
    token,
  );
  try {
    fence.check(token, state);
  } finally {
    await chrome.debugger
      .sendCommand({ tabId: token?.tabId || state.target.tabId }, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: r.x,
        y: r.y,
        button: 'left',
        clickCount: 1,
      })
      .catch(() => {});
  }
  return r;
}
async function navigation(url, token) {
  if (!registry.allows(url)) throw fault('Navigation outside approved origin', 'blocked');
  state.target.origin = new URL(url).origin;
  const navigated = await command('Page.navigate', { url }, token);
  if (navigated.errorText) throw fault('Navigation failed: ' + navigated.errorText, 'blocked');
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    fence.check(token, state);
    if (state.cancelled) throw fault('Run cancelled', 'cancelled');
    const tab = await chrome.tabs.get(state.target.tabId);
    if (tab.status === 'complete') {
      const { frameTree } = await command('Page.getFrameTree', {}, token);
      const loaded = navigated.loaderId
        ? frameTree.frame.loaderId === navigated.loaderId
        : tab.url === url;
      if (loaded && frameTree.frame.url === tab.url) {
        if (!registry.allows(tab.url))
          throw fault('Redirect left explicitly approved origins', 'blocked');
        state.target.origin = new URL(tab.url).origin;
        state.target.url = tab.url;
        await ensureContent(token);
        return { url: tab.url };
      }
    }
    await delay(100);
  }
  throw fault('Navigation timed out; outcome is unknown', 'needs_review');
}
async function assertion(action, token) {
  const end = Date.now() + (action.timeoutMs || 6000);
  let last = {};
  while (Date.now() < end) {
    fence.check(token, state);
    if (state.cancelled) throw fault('Run cancelled', 'cancelled');
    try {
      last = await content({ type: 'vqa.assert', action }, token);
      if (last.passed) return last;
    } catch (e) {
      if (e.code !== 'target_missing') throw e;
      last = {
        expected: action.assertion.expected,
        actual: 'target missing',
        kind: action.assertion.kind,
      };
    }
    await delay(150);
  }
  const e = fault(
    `Expected ${JSON.stringify(last.expected)}; observed ${JSON.stringify(last.actual)}`,
    'assertion_failed',
  );
  e.result = last;
  throw e;
}
async function execute(action, token, secureOrigin = '') {
  const secure = Boolean(secureOrigin);
  validateAction(action);
  await waitForTarget(token);
  switch (action.operation) {
    case 'open_tab':
      return registry.open(action.target, action.value, token);
    case 'switch_tab':
      await registry.activate(action.target, token);
      return { page: action.target };
    case 'close_tab':
      return registry.close(action.target, token);
    case 'human_checkpoint':
      state.handoff = {
        id: crypto.randomUUID(),
        runId: state.runId,
        kind: action.value,
        label: action.label,
        page: state.currentPage,
        completed: false,
      };
      await save();
      return { handoff: state.handoff };
    case 'wait_for':
      return assertion(action, token);
    case 'navigate':
      return navigation(action.value, token);
    case 'click':
      await click(action.target, token);
      return { dispatched: true };
    case 'fill': {
      if (secure && new URL((await checkTarget()).url).origin !== secureOrigin)
        throw fault('Credential origin changed before entry.', 'blocked');
      if (secure) await content({ type: 'vqa.mark-secret', target: action.target }, token);
      const r = await click(action.target, token);
      if (r.privateField && !secure)
        throw fault('Use a saved test credential profile for private fields.', 'blocked');
      if (!['INPUT', 'TEXTAREA'].includes(r.tag))
        throw fault('Fill requires a text input', 'blocked');
      await key('a', 2, token);
      if (secure && new URL((await checkTarget()).url).origin !== secureOrigin)
        throw fault('Credential origin changed before entry.', 'blocked');
      await command('Input.insertText', { text: action.value || '' }, token);
      return { dispatched: true };
    }
    case 'select': {
      const r = await click(action.target, token);
      if (r.tag !== 'SELECT') throw fault('Select requires a native select control', 'blocked');
      const idx = r.options.findIndex((o) => o.value === action.value || o.label === action.value);
      if (idx < 0) throw fault('Option is not present', 'target_missing');
      await key('Home', 0, token);
      for (let i = 0; i < idx; i++) await key('ArrowDown', 0, token);
      await key('Enter', 0, token);
      return { dispatched: true };
    }
    case 'key':
      await key(action.value, 0, token);
      return { dispatched: true };
    case 'scroll':
      await command(
        'Input.dispatchMouseEvent',
        {
          type: 'mouseWheel',
          x: 100,
          y: 100,
          deltaX: 0,
          deltaY: Math.max(-1000, Math.min(1000, Number(action.value) || 400)),
        },
        token,
      );
      return { dispatched: true };
    case 'assert':
      return assertion(action, token);
    default:
      throw fault('Unsupported executor operation', 'blocked');
  }
}
async function capture(maskSelectors, token) {
  await content({ type: 'vqa.settle' }, token);
  await content({ type: 'vqa.redact', maskSelectors }, token);
  try {
    const { data } = await command(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false },
      token,
    );
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const { artifactId } = await native.upload(bytes, 'image/png');
    const view = await content({ type: 'vqa.observe' }, token);
    const platform = await chrome.runtime.getPlatformInfo();
    return {
      artifactId,
      width: view.viewport.width,
      height: view.viewport.height,
      dpr: 1,
      browserVersion:
        navigator.userAgent.match(/(?:Chrome|HeadlessChrome)\/[\d.]+/)?.[0] || navigator.userAgent,
      platform: platform.os,
      maskSelectors,
      diagnostics: [...diagnostics],
      url: view.url,
    };
  } finally {
    await chrome.tabs
      .sendMessage(token?.tabId || state.target.tabId, { type: 'vqa.cleanup' }, { frameId: 0 })
      .catch(() => {});
  }
}
async function onNative(message) {
  if (message.type === 'run.event') {
    state.lastEvent = Date.now();
    broadcast({ type: 'run', ...message.payload });
    const run = message.payload.run;
    if (!['running', 'paused', 'queued'].includes(run.status)) {
      fence.invalidate();
      state.runId = null;
      state.cancelled = false;
      await save();
    }
    return;
  }
  if (message.type !== 'browser.request') return;
  await ready;
  const p = message.payload;
  try {
    registry.ensure();
    if (!state.target || p.origin !== registry.primary()?.origin)
      throw fault('Browser request does not match approved suite origin', 'blocked');
    if (message.runId) {
      if (state.runId && state.runId !== message.runId)
        throw fault('Run identity changed', 'blocked');
      state.runId = message.runId;
    }
    if (p.operation === 'cleanup') {
      await cleanup();
      state.handoff = null;
      activeViewport = null;
      await registry.cleanupCreated();
      native.send(envelope('browser.result', { requestId: message.id, result: { cleaned: true } }));
      return;
    }
    if (p.operation === 'handoff.poll') {
      const gate = state.handoff;
      if (!gate || gate.id !== p.id || gate.runId !== message.runId || state.cancelled)
        throw fault('Checkpoint cancelled or superseded.', 'cancelled');
      native.send(
        envelope('browser.result', {
          requestId: message.id,
          result: { completed: gate.completed },
        }),
      );
      if (gate.completed) {
        state.handoff = null;
        await save();
      }
      return;
    }
    if (state.cancelled) throw fault('Run cancelled', 'cancelled');
    if (message.actionId && journal[message.actionId]) {
      const prior = journal[message.actionId];
      if (prior.status === 'completed') {
        native.send(envelope('browser.result', { requestId: message.id, ...prior.reply }));
        return;
      }
      throw fault(
        'This action was already dispatched; its outcome requires review',
        'needs_review',
      );
    }
    let token = fence.token(message.runId, state.target.tabId);
    if (p.operation === 'page_scope') {
      await waitForTarget(token);
      await cleanup();
      await registry.cleanupCreated();
      token = fence.token(message.runId, state.target.tabId);
      await registry.activate(p.page || 'main', token);
      token = fence.token(message.runId, state.target.tabId);
    }
    await waitForTarget(token);
    let result;
    if (message.actionId) {
      journal[message.actionId] = { status: 'dispatched' };
      await save();
    }
    switch (p.operation) {
      case 'observe':
        result = await content(
          {
            type: 'vqa.observe',
            maskSelectors: state.settings?.maskSelectors,
          },
          token,
        );
        break;
      case 'observe_page': {
        const page = registry.ensure()[p.page];
        const tab = page && (await chrome.tabs.get(page.tabId));
        if (!tab || !registry.allows(tab.url))
          throw fault('Additional page is no longer in its approved origin.', 'blocked');
        await chrome.scripting.executeScript({
          target: { tabId: page.tabId },
          files: ['content.js'],
        });
        fence.check(token, state);
        const observed = await chrome.tabs.sendMessage(
          page.tabId,
          { type: 'vqa.observe', maskSelectors: state.settings?.maskSelectors },
          { frameId: 0 },
        );
        if (observed.error) throw new Error(observed.error);
        if (!registry.allows(observed.result.url))
          throw fault('Additional page observation left approved origins.', 'blocked');
        result = { ...observed.result, page: page.alias, origin: new URL(tab.url).origin };
        break;
      }
      case 'page_scope':
        result = { page: state.currentPage, origin: state.target.origin, url: state.target.url };
        break;
      case 'location': {
        const tab = await checkTarget();
        result = {
          page: state.currentPage,
          origin: new URL(tab.url).origin,
          url: tab.url,
        };
        break;
      }
      case 'viewport':
        activeViewport = p.viewport;
        await attach(token);
        await command(
          'Emulation.setDeviceMetricsOverride',
          {
            width: p.viewport.width,
            height: p.viewport.height,
            deviceScaleFactor: 1,
            mobile: false,
          },
          token,
        );
        result = { viewport: p.viewport, mode: 'responsive-width' };
        break;
      case 'execute':
        await attach(token);
        result = await execute(p.action, token, p.secure === true ? p.secureOrigin : '');
        break;
      case 'capture':
        result = await capture(p.maskSelectors, token);
        break;
      case 'accessibility':
        fence.check(token, state);
        await chrome.scripting.executeScript({
          target: { tabId: state.target.tabId },
          files: ['axe.min.js'],
        });
        result = await content({ type: 'vqa.accessibility' }, token);
        break;
      default:
        throw fault('Unsupported browser request', 'blocked');
    }
    result = {
      ...result,
      page: result.page || state.currentPage,
      origin: result.origin || state.target.origin,
    };
    const reply = { result };
    if (message.actionId) {
      journal[message.actionId] = { status: 'completed', reply };
      await save();
    }
    native.send(envelope('browser.result', { requestId: message.id, ...reply }));
  } catch (e) {
    const reply = { error: e.message, code: e.code || 'error', result: e.result || {} };
    if (message.actionId) {
      journal[message.actionId] = { status: 'completed', reply };
      await save();
    }
    try {
      native.send(envelope('browser.result', { requestId: message.id, ...reply }));
    } catch {}
  }
}
const diagnostics = [];
chrome.debugger.onEvent.addListener((source, method, p) => {
  if (source.tabId !== state.target?.tabId) return;
  if (method === 'Runtime.exceptionThrown')
    diagnostics.push({
      type: 'exception',
      message: p.exceptionDetails?.text || 'JavaScript exception',
    });
  if (method === 'Network.loadingFailed')
    diagnostics.push({ type: 'network', message: p.errorText });
  if (diagnostics.length > 100) diagnostics.shift();
});
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== state.target?.tabId) return;
  state.attached = false;
  if (state.runId && !stopping && !detaching && !registry.switching) {
    fence.invalidate();
    state.cancelled = true;
    state.error = 'Debugger detached. Run stopped without replay.';
    void native.rpc('run.cancel', {}, { runId: state.runId }).catch(() => {});
  }
  void save();
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (state.runId && !registry.switching && tabId !== state.target?.tabId) {
    state.paused = true;
    void save();
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!registry.switching && tabId === state.target?.tabId) {
    void stop();
    state.target = null;
    void save();
  }
});
export { handlePanel };
