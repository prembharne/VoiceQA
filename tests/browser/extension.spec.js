import { test, expect, chromium } from '@playwright/test';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

test.describe.configure({ mode: 'serial' });
let context, worker, target, control, extensionId;
const work = resolve('test-results/native-integration');
const manifestPath = resolve(work, 'native-host.json');
const backupPath = resolve(work, 'registry-backup.json');
async function invoke(method, payload = {}) {
  return control.evaluate(({ method, payload }) => globalThis.__testRPC(method, payload), {
    method,
    payload,
  });
}
async function suite(url, visual = false) {
  await target.goto(url);
  await target.bringToFront();
  const tabId = await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === url)?.id;
  }, url);
  await invoke('bind', { tabId });
  const plan = await invoke('plan.propose', {
    request: 'Run the demo fixture',
    demo: true,
    responsive: true,
    visual,
  });
  await invoke('plan.confirm', { id: plan.id, version: plan.version });
  const { runId } = await invoke('run.start', {
    planId: plan.id,
    version: plan.version,
    key: crypto.randomUUID(),
  });
  await expect
    .poll(
      async () => {
        const run = await invoke('run.get', { id: runId });
        return run.status;
      },
      { timeout: 120000, intervals: [300, 500] },
    )
    .not.toBe('running');
  return invoke('run.get', { id: runId });
}
test.beforeAll(async () => {
  test.skip(
    process.platform !== 'win32',
    'Native installation integration currently targets Windows',
  );
  await mkdir(work, { recursive: true });
  await cp(resolve('dist/extension'), resolve(work, 'extension'), { recursive: true });
  const extensionManifest = JSON.parse(
    await readFile(resolve(work, 'extension/manifest.json'), 'utf8'),
  );
  extensionManifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(resolve(work, 'extension/manifest.json'), JSON.stringify(extensionManifest));
  context = await chromium.launchPersistentContext(resolve(work, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${resolve(work, 'extension')}`,
      `--load-extension=${resolve(work, 'extension')}`,
    ],
    env: { ...process.env, VOICEQA_DATA_DIR: resolve(work, 'data'), OPENAI_API_KEY: '' },
  });
  worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
  await writeFile(
    manifestPath,
    JSON.stringify({
      name: 'com.voiceqa.companion',
      description: 'VoiceQA integration-test host',
      path: resolve('dist/voiceqa-host.exe'),
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`],
    }),
  );
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-File',
    resolve('scripts/test-host-registration.ps1'),
    '-Mode',
    'install',
    '-ManifestPath',
    manifestPath,
    '-BackupPath',
    backupPath,
  ]);
  await context.addInitScript(() => {
    if (!globalThis.chrome?.runtime?.connect) return;
    const original = chrome.runtime.connect.bind(chrome.runtime);
    globalThis.__voiceqaTestPorts = [];
    chrome.runtime.connect = (...args) => {
      const port = original(...args);
      if (args[0]?.name === 'voiceqa-panel') globalThis.__voiceqaTestPorts.push(port);
      return port;
    };
  });
  control = await context.newPage();
  await control.goto(`chrome-extension://${extensionId}/panel.html`);
  await control.evaluate(() => {
    const port = chrome.runtime.connect({ name: 'voiceqa-panel' });
    const tasks = new Map();
    port.onMessage.addListener((message) => {
      if (message.type !== 'response') return;
      const task = tasks.get(message.id);
      if (!task) return;
      tasks.delete(message.id);
      message.error ? task.reject(new Error(message.error)) : task.resolve(message.result);
    });
    globalThis.__testRPC = (method, payload) =>
      new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        tasks.set(id, { resolve, reject });
        port.postMessage({ type: 'request', id, method, payload });
      });
  });
  const hello = await invoke('connect');
  expect(hello.version).toBe(1);
  // Most regression fixtures use fast mode; the paced-run test verifies real gaps.
  expect(hello.settings.stepDelayMs).toBe(4000);
  await invoke('settings.save', { stepDelayMs: 0 });
  target = await context.newPage();
});
test.afterAll(async () => {
  await context?.close();
  if (process.platform === 'win32')
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-File',
      resolve('scripts/test-host-registration.ps1'),
      '-Mode',
      'restore',
      '-BackupPath',
      backupPath,
    ]);
});
test('empty history gives a clear next step before the first run', async () => {
  await control.bringToFront();
  await control.setViewportSize({ width: 420, height: 900 });
  await control.getByRole('button', { name: 'History', exact: true }).click();
  await expect(control.getByRole('heading', { name: 'A clean slate' })).toBeVisible();
  await expect(control.getByRole('button', { name: 'Start your first test' })).toBeVisible();
  await control.screenshot({ path: resolve(work, 'empty-history.png'), fullPage: true });
  await control.getByRole('button', { name: 'Start your first test' }).click();
  await expect(control.getByRole('heading', { name: 'From intention to verified action.' })).toBeVisible();
});
test('website URL is readable before site access and Test this tab selects the active website', async () => {
  // Unlike 127.0.0.1, localhost has no pre-granted host permission in this fixture.
  await target.goto('http://localhost:4173/');
  await target.bringToFront();
  const selection = await control.evaluate(async () => ({
    tab: (await chrome.tabs.query({ active: true, currentWindow: true }))[0],
    access: await chrome.permissions.contains({ origins: ['http://localhost/*'] }),
  }));
  expect(selection.access).toBe(false);
  expect(selection.tab.url).toBe('http://localhost:4173/');

  await target.goto('http://127.0.0.1:4173/fixtures/shop');
  await target.bringToFront();
  // A side panel click leaves the website active. Evaluate the actual DOM click
  // because this test renders the panel in a tab, which Playwright would activate.
  await control
    .getByRole('button', { name: 'Share current tab' })
    .evaluate((button) => button.click());
  await expect
    .poll(async () => (await invoke('state')).target?.url)
    .toBe('http://127.0.0.1:4173/fixtures/shop');
  await expect(control.locator('.sharing-chip')).toContainText('Sharing');
  await expect(control.getByRole('alert')).toHaveCount(0);

  await control.bringToFront();
  await control.getByRole('button', { name: 'Stop sharing this tab' }).click();
  await expect(control.getByRole('button', { name: 'Share current tab' })).toBeVisible();
  await control.getByRole('button', { name: 'Share current tab' }).click();
  await expect(control.getByRole('alert')).toContainText('Switch to a normal website');
  await target.bringToFront();
  await control
    .getByRole('button', { name: 'Share current tab' })
    .evaluate((button) => button.click());
  await expect(control.getByRole('alert')).toHaveCount(0);
});

test('paced execution shows each action and Stop interrupts the gap', async () => {
  await control.bringToFront();
  await control.getByLabel('Test options', { exact: true }).click();
  await control.getByLabel('Gap between steps').selectOption('3000');
  await control.getByLabel('Test options', { exact: true }).click();
  await expect.poll(async () => (await invoke('settings.get')).stepDelayMs).toBe(3000);
  await target.goto('http://127.0.0.1:4173/fixtures/shop');
  await target.bringToFront();
  const plan = await invoke('plan.propose', { request: 'Run fixture', demo: true });
  await invoke('plan.confirm', { id: plan.id, version: plan.version });
  const { runId } = await invoke('run.start', {
    planId: plan.id,
    version: plan.version,
    key: crypto.randomUUID(),
  });
  await expect
    .poll(
      async () => {
        const r = await invoke('run.get', { id: runId });
        const last = r.steps.at(-1);
        return (
          last?.action.target === 'testid:add-mug' &&
          last.status === 'passed' &&
          Boolean(r.nextStepAt)
        );
      },
      { timeout: 20000, intervals: [100] },
    )
    .toBe(true);
  const run = await invoke('run.get', { id: runId });
  expect(run.stepDelayMs).toBe(3000);
  expect(run.nextStep.action.label).toBe('Add another mug');
  await expect(control.getByRole('button', { name: 'Stop sharing this tab' })).toBeDisabled();
  await expect(invoke('unbind')).rejects.toThrow('Stop the active run');
  for (let i = 1; i < run.steps.length; i++) {
    expect(
      Date.parse(run.steps[i].startedAt) - Date.parse(run.steps[i - 1].completedAt),
    ).toBeGreaterThanOrEqual(2900);
  }
  await expect(target.getByTestId('mug-count')).toHaveText('1');
  await expect(control.getByRole('region', { name: 'Live test progress' })).toContainText(
    'Next in',
  );
  await control.screenshot({ path: resolve(work, 'step-countdown.png'), fullPage: true });
  const began = Date.now();
  await control.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect
    .poll(async () => (await invoke('run.get', { id: runId })).status, {
      timeout: 2500,
      intervals: [50],
    })
    .toBe('cancelled');
  expect(Date.now() - began).toBeLessThan(2500);
  await expect(target.getByTestId('mug-count')).toHaveText('1');
  expect((await invoke('run.get', { id: runId })).nextStep).toBeUndefined();
  await invoke('settings.save', { stepDelayMs: 0 });
});

test('healthy desktop/mobile fixture performs real browser actions and passes', async () => {
  const run = await suite('http://127.0.0.1:4173/fixtures/shop');
  expect(run.status, JSON.stringify(run, null, 2)).toBe('passed');
  expect(run.plan.model).toBe('fixture-demo');
  expect(
    run.steps.filter((s) => s.action.operation === 'assert').every((s) => s.status === 'passed'),
  ).toBe(true);
  const capture = run.steps.find((s) => s.result?.capture)?.result.capture;
  expect(capture.artifactId).toMatch(/^[a-f0-9]{32}$/);
  const image = await invoke('artifact.get', { id: capture.artifactId, offset: 0 });
  expect(Buffer.from(image.data, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const report = await invoke('report.export', { id: run.id, format: 'xml' });
  const data = await invoke('artifact.get', { id: report.artifactId, offset: 0 });
  expect(Buffer.from(data.data, 'base64').toString()).toContain('failures="0"');
});
test('wrong business total is failed rather than agent-complete passed', async () => {
  const run = await suite('http://127.0.0.1:4173/fixtures/shop?bug=total');
  expect(run.status).toBe('failed');
  expect(
    run.steps.some(
      (s) =>
        s.action.assertion?.kind === 'number' && s.status === 'failed' && s.result.actual === 29,
    ),
  ).toBe(true);
});
test('missing coupon feedback is failed with explicit expected/actual evidence', async () => {
  const run = await suite('http://127.0.0.1:4173/fixtures/shop?bug=coupon');
  expect(run.status).toBe('failed');
  expect(
    run.steps.some((s) => s.status === 'failed' && s.result?.expected === 'Coupon is not valid'),
  ).toBe(true);
});
test('visual baselines require explicit approval and rerun', async () => {
  let run = await suite('http://127.0.0.1:4173/fixtures/shop', true);
  expect(run.status).toBe('needs_review');
  for (const step of run.steps.filter((s) => s.result?.capture))
    await invoke('baseline.approve', { runId: run.id, stepId: step.id });
  run = await suite('http://127.0.0.1:4173/fixtures/shop', true);
  expect(run.status, JSON.stringify(run, null, 2)).toBe('passed');
  expect(run.steps.some((s) => s.result?.visual?.status === 'passed')).toBe(true);
});
test('accessibility and mobile overflow defects are detected', async () => {
  const access = await suite('http://127.0.0.1:4173/fixtures/shop?bug=accessibility');
  expect(access.status).toBe('failed');
  expect(
    access.steps.some((s) => s.action.operation === 'accessibility' && s.result.seriousCount > 0),
  ).toBe(true);
  const overflow = await suite('http://127.0.0.1:4173/fixtures/shop?bug=overflow');
  expect(overflow.status).toBe('failed');
  expect(
    overflow.steps.some((s) => s.action.assertion?.kind === 'no_overflow' && s.status === 'failed'),
  ).toBe(true);
});
test('cancellation stops new actions and detaches the debugger', async () => {
  const url = 'http://127.0.0.1:4173/fixtures/shop?bug=order';
  await target.goto(url);
  await target.bringToFront();
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id,
    url,
  );
  await invoke('bind', { tabId });
  const plan = await invoke('plan.propose', { request: 'Run fixture', demo: true });
  await invoke('plan.confirm', { id: plan.id, version: plan.version });
  const { runId } = await invoke('run.start', {
    planId: plan.id,
    version: plan.version,
    key: crypto.randomUUID(),
  });
  const began = Date.now();
  await invoke('cancel');
  await expect
    .poll(async () => (await invoke('run.get', { id: runId })).status, {
      timeout: 10000,
      intervals: [100],
    })
    .toBe('cancelled');
  expect(Date.now() - began).toBeLessThan(3000);
  expect((await invoke('state')).attached).toBe(false);
  const ownSession = await worker.evaluate(async (tabId) => {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1' });
      return 'attached';
    } catch {
      return 'detached';
    }
  }, tabId);
  expect(ownSession).toBe('detached');
});
test('planning without credentials fails explicitly rather than falling back', async () => {
  await target.goto('http://127.0.0.1:4173/fixtures/shop');
  await target.bringToFront();
  const tabId = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({})).find((t) => t.url === 'http://127.0.0.1:4173/fixtures/shop')
        ?.id,
  );
  await invoke('bind', { tabId });
  await expect(
    invoke('plan.propose', { request: 'Check the cart total', demo: false, responsive: false }),
  ).rejects.toThrow('Configure an API key');
});

test('chat shows planning phases and elapsed time, restores a failed request and ignores cancelled results', async () => {
  test.setTimeout(30000);
  const panel = await context.newPage();
  await panel.addInitScript(() => {
    const listeners = [];
    let pending;
    const state = {
      connected: true,
      target: {
        title: 'RelayDesk test',
        url: 'http://127.0.0.1:4173/',
        origin: 'http://127.0.0.1:4173',
      },
      settings: {
        model: 'test/model',
        aiProvider: 'openrouter',
        hasApiKey: true,
        ttsProvider: 'browser',
        stepDelayMs: 4000,
      },
      planning: null,
    };
    const emit = (message) => listeners.forEach((fn) => fn(message));
    globalThis.__planningFixture = {
      phase(phase) {
        state.planning.phase = phase;
        emit({ type: 'state', state });
      },
      fail() {
        state.planning = null;
        emit({ type: 'state', state });
        emit({
          type: 'response',
          id: pending.id,
          error:
            'The AI provider did not finish building the plan within 4 minutes. No tests were run.',
        });
      },
      late() {
        emit({
          type: 'response',
          id: pending.id,
          result: {
            id: 'late-plan',
            summary: 'Late draft must not appear',
            cases: [],
            clarification: 'stale',
          },
        });
      },
    };
    chrome.runtime.connect = () => ({
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onDisconnect: { addListener() {} },
      disconnect() {},
      postMessage(request) {
        if (request.method === 'plan.propose') {
          pending = request;
          state.planning = { id: request.id, startedAt: Date.now() - 65000, phase: 'waiting' };
          queueMicrotask(() => emit({ type: 'state', state }));
          return;
        }
        if (request.method === 'cancel') state.planning = null;
        const result =
          request.method === 'connect'
            ? { settings: state.settings }
            : request.method.endsWith('.list')
              ? []
              : {};
        queueMicrotask(() => {
          emit({ type: 'state', state });
          emit({ type: 'response', id: request.id, result });
        });
      },
    });
  });
  try {
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    const composer = panel.getByRole('textbox', { name: 'Test request', exact: true });
    const prompt = 'Discover and test the complete order workflow.';
    await composer.fill(prompt);
    await panel.getByRole('button', { name: 'Send test request', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('Waiting for your AI provider');
    await expect(panel.locator('.planning-elapsed')).toHaveText(/1:0[5-9]/);
    await panel.evaluate(() => globalThis.__planningFixture.phase('adapting'));
    await expect(panel.getByRole('status')).toContainText('checked locally');
    await panel.evaluate(() => globalThis.__planningFixture.phase('generating'));
    await expect(panel.getByRole('status')).toContainText('Building your test plan');
    await panel.screenshot({ path: resolve(work, 'planning-progress.png'), fullPage: true });
    await panel.evaluate(() => globalThis.__planningFixture.fail());
    await expect(composer).toHaveValue(prompt);
    await expect(panel.locator('.thinking-message')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Send test request', exact: true }).click();
    await expect(panel.locator('.thinking-message')).toBeVisible();
    await panel.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(panel.locator('.thinking-message')).toHaveCount(0);
    await panel.evaluate(() => globalThis.__planningFixture.late());
    await expect(panel.getByText('Late draft must not appear')).toHaveCount(0);
    await expect(panel.getByRole('alert')).toHaveCount(1); // Preserve the earlier timeout message in chat.
  } finally {
    await panel.close();
  }
});
test('paused asynchronous actions cannot revive after cancellation', async () => {
  const url = 'http://127.0.0.1:4173/fixtures/shop';
  await target.goto(url);
  await target.bringToFront();
  const tabId = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({})).find((t) => t.url === 'http://127.0.0.1:4173/fixtures/shop')
        ?.id,
  );
  await invoke('bind', { tabId });
  const plan = await invoke('plan.propose', { request: 'Run fixture', demo: true });
  await invoke('plan.confirm', { id: plan.id, version: plan.version });
  const { runId } = await invoke('run.start', {
    planId: plan.id,
    version: plan.version,
    key: crypto.randomUUID(),
  });
  await control.bringToFront();
  await expect.poll(async () => (await invoke('state')).paused).toBe(true);
  await invoke('cancel');
  await expect.poll(async () => (await invoke('run.get', { id: runId })).status).toBe('cancelled');
  const before = await target.getByTestId('mug-count').textContent();
  await target.bringToFront();
  await expect.poll(async () => (await invoke('state')).attached, { timeout: 1000 }).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(await target.getByTestId('mug-count').textContent()).toBe(before);
});
test('chat reviews a fixture plan and streams a real run into the conversation', async () => {
  await control.getByRole('button', { name: 'New chat', exact: true }).click();
  await target.goto('http://127.0.0.1:4173/fixtures/shop');
  await target.bringToFront();
  const tabId = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({})).find((t) => t.url === 'http://127.0.0.1:4173/fixtures/shop').id,
  );
  await invoke('bind', { tabId });
  await control
    .getByRole('button', { name: 'Run the demo test suite', exact: true })
    .evaluate((button) => button.click());
  await expect(control.locator('.user-message')).toContainText('Run the local demo fixture suite.');
  await expect(control.getByRole('heading', { name: 'Test plan', exact: true })).toBeVisible();
  await control.screenshot({ path: resolve(work, 'chat-plan.png'), fullPage: true });
  await control
    .getByRole('button', { name: 'Confirm and run tests', exact: true })
    .evaluate((button) => button.click());
  await expect(control.getByRole('heading', { name: 'Test results', exact: true })).toBeVisible();
  await expect.poll(async () => (await invoke('state')).runId, { timeout: 15000 }).toBe(null);
  await expect(control.locator('.result-banner .status')).toHaveText('passed');
  await expect(control.getByRole('button', { name: 'Export HTML', exact: true })).toBeVisible();
  await control.screenshot({ path: resolve(work, 'chat-results.png'), fullPage: true });
});

test('side panel renders offline-safe UI without remote code or JavaScript errors', async () => {
  const errors = [];
  control.on('pageerror', (e) => errors.push(e.message));
  await control.bringToFront();
  await control.getByRole('button', { name: 'New chat', exact: true }).click();
  await control.setViewportSize({ width: 420, height: 1000 });
  await expect(control.getByRole('heading', { name: 'From intention to verified action.' })).toBeVisible();
  await control.screenshot({ path: resolve(work, 'side-panel.png'), fullPage: true });
  expect(errors).toEqual([]);
});
test('the panel recovers from its disconnected port without reopening the page', async () => {
  test.setTimeout(30000);
  await control.bringToFront();
  await control.getByRole('button', { name: 'Open settings' }).click();
  await expect(control.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await control.evaluate(() => globalThis.__voiceqaTestPorts[0].disconnect());
  await control.getByRole('button', { name: 'Save API key', exact: true }).click();
  await expect(
    control.getByRole('heading', { name: 'Bring your test engine online.' }),
  ).toBeVisible();
  await expect(control.getByLabel('Extension ID', { exact: true })).toHaveValue(extensionId);
  await control.screenshot({ path: resolve(work, 'connection-recovery.png'), fullPage: true });
  await control.getByRole('button', { name: 'Retry connection', exact: true }).click();
  await expect(control.locator('.engine-dot.connected')).toBeVisible();
  await control.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(control.getByRole('heading', { name: 'From intention to verified action.' })).toBeVisible();
});
test('polished views fit narrow and wide panels and respect reduced motion', async () => {
  await control.bringToFront();
  await control.getByRole('button', { name: 'New chat', exact: true }).click();
  for (const width of [330, 600]) {
    await control.setViewportSize({ width, height: 950 });
    await expect
      .poll(() => control.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await control.screenshot({ path: resolve(work, `panel-${width}.png`), fullPage: true });
  }
  await control.emulateMedia({ reducedMotion: 'reduce' });
  await control.getByRole('button', { name: 'History', exact: true }).click();
  await expect(control.getByRole('heading', { name: 'Run history' })).toBeVisible();
  await control.screenshot({ path: resolve(work, 'history.png'), fullPage: true });
  await control.addScriptTag({ url: `chrome-extension://${extensionId}/axe.min.js` });
  const issues = await control.evaluate(async () => {
    const result = await axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    });
    return result.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact))
      .map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }));
  });
  expect(issues).toEqual([]);
  await control.emulateMedia({ reducedMotion: 'no-preference' });
});
test('Settings contains only provider/key controls and saves NVIDIA keys privately', async () => {
  await control.bringToFront();
  await control.getByRole('button', { name: 'Open settings' }).click();
  await expect(control.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(control.locator('.api-settings input')).toHaveCount(1);
  for (const label of [
    'Reasoning model',
    'Transcription model',
    'Speech provider',
    'Text-to-speech API key',
    'Profile alias',
    'Redacted CSS selectors',
  ])
    await expect(control.getByLabel(label, { exact: true })).toHaveCount(0);
  await control.getByLabel('AI provider').selectOption('nvidia');
  const key = control.getByLabel('NVIDIA NIM API key', { exact: true });
  await expect(key).toHaveAttribute('type', 'password');
  await key.fill('nvapi-isolated-fixture');
  await control.getByRole('button', { name: 'Save API key', exact: true }).click();
  await expect.poll(async () => (await invoke('settings.get')).aiProvider).toBe('nvidia');
  await expect(key).toHaveValue('');
  const settings = await invoke('settings.get');
  expect(settings.hasApiKey).toBe(true);
  expect(settings.model).toBe('nvidia/nemotron-3-nano-30b-a3b');
  expect(settings.apiKey).toBeUndefined();
  expect(JSON.stringify(settings)).not.toContain('nvapi-isolated-fixture');
  await control.setViewportSize({ width: 360, height: 800 });
  expect(await control.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await control.screenshot({ path: resolve(work, 'clean-api-settings.png'), fullPage: true });
  await control.getByLabel('AI provider').selectOption('openai');
  await control.getByRole('button', { name: 'Save API key', exact: true }).click();
  await expect.poll(async () => (await invoke('settings.get')).aiProvider).toBe('openai');
});

test('OpenRouter key setup keeps models in the composer and preserves blank saved keys', async () => {
  await control.getByLabel('AI provider').selectOption('openrouter');
  await expect(control.getByLabel('OpenRouter API key', { exact: true })).toBeVisible();
  await control.getByRole('button', { name: 'Save API key', exact: true }).click();
  await expect.poll(async () => (await invoke('settings.get')).aiProvider).toBe('openrouter');
  await control.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await control.getByLabel('Choose AI model', { exact: true }).click();
  const bounds = await control.locator('.model-popover').boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(control.viewportSize().width);
  await expect(control.getByLabel('AI model', { exact: true })).toHaveValue('openai/gpt-4o');
  await control.getByLabel('AI model', { exact: true }).fill('test/structured-model');
  await control.getByRole('button', { name: 'Use model', exact: true }).click();
  await expect.poll(async () => (await invoke('settings.get')).model).toBe('test/structured-model');
  await control.getByRole('button', { name: 'Open settings' }).click();
  await control.getByLabel('AI provider').selectOption('openai');
  await control.getByRole('button', { name: 'Save API key', exact: true }).click();
  await expect.poll(async () => (await invoke('settings.get')).aiProvider).toBe('openai');
});

test('microphone transcribes editable text without an API key or automatic submission', async () => {
  test.setTimeout(30000);
  const panel = await context.newPage();
  await panel.addInitScript(() => {
    globalThis.SpeechRecognition = class {
      start() {
        globalThis.__dictation = this;
        this.onstart?.();
      }
      stop() {
        this.onend?.();
      }
      abort() {
        this.onend?.();
      }
    };
  });
  try {
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    const composer = panel.getByRole('textbox', { name: 'Test request', exact: true });
    await composer.fill('Please');
    const plansBefore = (await invoke('plan.list')).length;
    await panel.getByRole('button', { name: 'Transcribe request', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('Listening');
    await panel.evaluate(() =>
      globalThis.__dictation.onresult({ results: [[{ transcript: 'test the order' }]] }),
    );
    await expect(composer).toHaveValue('Please test the order');
    await panel.evaluate(() =>
      globalThis.__dictation.onresult({
        results: [[{ transcript: 'test the order and invoice' }]],
      }),
    );
    await expect(composer).toHaveValue('Please test the order and invoice');
    await panel.screenshot({ path: resolve(work, 'dictation-draft.png'), fullPage: true });
    await panel.getByRole('button', { name: 'Finish transcription', exact: true }).click();
    await expect(composer).toBeEditable();
    await composer.fill('Please test the order and invoice on mobile.');
    expect((await invoke('plan.list')).length).toBe(plansBefore);
    await expect(panel.getByText('Your proposed plan', { exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Transcribe request', exact: true }).click();
    await panel.getByRole('button', { name: 'Stop', exact: true }).click();
    await panel.evaluate(() =>
      globalThis.__dictation.onresult({ results: [[{ transcript: 'stale speech' }]] }),
    );
    await expect(composer).toHaveValue('Please test the order and invoice on mobile.');
  } finally {
    await panel.close();
  }
});

const advancedOrigin = 'http://127.0.0.1:4174';
const testSeed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
async function advancedRun() {
  await target.goto(advancedOrigin + '/advanced');
  await target.bringToFront();
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id,
    advancedOrigin + '/advanced',
  );
  await invoke('bind', { tabId });
  const plan = await invoke('plan.propose', {
    request: 'Run the advanced fixture',
    demo: true,
    responsive: true,
  });
  await invoke('plan.confirm', { id: plan.id, version: plan.version });
  const { runId } = await invoke('run.start', {
    planId: plan.id,
    version: plan.version,
    key: crypto.randomUUID(),
  });
  await expect
    .poll(
      async () => {
        const r = await invoke('run.get', { id: runId });
        if (r.status !== 'running') throw new Error(JSON.stringify(r, null, 2));
        return r.handoff ? 'checkpoint' : r.status;
      },
      { timeout: 60000, intervals: [250] },
    )
    .toBe('checkpoint');
  return { runId, plan, tabId };
}

test('test credentials live in Test options and no plaintext is returned', async () => {
  await control.bringToFront();
  await control.getByRole('button', { name: 'New chat', exact: true }).click();
  await control.getByLabel('Test options', { exact: true }).click();
  await control.getByRole('button', { name: 'Test credentials & MFA', exact: true }).click();
  await control.getByLabel('Profile alias', { exact: true }).fill('advanced-test');
  await control.getByLabel('Profile label', { exact: true }).fill('Advanced lab');
  await control.getByLabel('Credential origin', { exact: true }).fill(advancedOrigin);
  await control.getByLabel('Test username', { exact: true }).fill('qa@voiceqa.test');
  await control.getByLabel('Test password', { exact: true }).fill('fixture-only');
  await control.getByLabel('TOTP seed or otpauth URI', { exact: true }).fill(testSeed);
  await control.getByRole('button', { name: 'Save test credentials', exact: true }).click();
  await expect(control.locator('.auth-profile')).toContainText('advanced-test');
  const profiles = await invoke('auth.list');
  expect(profiles[0]).toMatchObject({
    id: 'advanced-test',
    hasTotp: true,
    hasPassword: true,
    hasUsername: true,
  });
  expect(JSON.stringify(profiles)).not.toContain(testSeed);
  expect(JSON.stringify(profiles)).not.toContain('fixture-only');
  await expect(control.getByLabel('Test password', { exact: true })).toHaveValue('');
  await control.setViewportSize({ width: 330, height: 950 });
  expect(await control.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await control.screenshot({ path: resolve(work, 'auth-settings.png'), fullPage: true });
  await control.getByRole('button', { name: 'New chat', exact: true }).click();
});

test('shared-page picker approves an additional tab and unsharing leaves the user tab open', async () => {
  await target.goto(advancedOrigin + '/advanced');
  await target.bringToFront();
  const mainId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id,
    advancedOrigin + '/advanced',
  );
  await invoke('bind', { tabId: mainId });
  const extra = await context.newPage();
  await extra.goto('http://127.0.0.1:4173/fixtures/shop');
  const extraId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id,
    'http://127.0.0.1:4173/fixtures/shop',
  );
  await control.bringToFront();
  await control.getByLabel('Test options', { exact: true }).click();
  await control.getByRole('button', { name: 'Choose another tab', exact: true }).click();
  await expect(control.getByLabel('Additional website tab', { exact: true })).toBeVisible({
    timeout: 10000,
  });
  await control.getByLabel('Additional website tab', { exact: true }).selectOption(String(extraId));
  await control
    .getByRole('button', { name: 'Share selected tab', exact: true })
    .evaluate((button) => button.click());
  await expect.poll(async () => (await invoke('pages.list')).length).toBe(2);
  await expect(control.locator('.shared-page')).toHaveCount(2);
  await expect(invoke('pages.share', { tabId: extraId })).rejects.toThrow('already shared');
  await control.screenshot({ path: resolve(work, 'shared-pages.png'), fullPage: true });
  await control
    .getByRole('button', { name: 'Unshare page2', exact: true })
    .evaluate((button) => button.click());
  await expect.poll(async () => (await invoke('pages.list')).length).toBe(1);
  expect(extra.isClosed()).toBe(false);
  await control.getByLabel('Test options', { exact: true }).evaluate((button) => button.click());
  await extra.close();
});

test('advanced real-browser fixture verifies TOTP, tab isolation, readiness and human completion', async () => {
  const { runId, plan, tabId } = await advancedRun();
  let run = await invoke('run.get', { id: runId });
  expect(run.handoff.kind).toBe('captcha');
  expect(run.steps.filter((s) => s.action.operation === 'assert')).toHaveLength(5);
  expect(
    run.steps.filter((s) => s.action.operation === 'assert').every((s) => s.status === 'passed'),
  ).toBe(true);
  const wait = run.steps.find((s) => s.action.operation === 'wait_for');
  expect(Date.parse(wait.completedAt) - Date.parse(wait.startedAt)).toBeGreaterThanOrEqual(800);
  expect(run.steps.some((s) => s.page === 'child' && s.status === 'passed')).toBe(true);
  const serialized = JSON.stringify({ plan, run });
  for (const secret of [testSeed, 'fixture-only', 'qa@voiceqa.test'])
    expect(serialized).not.toContain(secret);
  const state = await invoke('state');
  expect(state.pages.child).toBeUndefined();
  expect(state.target.tabId).toBe(tabId);
  await expect(
    control.getByRole('button', { name: 'I completed the checkpoint', exact: true }),
  ).toBeVisible();
  await control.screenshot({ path: resolve(work, 'human-checkpoint.png'), fullPage: true });
  await target.getByTestId('complete-test-captcha').click();
  await control
    .getByRole('button', { name: 'I completed the checkpoint', exact: true })
    .evaluate((button) => button.click());
  await expect
    .poll(async () => (await invoke('run.get', { id: runId })).status, { timeout: 15000 })
    .toBe('passed');
  run = await invoke('run.get', { id: runId });
  expect(run.steps.filter((s) => s.action.operation === 'assert')).toHaveLength(6);
  expect(run.handoff).toBeUndefined();
  expect((await invoke('state')).attached).toBe(false);
  expect(target.isClosed()).toBe(false);
  expect(
    run.steps.filter((s) => s.result?.capture).every((s) => s.result.capture.width === 1440),
  ).toBe(true);
  await writeFile(resolve(work, 'advanced-run.json'), JSON.stringify(run, null, 2));
});

test('checkpoint cancellation prevents late completion from resuming the run', async () => {
  const { runId } = await advancedRun();
  const gate = (await invoke('run.get', { id: runId })).handoff;
  await invoke('cancel');
  await expect.poll(async () => (await invoke('run.get', { id: runId })).status).toBe('cancelled');
  await expect(invoke('handoff.complete', { id: gate.id })).rejects.toThrow('no longer active');
  const run = await invoke('run.get', { id: runId });
  expect(run.steps.filter((s) => s.action.operation === 'assert')).toHaveLength(5);
  expect(run.handoff).toBeUndefined();
  expect((await invoke('state')).attached).toBe(false);
});

test('operator acknowledgment cannot pass an uncompleted challenge', async () => {
  const { runId } = await advancedRun();
  const gate = (await invoke('run.get', { id: runId })).handoff;
  await invoke('handoff.complete', { id: gate.id });
  await expect
    .poll(async () => (await invoke('run.get', { id: runId })).status, { timeout: 15000 })
    .toBe('failed');
  const run = await invoke('run.get', { id: runId });
  expect(run.steps.at(-1).status).toBe('failed');
  expect(run.steps.at(-1).result.expected).toBe('CAPTCHA fixture completed');
  expect(run.steps.at(-1).result.actual).not.toBe('CAPTCHA fixture completed');
});

test('mandatory private-field redaction survives an empty custom mask', async () => {
  await target.goto(advancedOrigin + '/advanced');
  await target.bringToFront();
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id,
    advancedOrigin + '/advanced',
  );
  await invoke('bind', { tabId });
  const old = (await invoke('settings.get')).maskSelectors;
  await invoke('settings.save', { maskSelectors: '' });
  try {
    await target.getByTestId('auth-password').fill('private-value-for-test');
    await target.getByTestId('auth-otp').fill('123456');
    const view = await invoke('observe');
    expect(view.controls.find((c) => c.target === 'testid:auth-password').value).toBe('[redacted]');
    expect(view.controls.find((c) => c.target === 'testid:auth-otp').value).toBe('[redacted]');
    const response = await worker.evaluate(
      (tabId) =>
        chrome.tabs.sendMessage(tabId, {
          type: 'vqa.assert',
          action: { target: 'testid:auth-otp', assertion: { kind: 'value', expected: '123456' } },
        }),
      tabId,
    );
    expect(response.error).toContain('redacted values');
    expect(response.result).toBeUndefined();
  } finally {
    await invoke('settings.save', { maskSelectors: old });
  }
});

test('IDE controls expose stable unnamed handles, focus the editor and clip hit points', async () => {
  await target.goto('http://127.0.0.1:4173/fixtures/shop');
  await target.bringToFront();
  const tabId = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({})).find((t) => t.url === 'http://127.0.0.1:4173/fixtures/shop').id,
  );
  await invoke('bind', { tabId });
  await target.setContent(`<style>body{margin:40px}.editor{position:relative;width:400px;height:200px;border:1px solid}textarea{position:absolute;left:16px;top:16px;width:1px;height:1px;padding:0;border:0}#clipped{position:fixed;left:-30px;top:400px;width:50px;height:40px}</style>
    ${Array.from({ length: 60 }, (_, i) => `<button>Tool ${i}</button>`).join('')}
    <div data-id="folder" draggable="true">contracts</div>
    <input data-id="filename"><div role="code" class="editor"><textarea role="textbox" aria-label="Editor content" aria-roledescription="editor"></textarea></div>
    <div contenteditable="true" aria-label="Rich text"></div><div contenteditable="true" data-private>secret-sentinel</div>
    <button id="clipped">Edge</button>`);
  await target.locator('[data-id=filename]').focus();
  const view = await invoke('observe');
  const folder = view.controls.find((c) => c.name === 'contracts');
  const filename = view.controls.find((c) => c.focused && c.role === 'textbox');
  expect(folder.target).toMatch(/^node:\d+$/);
  expect(filename.target).toMatch(/^node:\d+$/);
  expect(view.controls.indexOf(filename)).toBeLessThan(40);
  expect(JSON.stringify(view)).not.toContain('secret-sentinel');
  expect((await invoke('observe')).controls.find((c) => c.name === 'contracts').target).toBe(
    folder.target,
  );
  const send = (message) =>
    worker.evaluate(({ tabId, message }) => chrome.tabs.sendMessage(tabId, message), {
      tabId,
      message,
    });
  const found = await send({ type: 'vqa.search', query: 'contracts' });
  expect(found.result.matches.some((m) => m.target === folder.target)).toBe(true);
  await target.locator('[data-id=filename]').evaluate((el) => {
    el.pattern = 'rel-[a-z]{4,8}';
    el.maxLength = 12;
    el.setAttribute('aria-describedby', 'constraint-help');
    const hint = document.createElement('p');
    hint.id = 'constraint-help';
    hint.innerHTML = 'Public rule <span data-private>private-description-sentinel</span>';
    el.after(hint);
  });
  const details = (await send({ type: 'vqa.inspect', target: filename.target })).result;
  expect(details.pattern).toBe('rel-[a-z]{4,8}');
  expect(details.maxLength).toBe(12);
  expect(details.description).toBe('Public rule');
  expect(JSON.stringify(details)).not.toContain('private-description-sentinel');
  const editor = view.controls.find((c) => c.editor);
  const point = (await send({ type: 'vqa.resolve', target: editor.target })).result;
  expect(point.editable).toBe(true);
  expect(point.tag).toBe('TEXTAREA');
  const bounds = await target.locator('[role=code]').boundingBox();
  expect(point.x).toBeCloseTo(bounds.x + bounds.width / 2);
  expect(point.y).toBeCloseTo(bounds.y + bounds.height / 2);
  await target
    .locator('[role=code]')
    .evaluate((el) => (el.onclick = () => el.querySelector('textarea').focus()));
  await target.mouse.click(point.x, point.y);
  expect((await send({ type: 'vqa.editable-focus', target: editor.target })).result.focused).toBe(
    true,
  );
  const edge = (await send({ type: 'vqa.resolve', target: '#clipped' })).result;
  expect(edge.x).toBeGreaterThan(0);
  expect(edge.x).toBeLessThan(20);
  await target.locator('[data-id=filename]').evaluate((el) => {
    el.remove();
    document.body.appendChild(document.createElement('input'));
  });
  const stale = await send({ type: 'vqa.resolve', target: filename.target });
  expect(stale.error).toContain('Target not found');
  const invalidSyntax = await send({ type: 'vqa.resolve', target: 'text=contracts' });
  expect(invalidSyntax.code).toBe('needs_review');
  expect(invalidSyntax.error).toContain('Unsupported selector syntax');
});

test('submission preflight reads native constraints without validation events or private values', async () => {
  await target.goto('http://127.0.0.1:4173/fixtures/shop');
  await target.bringToFront();
  const tabId = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({})).find((t) => t.url === 'http://127.0.0.1:4173/fixtures/shop').id,
  );
  await invoke('bind', { tabId });
  await target.setContent(
    '<form><label>Handle<input id="handle" required pattern="rel-[a-z]{4,8}" value="atlas-launch"></label><input type="password" id="password" required pattern="[A-Z]+" value="private-value-sentinel"><button id="save">Save</button><button type="submit" formnovalidate id="unchecked">Save draft</button></form>',
  );
  await invoke('observe');
  await target.evaluate(() => {
    window.invalidEvents = 0;
    document.addEventListener('invalid', () => window.invalidEvents++, true);
  });
  const send = (message) =>
    worker.evaluate(({ tabId, message }) => chrome.tabs.sendMessage(tabId, message), {
      tabId,
      message,
    });
  const blocked = (await send({ type: 'vqa.resolve', target: '#save' })).result.nativeForm;
  expect(blocked.valid).toBe(false);
  expect(blocked.invalidCount).toBe(2);
  expect(blocked.fields.find((f) => f.name === 'Handle').pattern).toBe('rel-[a-z]{4,8}');
  expect(blocked.fields.find((f) => f.name === '[private field]').reasons).toContain(
    'patternMismatch',
  );
  expect(JSON.stringify(blocked)).not.toContain('private-value-sentinel');
  expect(await target.evaluate(() => window.invalidEvents)).toBe(0);
  await target.locator('#handle').focus();
  expect(
    (await send({ type: 'vqa.action-context', focused: true, key: 'Enter' })).result.nativeForm
      .valid,
  ).toBe(false);
  expect((await send({ type: 'vqa.resolve', target: '#unchecked' })).result.nativeForm).toBe(null);
  await target.locator('#handle').fill('rel-launch');
  await target.locator('#password').fill('VALID');
  expect((await send({ type: 'vqa.resolve', target: '#save' })).result.nativeForm.valid).toBe(true);
});

test('submission identities survive navigation without exposing credentials or volatile tokens', async () => {
  const url = 'http://127.0.0.1:4173/fixtures/shop';
  const render = async (token) => {
    await target.goto(url);
    await target.bringToFront();
    const tabId = await worker.evaluate(
      async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id,
      url,
    );
    await invoke('bind', { tabId });
    await target.setContent(
      '<form id="record"><label>Customer<input name="customer" value="synthetic-customer"></label><label>Password<input name="password" type="password" value="credential-sentinel"></label><input type="hidden" name="csrf" value="' +
        token +
        '"><button>Save release</button></form>',
    );
    await invoke('observe');
    return tabId;
  };
  const send = async (tabId, secret) =>
    worker.evaluate(
      ({ tabId, secret }) =>
        chrome.tabs.sendMessage(tabId, {
          type: 'vqa.resolve',
          target: 'role:button|Save release',
          submissionSecret: secret,
        }),
      { tabId, secret },
    );
  let tabId = await render('volatile-one');
  const first = await send(tabId, 'a'.repeat(64));
  expect(first.result.submissionKey).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(first)).not.toContain('credential-sentinel');
  tabId = await render('volatile-two');
  const after = await send(tabId, 'a'.repeat(64));
  expect(after.result.submissionKey).toBe(first.result.submissionKey);
  await target.locator('[name=customer]').fill('different-customer');
  const changed = await send(tabId, 'a'.repeat(64));
  expect(changed.result.submissionKey).not.toBe(first.result.submissionKey);
  const otherRun = await send(tabId, 'b'.repeat(64));
  expect(otherRun.result.submissionKey).not.toBe(changed.result.submissionKey);
});

async function labSuite(path, mode = 'qa', dataset, responsive = false) {
  const url = advancedOrigin + path;
  await target.goto(url);
  await target.bringToFront();
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id,
    url,
  );
  await invoke('bind', { tabId });
  const plan = await invoke('plan.propose', {
    request: 'Run the lab fixture',
    demo: true,
    responsive,
    mode,
    securityAuthorized: mode === 'security',
    dataset,
  });
  await invoke('plan.confirm', { id: plan.id, version: plan.version });
  const { runId } = await invoke('run.start', {
    planId: plan.id,
    version: plan.version,
    key: crypto.randomUUID(),
  });
  await expect
    .poll(async () => (await invoke('run.get', { id: runId })).status, { timeout: 90000 })
    .not.toBe('running');
  return invoke('run.get', { id: runId });
}

test('workflow data rows carry a real captured order ID into server checks', async () => {
  const run = await labSuite('/workflows', 'qa', [
    { quantity: '1', total: '12' },
    { quantity: '3', total: '36' },
  ]);
  expect(run.status, JSON.stringify(run, null, 2)).toBe('passed');
  const checks = run.steps.filter((s) => s.action.operation === 'http_check');
  expect(checks).toHaveLength(2);
  expect(checks[0].result.actual).toContain('/total=12');
  expect(checks[1].result.actual).toContain('/total=36');
  for (const check of checks) {
    const capture = run.steps.find(
      (s) => s.iteration === check.iteration && s.action.operation === 'capture_value',
    );
    expect(check.action.http.url.endsWith('/' + capture.result.value)).toBe(true);
  }
  expect(
    run.steps.some(
      (s) => s.action.operation === 'capture_value' && s.result.value.startsWith('alice-created-'),
    ),
  ).toBe(true);
  const fork = await invoke('plan.fork', {
    id: run.plan.id,
    dataset: [{ quantity: '2', total: '24' }],
  });
  expect(fork.id).not.toBe(run.plan.id);
  expect(fork.confirmed).toBe(false);
  expect(fork.dataset).toEqual([{ quantity: '2', total: '24' }]);
  await writeFile(resolve(work, 'data-workflow-run.json'), JSON.stringify(run, null, 2));
});

let healthySecurityRun;
test('logical security fixture verifies server authorization, price, CSRF and idempotency', async () => {
  healthySecurityRun = await labSuite('/security', 'security');
  expect(healthySecurityRun.status, JSON.stringify(healthySecurityRun, null, 2)).toBe('passed');
  const checks = healthySecurityRun.steps.filter((s) => s.action.operation === 'http_check');
  expect(checks).toHaveLength(12);
  const secrets = await target.evaluate(() => ({
    csrf: document.querySelector('meta[name="lab-csrf"]').content,
    bearer: JSON.parse(sessionStorage.getItem('voiceqa-access')).accessToken,
  }));
  for (const secret of Object.values(secrets))
    expect(JSON.stringify(healthySecurityRun)).not.toContain(secret);
  expect(checks.every((s) => s.status === 'passed')).toBe(true);
  expect(checks.filter((s) => s.result.status === 403)).toHaveLength(4);
  expect(checks.some((s) => s.result.status === 401)).toBe(true);
  expect(healthySecurityRun.securityFindings || []).toEqual([]);
  const capture = healthySecurityRun.steps.find((s) => s.result?.capture)?.result.capture;
  expect(capture.network.length).toBeGreaterThan(0);
  expect(JSON.stringify(capture.network)).not.toContain('X-CSRF-Token');
  await writeFile(resolve(work, 'security-run.json'), JSON.stringify(healthySecurityRun, null, 2));
});
for (const [bug, expected] of [
  ['idor', 'cross-user order'],
  ['price', 'tampered price'],
  ['role', 'admin access'],
  ['csrf', 'tokenless operation'],
  ['idempotency', 'repeated key'],
]) {
  test(`logical security detects the seeded ${bug} server defect`, async () => {
    const run = await labSuite('/security?bug=' + bug, 'security');
    expect(run.status, JSON.stringify(run, null, 2)).toBe('failed');
    expect(run.steps.some((s) => s.status === 'failed' && s.action.label.includes(expected))).toBe(
      true,
    );
    expect(run.diagnosis).toBeTruthy();
    const report = await invoke('report.export', { id: run.id, format: 'md' });
    const data = await invoke('artifact.get', { id: report.artifactId, offset: 0 });
    expect(Buffer.from(data.data, 'base64').toString()).toContain('Reproduction steps');
    if (healthySecurityRun) {
      const comparison = await invoke('run.compare', {
        before: healthySecurityRun.id,
        after: run.id,
      });
      expect(
        comparison.entries.some(
          (entry) => entry.change === 'regressed' && entry.label.includes(expected),
        ),
      ).toBe(true);
    }
  });
}

test('security options review and run the real fixture from the chat interface', async () => {
  await control.getByRole('button', { name: 'New chat', exact: true }).click();
  await target.goto(advancedOrigin + '/security');
  await target.bringToFront();
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id,
    advancedOrigin + '/security',
  );
  await invoke('bind', { tabId });
  await control.bringToFront();
  await control.getByLabel('Test options', { exact: true }).click();
  await control.getByLabel('Testing mode', { exact: true }).selectOption('security');
  await control.getByLabel('I am authorized to test these shared systems', { exact: true }).check();
  await control.getByLabel('Test options', { exact: true }).click();
  await target.bringToFront();
  await control
    .getByRole('button', { name: 'Run the demo test suite', exact: true })
    .evaluate((button) => button.click());
  await expect(control.getByRole('heading', { name: 'Test plan', exact: true })).toBeVisible();
  await expect(control.locator('.meta')).toContainText('Logical security');
  await expect(control.locator('.case-card')).toHaveCount(6);
  await control.screenshot({ path: resolve(work, 'security-plan.png'), fullPage: true });
  await control
    .getByRole('button', { name: 'Confirm and run tests', exact: true })
    .evaluate((button) => button.click());
  await expect.poll(async () => (await invoke('state')).runId, { timeout: 20000 }).toBe(null);
  await expect(control.locator('.result-banner .status')).toHaveText('passed');
  await expect(
    control.getByRole('button', { name: 'Export bug report', exact: true }),
  ).toBeVisible();
  await control.screenshot({ path: resolve(work, 'security-results.png'), fullPage: true });
});

test('visual-only masks preserve dynamic captures and isolate baselines by data row', async () => {
  await invoke('settings.save', { visualMaskSelectors: '[data-testid=order-id]' });
  try {
    const url = advancedOrigin + '/workflows';
    await target.goto(url);
    await target.bringToFront();
    const tabId = await worker.evaluate(
      async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id,
      url,
    );
    await invoke('bind', { tabId });
    const plan = await invoke('plan.propose', {
      request: 'Run workflow with visual baselines',
      demo: true,
      visual: true,
    });
    await invoke('plan.confirm', { id: plan.id, version: plan.version });
    async function runAgain() {
      const { runId } = await invoke('run.start', {
        planId: plan.id,
        version: plan.version,
        key: crypto.randomUUID(),
      });
      await expect
        .poll(async () => (await invoke('run.get', { id: runId })).status, { timeout: 20000 })
        .not.toBe('running');
      return invoke('run.get', { id: runId });
    }
    let run = await runAgain();
    expect(run.status).toBe('needs_review');
    for (const step of run.steps.filter((step) => step.result?.capture))
      await invoke('baseline.approve', { runId: run.id, stepId: step.id });
    run = await runAgain();
    expect(run.status, JSON.stringify(run, null, 2)).toBe('passed');
    expect(
      run.steps
        .filter((step) => step.action.operation === 'capture_value')
        .every((step) => step.result.value.startsWith('alice-created-')),
    ).toBe(true);
  } finally {
    await invoke('settings.save', { visualMaskSelectors: '' });
  }
});

test('an embedded document cannot replace top-level security policy evidence', async () => {
  const run = await labSuite('/security?iframe=1', 'security');
  expect(run.status, JSON.stringify(run, null, 2)).toBe('passed');
  expect(run.securityFindings || []).toEqual([]);
  const audit = run.steps.find((s) => s.action.operation === 'security_audit');
  expect(audit.result.incompleteEvidence).toBe(false);
});

test('RelayDesk replaces the shop at the default URL and fits desktop and mobile', async () => {
  await target.goto(advancedOrigin + '/');
  await expect(
    target.getByRole('heading', { name: 'Good morning, Alice', exact: true }),
  ).toBeVisible();
  await expect(target.locator('meta[name=voiceqa-fixture]')).toHaveAttribute(
    'content',
    'voiceqa-workspace-v1',
  );
  await target.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1440, 390]) {
    await target.setViewportSize({ width, height: 900 });
    expect(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await target.screenshot({ path: resolve(work, `relaydesk-${width}.png`), fullPage: true });
  }
  await target.setViewportSize({ width: 1440, height: 900 });
  await target.emulateMedia({ reducedMotion: 'no-preference' });
});

test('RelayDesk full application suite verifies wizard, captures, server totals, tabs and persistence', async () => {
  const run = await labSuite('/');
  expect(run.status, JSON.stringify(run, null, 2)).toBe('passed');
  const capture = run.steps.find((s) => s.action.operation === 'capture_value');
  expect(capture.result.value).toMatch(/^ORD-[a-f0-9]{8}$/);
  expect(run.steps.some((s) => s.page === 'invoice' && s.status === 'passed')).toBe(true);
  expect((await invoke('state')).pages.invoice).toBeUndefined();
  await writeFile(resolve(work, 'relaydesk-run.json'), JSON.stringify(run, null, 2));
});

test('RelayDesk responsive suite verifies populated desktop and mobile views', async () => {
  const run = await labSuite('/app/layout', 'qa', undefined, true);
  expect(run.status, JSON.stringify(run, null, 2)).toBe('passed');
  expect(
    new Set(run.steps.filter((s) => s.action.operation === 'assert').map((s) => s.viewport)).size,
  ).toBe(2);
});

test('RelayDesk authentication requires real TOTP and an operator-completed challenge', async () => {
  const url = advancedOrigin + '/app/auth';
  await invoke('auth.save', {
    id: 'relay',
    origin: advancedOrigin,
    label: 'RelayDesk synthetic account',
    username: 'qa@voiceqa.test',
    password: 'fixture-only',
    totpSecret: testSeed,
    algorithm: 'sha1',
    digits: 6,
    period: 30,
  });
  await target.goto(url);
  await target.bringToFront();
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id,
    url,
  );
  await invoke('bind', { tabId });
  const plan = await invoke('plan.propose', {
    demo: true,
    request: 'Run the RelayDesk authentication fixture',
  });
  await invoke('plan.confirm', { id: plan.id, version: plan.version });
  const { runId } = await invoke('run.start', {
    planId: plan.id,
    version: plan.version,
    key: crypto.randomUUID(),
  });
  await expect
    .poll(async () => (await invoke('run.get', { id: runId })).handoff?.kind, { timeout: 20000 })
    .toBe('captcha');
  await expect(target.getByTestId('auth-result')).toHaveText('Authenticated as Alice Morgan');
  await target.getByTestId('challenge').check();
  await expect(target.getByTestId('challenge-result')).toHaveText('Challenge completed');
  const run = await invoke('run.get', { id: runId });
  await invoke('handoff.complete', { id: run.handoff.id });
  await expect
    .poll(async () => (await invoke('run.get', { id: runId })).status, { timeout: 15000 })
    .toBe('passed');
  const complete = await invoke('run.get', { id: runId });
  expect(JSON.stringify(complete)).not.toContain(testSeed);
  expect(JSON.stringify(complete)).not.toContain('fixture-only');
  await writeFile(resolve(work, 'relaydesk-auth-run.json'), JSON.stringify(complete, null, 2));
});

test('RelayDesk logical security verifies actual server controls', async () => {
  const run = await labSuite('/app/security', 'security');
  expect(run.status, JSON.stringify(run, null, 2)).toBe('passed');
  expect(run.securityFindings || []).toEqual([]);
  expect(run.steps.filter((s) => s.action.operation === 'http_check')).toHaveLength(10);
  await writeFile(resolve(work, 'relaydesk-security-run.json'), JSON.stringify(run, null, 2));
});
for (const [bug, label] of [
  ['ownership', 'cross-account denial'],
  ['role', 'server admin denial'],
  ['csrf', 'tokenless write denial'],
  ['price', 'server price integrity'],
  ['duplicate', 'duplicate submission'],
]) {
  test(`RelayDesk detects the seeded ${bug} server defect`, async () => {
    const run = await labSuite('/app/security?bug=' + bug, 'security');
    expect(run.status, JSON.stringify(run, null, 2)).toBe('failed');
    expect(run.steps.some((s) => s.status === 'failed' && s.action.label.includes(label))).toBe(
      true,
    );
  });
}

test('RelayDesk fences genuinely stale searches and renders a real empty state', async () => {
  let firstStarted, releaseFirst, firstFinished;
  const started = new Promise((resolve) => (firstStarted = resolve));
  const release = new Promise((resolve) => (releaseFirst = resolve));
  const finished = new Promise((resolve) => (firstFinished = resolve));
  let hold = true;
  const pattern = '**/workspace/api/orders?*';
  const handler = async (route) => {
    if (hold && new URL(route.request().url()).searchParams.get('q') === 'Northstar') {
      hold = false;
      firstStarted();
      try {
        const response = await route.fetch();
        await release;
        await route.fulfill({ response });
      } finally {
        firstFinished();
      }
    } else await route.continue();
  };
  await target.route(pattern, handler);
  try {
    await target.goto(advancedOrigin + '/app/orders?reset=1');
    await expect(target.getByTestId('orders-summary')).toHaveText('5 matching orders');
    await target.getByTestId('order-search').fill('Northstar');
    await started;
    await target.getByTestId('order-search').fill('No such customer');
    await expect(target.getByTestId('empty-orders')).toHaveText('No orders found');
    releaseFirst();
    await finished;
    await target.waitForTimeout(200);
    await expect(target.getByTestId('empty-orders')).toHaveText('No orders found');
  } finally {
    releaseFirst();
    await target.unroute(pattern, handler);
  }
  await target.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(target.getByTestId('orders-summary')).toHaveText('5 matching orders');
  await target.getByTestId('order-filter').selectOption('Draft');
  await expect(target.getByTestId('orders-summary')).toHaveText('2 matching orders');
  const pending = target.waitForRequest(
    (r) =>
      new URL(r.url()).pathname === '/workspace/api/orders' &&
      new URL(r.url()).searchParams.get('q') === 'Northstar',
  );
  await target.getByTestId('order-search').fill('Northstar');
  await pending;
  await target.getByTestId('nav-projects').click();
  await target.waitForTimeout(500);
  await expect(target.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await expect(target.getByTestId('orders-summary')).toHaveCount(0);
});

test('RelayDesk data rows isolate complete workflows and invoice identities', async () => {
  const run = await labSuite('/', 'qa', [
    { quantity: '1', total: '135' },
    { quantity: '3', total: '375' },
  ]);
  expect(run.status, JSON.stringify(run, null, 2)).toBe('passed');
  const captures = run.steps.filter((s) => s.action.operation === 'capture_value');
  expect(captures).toHaveLength(2);
  expect(captures[0].result.value).not.toBe(captures[1].result.value);
  const checks = run.steps.filter((s) => s.action.operation === 'http_check');
  expect(checks.map((s) => s.result.actual)).toEqual(
    expect.arrayContaining([
      expect.stringContaining('/total=135'),
      expect.stringContaining('/total=375'),
    ]),
  );
});

test('RelayDesk can be proposed and run from the VoiceQA chat', async () => {
  await control.getByRole('button', { name: 'New chat', exact: true }).click();
  await target.goto(advancedOrigin + '/');
  await target.bringToFront();
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id,
    advancedOrigin + '/',
  );
  await invoke('bind', { tabId });
  await control.bringToFront();
  await control.getByLabel('Test options', { exact: true }).click();
  await control.getByLabel('Testing mode', { exact: true }).selectOption('qa');
  await control.getByLabel('Test options', { exact: true }).click();
  await target.bringToFront();
  await control
    .getByRole('button', { name: 'Run the demo test suite', exact: true })
    .evaluate((b) => b.click());
  await expect(control.getByRole('heading', { name: 'Test plan', exact: true })).toBeVisible();
  await expect(control.locator('.case-card')).toHaveCount(3);
  await control
    .getByRole('button', { name: 'Confirm and run tests', exact: true })
    .evaluate((b) => b.click());
  await expect(control.locator('.result-banner .status')).toHaveText('passed', { timeout: 90000 });
  await expect.poll(async () => (await invoke('state')).runId, { timeout: 30000 }).toBe(null);
  await control.screenshot({ path: resolve(work, 'relaydesk-chat-results.png'), fullPage: true });
});

test('RelayDesk authentication navigation works before initial bootstrap completes', async () => {
  let releaseFirst, started, firstFinished;
  const release = new Promise((r) => (releaseFirst = r)),
    first = new Promise((r) => (started = r)),
    finished = new Promise((r) => (firstFinished = r));
  let hold = true;
  const pattern = '**/workspace/api/bootstrap';
  const handler = async (route) => {
    if (hold) {
      hold = false;
      started();
      try {
        const response = await route.fetch();
        await release;
        if (!route.request().failure()) await route.fulfill({ response });
      } finally {
        firstFinished();
      }
    } else await route.continue();
  };
  await target.route(pattern, handler);
  try {
    await target.goto(advancedOrigin + '/?reset=1', { waitUntil: 'domcontentloaded' });
    await first;
    await target.getByTestId('nav-auth').click();
    await expect(
      target.getByRole('heading', { name: 'Sign in to Northstar', exact: true }),
    ).toBeVisible();
    await expect(target.getByTestId('identity')).toHaveText('Guest account');
  } finally {
    releaseFirst();
    await finished;
    await target.unroute(pattern, handler);
  }
});

test('RelayDesk distinguishes submitted orders from unavailable confirmation', async () => {
  const pattern = '**/workspace/api/orders/ORD-*';
  const handler = (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":"Temporary confirmation failure"}',
    });
  await target.route(pattern, handler);
  try {
    await target.goto(advancedOrigin + '/?reset=1');
    await target.getByTestId('new-order').click();
    await target.getByTestId('customer-name').fill('Northstar Studio');
    await target.getByTestId('customer-email').fill('qa@relay.test');
    await target.getByTestId('wizard-next').click();
    await target.getByTestId('wizard-next').click();
    await target.getByTestId('wizard-next').click();
    await expect(target.getByTestId('order-result')).toHaveText('Order submitted');
    await expect(target.getByTestId('order-status')).toHaveText(
      'Confirmation unavailable. Review orders before retrying.',
    );
  } finally {
    await target.unroute(pattern, handler);
  }
});

test('current-width plans keep the actual viewport on repeated runs without setting metrics', async () => {
  test.setTimeout(30000);
  await target.setViewportSize({ width: 1111, height: 777 });
  await target.goto('http://127.0.0.1:4173/fixtures/shop');
  await target.bringToFront();
  const tabId = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({})).find((t) => t.url === 'http://127.0.0.1:4173/fixtures/shop').id,
  );
  await invoke('bind', { tabId });
  await worker.evaluate(() => {
    globalThis.__originalMetricsCommand = chrome.debugger.sendCommand;
    globalThis.__metricsWrites = 0;
    chrome.debugger.sendCommand = (...args) => {
      if (args[1] === 'Emulation.setDeviceMetricsOverride') globalThis.__metricsWrites++;
      return globalThis.__originalMetricsCommand.apply(chrome.debugger, args);
    };
  });
  try {
    const plan = await invoke('plan.propose', {
      request: 'Run fixture at the current width',
      demo: true,
      responsive: false,
    });
    expect(plan.preserveViewport).toBe(true);
    expect(plan.viewports).toEqual([{ width: 1111, height: 777 }]);
    await invoke('plan.confirm', { id: plan.id, version: plan.version });
    for (let pass = 0; pass < 2; pass++) {
      const { runId } = await invoke('run.start', {
        planId: plan.id,
        version: plan.version,
        key: crypto.randomUUID(),
      });
      await expect
        .poll(async () => (await invoke('run.get', { id: runId })).status, { timeout: 12000 })
        .not.toBe('running');
      const run = await invoke('run.get', { id: runId });
      expect(run.status).toBe('passed');
      expect(run.steps.every((s) => s.viewport === '1111x777')).toBe(true);
      expect(await target.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({
        width: 1111,
        height: 777,
      });
    }
    expect(await worker.evaluate(() => globalThis.__metricsWrites)).toBe(0);
  } finally {
    await worker.evaluate(() => {
      chrome.debugger.sendCommand = globalThis.__originalMetricsCommand;
    });
    await target.setViewportSize({ width: 1440, height: 900 });
  }
});
