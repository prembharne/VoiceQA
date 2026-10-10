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
  await expect(control.getByRole('heading', { name: 'Test with confidence.' })).toBeVisible();
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

  await target.goto('http://127.0.0.1:4173/');
  await target.bringToFront();
  // A side panel click leaves the website active. Evaluate the actual DOM click
  // because this test renders the panel in a tab, which Playwright would activate.
  await control.getByRole('button', { name: 'Test this tab' }).evaluate((button) => button.click());
  await expect.poll(async () => (await invoke('state')).target?.url).toBe('http://127.0.0.1:4173/');
  await expect(control.locator('.target-card')).toContainText('CONNECTED WEBSITE');
  await expect(control.getByRole('alert')).toHaveCount(0);

  await control.bringToFront();
  await control.getByRole('button', { name: 'Test this tab' }).click();
  await expect(control.getByRole('alert')).toContainText('Switch to a normal website');
  await target.bringToFront();
  await control.getByRole('button', { name: 'Test this tab' }).evaluate((button) => button.click());
  await expect(control.getByRole('alert')).toHaveCount(0);
});

test('paced execution shows each action and Stop interrupts the gap', async () => {
  await control.bringToFront();
  await control.getByLabel('Gap between steps').selectOption('3000');
  await expect.poll(async () => (await invoke('settings.get')).stepDelayMs).toBe(3000);
  await target.goto('http://127.0.0.1:4173/');
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
  const run = await suite('http://127.0.0.1:4173/');
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
  const run = await suite('http://127.0.0.1:4173/?bug=total');
  expect(run.status).toBe('failed');
  expect(
    run.steps.some(
      (s) =>
        s.action.assertion?.kind === 'number' && s.status === 'failed' && s.result.actual === 29,
    ),
  ).toBe(true);
});
test('missing coupon feedback is failed with explicit expected/actual evidence', async () => {
  const run = await suite('http://127.0.0.1:4173/?bug=coupon');
  expect(run.status).toBe('failed');
  expect(
    run.steps.some((s) => s.status === 'failed' && s.result?.expected === 'Coupon is not valid'),
  ).toBe(true);
});
test('visual baselines require explicit approval and rerun', async () => {
  let run = await suite('http://127.0.0.1:4173/', true);
  expect(run.status).toBe('needs_review');
  for (const step of run.steps.filter((s) => s.result?.capture))
    await invoke('baseline.approve', { runId: run.id, stepId: step.id });
  run = await suite('http://127.0.0.1:4173/', true);
  expect(run.status, JSON.stringify(run, null, 2)).toBe('passed');
  expect(run.steps.some((s) => s.result?.visual?.status === 'passed')).toBe(true);
});
test('accessibility and mobile overflow defects are detected', async () => {
  const access = await suite('http://127.0.0.1:4173/?bug=accessibility');
  expect(access.status).toBe('failed');
  expect(
    access.steps.some((s) => s.action.operation === 'accessibility' && s.result.seriousCount > 0),
  ).toBe(true);
  const overflow = await suite('http://127.0.0.1:4173/?bug=overflow');
  expect(overflow.status).toBe('failed');
  expect(
    overflow.steps.some((s) => s.action.assertion?.kind === 'no_overflow' && s.status === 'failed'),
  ).toBe(true);
});
test('cancellation stops new actions and detaches the debugger', async () => {
  const url = 'http://127.0.0.1:4173/?bug=order';
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
  await target.goto('http://127.0.0.1:4173/');
  await target.bringToFront();
  const tabId = await worker.evaluate(
    async () => (await chrome.tabs.query({})).find((t) => t.url === 'http://127.0.0.1:4173/')?.id,
  );
  await invoke('bind', { tabId });
  await expect(
    invoke('plan.propose', { request: 'Check the cart total', demo: false, responsive: false }),
  ).rejects.toThrow('Configure an API key');
});
test('paused asynchronous actions cannot revive after cancellation', async () => {
  const url = 'http://127.0.0.1:4173/';
  await target.goto(url);
  await target.bringToFront();
  const tabId = await worker.evaluate(
    async () => (await chrome.tabs.query({})).find((t) => t.url === 'http://127.0.0.1:4173/')?.id,
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
test('side panel renders offline-safe UI without remote code or JavaScript errors', async () => {
  const errors = [];
  control.on('pageerror', (e) => errors.push(e.message));
  await control.bringToFront();
  await control.getByRole('button', { name: 'Test', exact: true }).click();
  await control.setViewportSize({ width: 420, height: 1000 });
  await expect(control.getByRole('heading', { name: 'Test with confidence.' })).toBeVisible();
  await control.screenshot({ path: resolve(work, 'side-panel.png'), fullPage: true });
  expect(errors).toEqual([]);
});
test('the panel recovers from its disconnected port without reopening the page', async () => {
  await control.bringToFront();
  await control.getByRole('button', { name: 'Open setup' }).click();
  await expect(control.getByRole('heading', { name: 'Local setup' })).toBeVisible();
  await control.evaluate(() => globalThis.__voiceqaTestPorts[0].disconnect());
  await control.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(
    control.getByRole('heading', { name: 'Bring your test engine online.' }),
  ).toBeVisible();
  await expect(control.getByLabel('Extension ID', { exact: true })).toHaveValue(extensionId);
  await control.screenshot({ path: resolve(work, 'connection-recovery.png'), fullPage: true });
  await control.getByRole('button', { name: 'Retry connection', exact: true }).click();
  await expect(control.getByText('Engine connected', { exact: true })).toBeVisible();
  await control.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(control.getByRole('heading', { name: 'Test with confidence.' })).toBeVisible();
});
test('polished views fit narrow and wide panels and respect reduced motion', async () => {
  await control.bringToFront();
  await control.getByRole('button', { name: 'Test', exact: true }).click();
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
test('TTS settings expose a dedicated key slot and fail explicitly without credentials', async () => {
  await control.bringToFront();
  await control.getByRole('button', { name: 'Open setup' }).click();
  await control.getByLabel('Speech provider').selectOption('openai');
  await expect(control.getByLabel('Text-to-speech API key', { exact: true })).toBeVisible();
  await expect(control.getByLabel('Text-to-speech model', { exact: true })).toHaveValue('tts-1');
  await control.getByLabel('Use the main OpenAI key when no TTS key is set').uncheck();
  await control.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(control.getByRole('alert')).toContainText('text-to-speech API key');
  const settings = await invoke('settings.get');
  expect(settings.ttsProvider).toBe('openai');
  expect(settings.ttsReuseMainKey).toBe(false);
  expect(settings.ttsApiKey).toBeUndefined();
  await control.screenshot({ path: resolve(work, 'tts-settings.png'), fullPage: true });
  await control.getByLabel('Speech provider').selectOption('browser');
  await control.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect.poll(async () => (await invoke('settings.get')).ttsProvider).toBe('browser');
});

test('OpenRouter setup saves the provider and keeps speech credentials separate', async () => {
  await control.getByLabel('AI provider').selectOption('openrouter');
  await expect(control.getByLabel('OpenRouter API key', { exact: true })).toBeVisible();
  await expect(control.getByLabel('Reasoning model', { exact: true })).toHaveValue('openai/gpt-4o');
  await expect(
    control.getByLabel('OpenAI speech API key (optional)', { exact: true }),
  ).toBeVisible();
  await control.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect.poll(async () => (await invoke('settings.get')).aiProvider).toBe('openrouter');
  const settings = await invoke('settings.get');
  expect(settings.apiKey).toBeUndefined();
  expect(settings.speechApiKey).toBeUndefined();
  expect(settings.hasSpeechApiKey).toBe(false);
  await control.screenshot({ path: resolve(work, 'openrouter-settings.png'), fullPage: true });
  await control.getByLabel('AI provider').selectOption('openai');
  await control.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect.poll(async () => (await invoke('settings.get')).aiProvider).toBe('openai');
});
