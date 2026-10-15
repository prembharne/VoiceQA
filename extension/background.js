import {
  approvedReadLink,
  rememberPublicLinks,
  runtimeDiagnostic,
  validateLiveRead,
} from './agent-tools.js';
import { PageRegistry } from './page-registry.js';
import { NativeClient } from './native-client.js';
import { envelope, id, validateAction, isAllowedURL } from '../shared/protocol.js';
import { ExecutionFence } from '../shared/execution-fence.js';
import { pollCondition } from '../shared/condition-wait.js';
import { NetworkRecorder, publicURL } from './network-recorder.js';
import { auditConfiguration } from './security-audit.js';

const fence = new ExecutionFence();
const network = new NetworkRecorder();
const submittedForms = new Set();
let submissionSecret = '';
let lastHTTPAt = 0;

const panels = new Set();
let state = {
  connected: false,
  target: null,
  pages: {},
  currentPage: 'main',
  handoff: null,
  runId: null,
  planning: null,
  paused: false,
  cancelled: false,
  attached: false,
  settings: null,
  lastEvent: null,
  error: '',
  testMode: 'qa',
  securityAuthorized: false,
  httpCount: 0,
};
let journal = {};
let stopping = false;
let detaching = false;
const ready = (async () => {
  const saved = await chrome.storage.session.get(['session', 'journal']);
  if (saved.session) {
    Object.assign(state, saved.session, { connected: false, attached: false, planning: null });
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
  state.planning = null;
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
  if (
    state.planning &&
    [
      'bind',
      'unbind',
      'pages.share',
      'pages.remove',
      'run.start',
      'settings.save',
      'auth.save',
      'auth.delete',
    ].includes(method)
  )
    throw new Error('Finish or stop planning before changing its target or settings.');
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
    network.reset();
    diagnostics.length = 0;
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
  if (method === 'plan.propose' || method === 'agent.query' || method === 'automation.propose') {
    if (!state.target) throw new Error('Select a target tab first');
    if (state.runId) throw new Error('Finish the current run first');
    if (stopping || state.planning)
      throw new Error('Finish or stop the current planning request first');
    const requestId = id();
    state.planning = {
      id: requestId,
      startedAt: Date.now(),
      phase: 'reading',
      tools: [],
      url: state.target.url,
    };
    investigationLinks.clear();
    state.cancelled = false;
    await save();
    try {
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
      if (state.planning?.id !== requestId || state.cancelled)
        throw new Error('Planning stopped. No tests were run.');
      const result = await native.rpc(
        method,
        {
          ...payload,
          url: tab.url,
          origin: registry.primary().origin,
          pages: registry.publicPages(),
        },
        { id: requestId },
      );
      if (state.planning?.id !== requestId || state.cancelled)
        throw new Error('Planning stopped. No tests were run.');
      return result;
    } finally {
      if (state.planning?.id === requestId) {
        state.planning = null;
        await save();
      }
    }
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
    state.testMode = planned.mode || 'qa';
    state.automationPolicy = planned.automation || null;
    submittedForms.clear();
    submissionSecret = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('');
    state.securityAuthorized = planned.securityAuthorized === true;
    state.apiWritesAllowed = planned.apiWritesAllowed === true;
    state.httpCount = 0;
    network.reset();
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
      'plan.fork',
      'plan.list',
      'run.get',
      'run.list',
      'run.compare',
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
  state.planning = null;
  state.paused = false;
  state.handoff = null;
  await save();
  try {
    // Abort the provider before awaiting browser/tab cleanup.
    if (native.port) await native.rpc('run.cancel', {}, state.runId ? { runId: state.runId } : {});
    await cleanup();
    await registry.cleanupCreated();
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
      if (state.planning && !state.runId) state.paused = false;
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
  const response = await chrome.tabs.sendMessage(
    token?.tabId || state.target.tabId,
    { ...message, submissionSecret: state.automationPolicy && state.runId ? submissionSecret : '' },
    {
      frameId: 0,
    },
  );
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
async function click(target, token, visual = null) {
  const r = visual
    ? await resolveVisual(visual, token, visual.operation || 'click', target)
    : await resolveReady(target, token);
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
// Poll DOM readiness before dispatching input. An SPA can still be rendering
// after its navigation click; that is not a reason to invoke another AI call.
// No dispatched mutation is retried, and cancellation/scope are checked each time.
async function resolveReady(target, token) {
  const deadline = Date.now() + 5000;
  while (true) {
    fence.check(token, state);
    try {
      return await content({ type: 'vqa.resolve', target }, token);
    } catch (error) {
      if (error.code !== 'target_missing' || Date.now() >= deadline) throw error;
      await delay(100);
    }
  }
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
  return pollCondition(action, {
    read: (condition) => content({ type: 'vqa.assert', action: condition }, token),
    check: () => fence.check(token, state),
    sleep: delay,
    reinspectOnChange: Boolean(state.automationPolicy?.live),
  });
}
async function execute(action, token, secureOrigin = '', visual = null) {
  const secure = Boolean(secureOrigin);
  validateAction(action);
  await waitForTarget(token);
  if (
    state.automationPolicy &&
    (action.operation === 'click' ||
      (action.operation === 'key' && ['Enter', 'Space'].includes(action.value)))
  ) {
    const context = await content(
      {
        type: 'vqa.action-context',
        target: action.target || '',
        focused: action.operation === 'key',
        key: action.value || '',
      },
      token,
    );
    if ((context.consequential || context.opaque) && !state.automationPolicy.allowConsequential)
      throw fault(
        'This control has a consequential or opaque canvas action. Consequential-action permission was not granted in mission review.',
        'needs_review',
      );
    if (context.nativeForm?.valid === false)
      throw fault(
        'The browser would block this submission because fields are invalid. Inspect their constraints before submitting.',
        'validation_blocked',
      );
    if (context.submissionKey) {
      if (submittedForms.has(context.submissionKey))
        throw fault(
          'These form inputs were already submitted. Inspect the result instead of submitting unchanged data again.',
          'needs_review',
        );
      submittedForms.add(context.submissionKey);
    }
  }
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
    case 'capture_value':
      return content({ type: 'vqa.capture-value', target: action.target }, token);
    case 'http_check': {
      const check = action.http;
      const tab = await checkTarget();
      if (!registry.allows(check.url) || new URL(check.url).origin !== new URL(tab.url).origin)
        throw fault('HTTP check must stay on the active approved origin.', 'blocked');
      if (
        !['GET', 'HEAD'].includes(check.method) &&
        !state.apiWritesAllowed &&
        (state.testMode !== 'security' || !state.securityAuthorized)
      )
        throw fault('Mutating API checks require authorized logical security mode.', 'blocked');
      if (++state.httpCount > 20)
        throw fault('The run reached its twenty-request API check limit.', 'blocked');
      while (Date.now() - lastHTTPAt < 250) {
        fence.check(token, state);
        await delay(50);
      }
      await waitForTarget(token);
      lastHTTPAt = Date.now();
      const result = await content(
        { type: 'vqa.http-check', check, timeoutMs: action.timeoutMs },
        token,
      );
      fence.check(token, state);
      if (!result.passed) {
        const error = fault(
          `Expected ${result.expected}; observed ${result.actual}`,
          'assertion_failed',
        );
        error.result = result;
        throw error;
      }
      return result;
    }
    case 'security_audit': {
      if (state.testMode !== 'security' || !state.securityAuthorized)
        throw fault('Choose authorized logical security mode for this audit.', 'blocked');
      const context = await content({ type: 'vqa.security-context' }, token);
      const tree = await command('Page.getFrameTree', {}, token);
      const headers = network.headersFor(state.currentPage, tree.frameTree.frame.id);
      const response = await command('Network.getCookies', { urls: [context.url] }, token);
      const cookies = response.cookies.map(({ name, secure, httpOnly, sameSite }) => ({
        name,
        secure,
        httpOnly,
        sameSite,
      }));
      const findings = auditConfiguration({
        ...context,
        headers,
        headersObserved: headers !== undefined,
        cookies,
      });
      return {
        findings,
        incompleteEvidence: headers === undefined,
        scope:
          'Configuration indicators on the current approved page; not a complete penetration test.',
        url: publicURL(context.url),
      };
    }
    case 'navigate':
      return navigation(action.value, token);
    case 'click':
      await click(action.target, token, visual);
      return { dispatched: true };
    case 'fill': {
      if (secure && new URL((await checkTarget()).url).origin !== secureOrigin)
        throw fault('Credential origin changed before entry.', 'blocked');
      if (secure) {
        await resolveReady(action.target, token);
        await content({ type: 'vqa.mark-secret', target: action.target }, token);
      }
      const field = visual
        ? await resolveVisual(visual, token, 'fill', action.target)
        : await resolveReady(action.target, token);
      if (
        (!['INPUT', 'TEXTAREA'].includes(field.tag) && !field.editable) ||
        (field.tag === 'INPUT' &&
          [
            'checkbox',
            'radio',
            'button',
            'submit',
            'reset',
            'image',
            'file',
            'color',
            'range',
            'hidden',
          ].includes(field.inputType))
      )
        throw fault(
          'Fill requires a text-entry control; no click or text was dispatched',
          'blocked',
        );
      const r = await click(action.target, token, visual);
      if (r.privateField && !secure && !(r.inputType === 'email' && !r.secretField))
        throw fault('Use a saved test credential profile for private fields.', 'blocked');
      if (!['INPUT', 'TEXTAREA'].includes(r.tag) && !r.editable)
        throw fault('Fill requires an editable text control', 'blocked');
      const focus = await content({ type: 'vqa.editable-focus', target: action.target }, token);
      if (!focus.focused)
        throw fault('Editable control did not receive focus; no text was entered', 'blocked');
      await key('a', 2, token);
      if (secure && new URL((await checkTarget()).url).origin !== secureOrigin)
        throw fault('Credential origin changed before entry.', 'blocked');
      await command('Input.insertText', { text: action.value || '' }, token);
      return { dispatched: true };
    }
    case 'select': {
      const field = await resolveReady(action.target, token);
      if (field.tag !== 'SELECT')
        throw fault('Select requires a native select control; no click was dispatched', 'blocked');
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
let visualSnapshot = null;
async function resolveVisual(point, token, operation, target = '') {
  const saved = visualSnapshot;
  if (
    !saved ||
    saved.id !== point.snapshot ||
    Date.now() - saved.at > 180000 ||
    saved.tabId !== token.tabId ||
    saved.runId !== state.runId
  )
    throw fault('Visual screenshot expired or belongs to another page/run.', 'target_missing');
  const current = await content({ type: 'vqa.visual-state' }, token);
  if (
    JSON.stringify(current) !== JSON.stringify(saved.state) ||
    point.width !== current.width ||
    point.height !== current.height
  )
    throw fault(
      'Page changed since the visual observation. No input was dispatched.',
      'target_missing',
    );
  if (operation === 'key') {
    await content({ type: 'vqa.visual-focused' }, token);
    return {};
  }
  const result = await content({ type: 'vqa.visual-point', point, operation }, token);
  if (target && result.target !== target)
    throw fault('Visual target changed before dispatch.', 'target_missing');
  return result;
}
async function visualCapture(p, token) {
  visualSnapshot = null;
  await attach(token);
  const before = await content({ type: 'vqa.visual-state' }, token);
  const image = await capture(p.maskSelectors, token, p.visualMaskSelectors);
  if (!image.fullViewport)
    throw fault(
      'Chrome returned a cropped screenshot for this emulated viewport. Use a real browser window viewport for visual recovery. No input was dispatched.',
      'blocked',
    );
  const after = await content({ type: 'vqa.visual-state' }, token);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw fault(
      'Page changed while taking visual evidence (' +
        Object.keys(before)
          .filter((k) => before[k] !== after[k])
          .join(', ') +
        '). No input was dispatched.',
      'target_missing',
    );
  const id = crypto.randomUUID();
  visualSnapshot = { id, at: Date.now(), tabId: token.tabId, runId: state.runId, state: after };
  return { ...image, snapshot: id };
}
async function capture(maskSelectors, token, visualMaskSelectors = '') {
  await content({ type: 'vqa.settle' }, token);
  await content({ type: 'vqa.redact', maskSelectors, visualMaskSelectors }, token);
  try {
    const view = await content({ type: 'vqa.observe' }, token);
    const { dpr } = await content({ type: 'vqa.pixel-ratio' }, token);
    const { data } = await command(
      'Page.captureScreenshot',
      // Beyond-surface clipping can reset another CDP client's viewport.
      // Preserve width and reject cropped geometry in visualCapture instead.
      { format: 'png', captureBeyondViewport: false },
      token,
    );
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const png = new DataView(bytes.buffer);
    const pixelWidth = png.getUint32(16),
      pixelHeight = png.getUint32(20);
    const { artifactId } = await native.upload(bytes, 'image/png');
    const platform = await chrome.runtime.getPlatformInfo();
    return {
      artifactId,
      width: view.viewport.width,
      height: view.viewport.height,
      dpr,
      pixelWidth,
      pixelHeight,
      fullViewport:
        Math.abs(pixelWidth - view.viewport.width * dpr) <= 1 &&
        Math.abs(pixelHeight - view.viewport.height * dpr) <= 1,
      browserVersion:
        navigator.userAgent.match(/(?:Chrome|HeadlessChrome)\/[\d.]+/)?.[0] || navigator.userAgent,
      platform: platform.os,
      maskSelectors,
      visualMaskSelectors,
      diagnostics: [...diagnostics],
      network: network.snapshot(state.currentPage),
      url: view.url,
    };
  } finally {
    await chrome.tabs
      .sendMessage(token?.tabId || state.target.tabId, { type: 'vqa.cleanup' }, { frameId: 0 })
      .catch(() => {});
  }
}
const investigationLinks = new Set();
async function automationRead(p, token) {
  validateLiveRead(p, state.currentPage, Boolean(state.runId && state.automationPolicy?.live));
  const current = registry.ensure()[state.currentPage];
  const tab = await checkTarget();
  if (!current || current.tabId !== tab.id || !isAllowedURL(tab.url, current.origin))
    throw fault('Read target left its approved page origin.', 'blocked');
  let result;
  if (p.tool === 'inspect_element')
    result = await content({ type: 'vqa.inspect', target: p.target }, token);
  else if (p.tool === 'search_page')
    result = await content({ type: 'vqa.search', query: p.query }, token);
  else if (p.tool === 'diagnostics') {
    await attach(token);
    result = {
      network: network.snapshot(state.currentPage),
      runtime: diagnostics.filter((e) => e.page === state.currentPage).slice(-20),
      coverage:
        'Captured events only, starting at debugger attachment. Empty events do not prove health.',
    };
  } else {
    await chrome.scripting.executeScript({
      target: { tabId: current.tabId },
      files: ['axe.min.js'],
    });
    fence.check(token, state);
    result = await content({ type: 'vqa.accessibility' }, token);
  }
  fence.check(token, state);
  const after = await checkTarget();
  if (
    state.currentPage !== p.page ||
    after.id !== current.tabId ||
    !isAllowedURL(after.url, current.origin)
  )
    throw fault('Read page changed before its result could be accepted.', 'blocked');
  return { ...result, page: state.currentPage, origin: current.origin };
}
async function investigationTool(p, token) {
  if (!state.planning || state.runId)
    throw fault('Investigation requires an active read request and no test run.', 'blocked');
  const shared = registry.ensure()[p.page || 'main'];
  if (!shared) throw fault('Page is not explicitly shared.', 'blocked');
  const tab = await chrome.tabs.get(shared.tabId);
  if (!isAllowedURL(tab.url, shared.origin))
    throw fault('Shared page left its approved origin.', 'blocked');
  const read = async (tabId, message) => {
    fence.check(token, state);
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    const reply = await chrome.tabs.sendMessage(
      tabId,
      { ...message, maskSelectors: state.settings?.maskSelectors },
      { frameId: 0 },
    );
    fence.check(token, state);
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  };
  if (p.tool === 'observe_page') {
    const view = await read(shared.tabId, { type: 'vqa.observe' });
    if (!isAllowedURL(view.url, shared.origin))
      throw fault('Observation left approved origin.', 'blocked');
    rememberPublicLinks(view, investigationLinks);
    return view;
  }
  if (p.tool === 'inspect_element')
    return read(shared.tabId, { type: 'vqa.inspect', target: p.target });
  if (p.tool === 'search_page') return read(shared.tabId, { type: 'vqa.search', query: p.query });
  if (p.tool === 'diagnostics' || p.tool === 'accessibility') {
    if (shared.alias !== 'main')
      throw fault('Diagnostics currently apply to the primary shared tab.', 'blocked');
    if (p.tool === 'diagnostics') {
      await attach(token);
      return {
        network: network.snapshot('main'),
        runtime: [...diagnostics].slice(-20),
        coverage:
          'Captured events only. Collection starts when debugger attaches; an empty list is not proof of health.',
      };
    }
    await chrome.scripting.executeScript({
      target: { tabId: shared.tabId },
      files: ['axe.min.js'],
    });
    return read(shared.tabId, { type: 'vqa.accessibility' });
  }
  if (p.tool === 'read_link') {
    if (p.allowLinks !== true)
      throw fault('Linked previews are not enabled for this investigation.', 'blocked');
    const url = approvedReadLink(
      p.url,
      [...investigationLinks],
      Object.values(registry.ensure()).map((page) => page.origin),
    );
    const preview = await chrome.tabs.create({ url, active: false });
    try {
      for (let n = 0; n < 100; n++) {
        fence.check(token, state);
        const loaded = await chrome.tabs.get(preview.id);
        if (loaded.url && loaded.url !== 'about:blank' && !registry.allows(loaded.url))
          throw fault('Linked preview redirected outside approved origins.', 'blocked');
        if (loaded.status === 'complete') {
          const view = await read(preview.id, { type: 'vqa.observe' });
          if (!registry.allows(view.url))
            throw fault('Linked preview left approved origins.', 'blocked');
          rememberPublicLinks(view, investigationLinks);
          return { ...view, preview: true };
        }
        await delay(100);
      }
      throw fault('Linked page did not finish loading within 10 seconds.', 'blocked');
    } finally {
      const owned = await chrome.tabs.get(preview.id).catch(() => null);
      if (owned && !owned.active) await chrome.tabs.remove(preview.id).catch(() => {});
    }
  }
  throw fault('Unsupported investigation tool.', 'blocked');
}
async function onNative(message) {
  if (message.type === 'agent.tool') {
    if (state.planning?.id !== message.payload.requestId || state.cancelled) return;
    state.planning.tools = [...(state.planning.tools || []), message.payload].slice(-12);
    broadcast({ type: 'state', state });
    return;
  }
  if (message.type === 'plan.progress') {
    const p = message.payload;
    if (state.cancelled || !state.planning || p.requestId !== state.planning.id) return;
    if (
      !['waiting', 'adapting', 'analyzing', 'generating', 'validating', 'repairing'].includes(
        p.phase,
      )
    )
      return;
    state.planning.phase = p.phase;
    broadcast({ type: 'state', state });
    return;
  }
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
      case 'automation_tool':
        result = await automationRead(p, token);
        break;
      case 'agent_tool':
        result = await investigationTool(p, token);
        break;
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
      case 'current_viewport': {
        activeViewport = null;
        const views = await chrome.scripting.executeScript({
          target: { tabId: state.target.tabId },
          func: () => ({ width: innerWidth, height: innerHeight }),
        });
        fence.check(token, state);
        result = { viewport: views[0].result, mode: 'current-width', page: state.currentPage };
        break;
      }
      case 'resolve_target':
        result = await resolveReady(p.target, token);
        result.submissionAlreadyDispatched = Boolean(
          result.submissionKey && submittedForms.has(result.submissionKey),
        );
        break;
      case 'visual_capture':
        result = await visualCapture(p, token);
        break;
      case 'visual_resolve':
        result = await resolveVisual(p.visual, token, p.actionOperation);
        break;
      case 'execute_visual': {
        if (
          !message.runId ||
          !state.runId ||
          !['click', 'fill', 'key'].includes(p.action?.operation)
        )
          throw fault(
            'Visual input requires a running reviewed mission and an allowed action.',
            'blocked',
          );
        await resolveVisual(p.visual, token, p.action.operation, p.action.target || '');
        await attach(token);
        try {
          result = {
            ...(await execute(p.action, token, '', { ...p.visual, operation: p.action.operation })),
            agent: 'agent-s3',
            model: 'qwen/qwen3.7-flash',
            visual: {
              x: p.visual.x,
              y: p.visual.y,
              snapshot: p.visual.snapshot,
              target: p.action.target || '',
            },
          };
        } finally {
          visualSnapshot = null;
        }
        break;
      }
      case 'action_context':
        result = await content(
          {
            type: 'vqa.action-context',
            target: p.target || '',
            focused: !p.target,
            key: p.key || '',
          },
          token,
        );
        result.submissionAlreadyDispatched = Boolean(
          result.submissionKey && submittedForms.has(result.submissionKey),
        );
        break;
      case 'execute':
        await attach(token);
        result = await execute(p.action, token, p.secure === true ? p.secureOrigin : '');
        break;
      case 'capture':
        result = await capture(p.maskSelectors, token, p.visualMaskSelectors);
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
    if (['observe', 'observe_page'].includes(p.operation))
      rememberPublicLinks(result, investigationLinks);
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
  network.event(method, p, state.currentPage);
  const entry = runtimeDiagnostic(method, p, state.currentPage, publicURL);
  if (entry) diagnostics.push({ ...entry, at: new Date().toISOString() });
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
  if (state.planning && tabId !== state.target?.tabId) {
    void stop();
    return;
  }
  if (state.runId && !registry.switching && tabId !== state.target?.tabId) {
    state.paused = true;
    void save();
  }
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (
    state.planning &&
    tabId === state.target?.tabId &&
    change.url &&
    change.url !== state.planning.url
  )
    void stop();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!registry.switching && tabId === state.target?.tabId) {
    void stop();
    state.target = null;
    void save();
  }
});
export { handlePanel };
