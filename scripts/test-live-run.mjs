// Execute an AI-generated plan in an isolated extension profile. --plan-live
// drafts through the real extension and provider first. Four-second gaps are
// default; --fast is for diagnosis. Production settings/runs are never written.
import { allowedDemoAPI } from './live-demo-scope.mjs';
import { chromium } from '@playwright/test';
import { cp, copyFile, unlink, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

let plan = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
const livePlanning = process.argv.includes('--plan-live');
if (livePlanning && (plan.aiProvider !== 'openrouter' || !plan.model.endsWith(':free')))
  throw new Error('Live extension planning is restricted to the selected free OpenRouter model.');
const security = plan.mode === 'security';
const workspace = plan.origin === 'http://127.0.0.1:4176';
const origin = workspace
  ? 'http://127.0.0.1:4176'
  : security
    ? 'http://127.0.0.1:4175'
    : 'http://127.0.0.1:4173';
const url = plan.url;
if (plan.origin !== origin || plan.clarification || !plan.cases?.length)
  throw new Error('This check requires a runnable local-demo plan.');
// Replay only the owned local sandbox. These checks constrain destinations and
// operations, while allowing the actual model to choose its UI selectors/steps.
const demoURL = (raw) => {
  try {
    const u = new URL(raw);
    return (
      u.origin === origin &&
      !u.username &&
      !u.password &&
      (workspace
        ? /^\/(?:app\/(?:orders|settings|auth|security|compatibility|projects|layout)|app\/invoices\/[^/]+)?$/.test(
            u.pathname,
          )
        : security
          ? u.pathname === '/security'
          : u.pathname === '/fixtures/shop')
    );
  } catch {
    return false;
  }
};
const operations = new Set([
  'navigate',
  'click',
  'fill',
  'select',
  'assert',
  'wait_for',
  'capture_value',
  'http_check',
  'open_tab',
  'switch_tab',
  'close_tab',
  'key',
  'scroll',
  'fill_secret',
  'fill_totp',
  'human_checkpoint',
  'security_audit',
]);
if (!demoURL(url)) throw new Error('Plan starts outside the owned sandbox.');
for (const c of plan.cases)
  for (const a of c.steps) {
    if (
      !operations.has(a.operation) ||
      (['navigate', 'open_tab'].includes(a.operation) && !demoURL(a.value)) ||
      (a.operation === 'http_check' &&
        !allowedDemoAPI(a.http?.url, origin, workspace ? 'workspace' : 'security')) ||
      (a.operation === 'security_audit' && !security)
    )
      throw new Error('Live replay is limited to known routes in the owned local sandbox.');
  }
await mkdir(resolve('.tools/live-checks'), { recursive: true });
const work = await mkdtemp(resolve('.tools/live-checks/paced-live-run-'));
const data = join(work, 'data');
await mkdir(data);
const db = new DatabaseSync(join(data, 'voiceqa.db'));
db.exec(
  'CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(kind,id))',
);
const put = db.prepare('INSERT INTO records(kind,id,body) VALUES(?,?,?)');
put.run(
  'settings',
  'default',
  JSON.stringify({
    aiProvider: plan.aiProvider,
    model: plan.model,
    stepDelayMs: process.argv.includes('--fast') ? 0 : 4000,
    ttsProvider: 'browser',
  }),
);
put.run('plan', plan.id, JSON.stringify({ ...plan, confirmed: false }));
db.close();
const extension = join(work, 'extension');
await cp(resolve('dist/extension'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
const registration = join(work, 'native-host.json');
const backup = join(work, 'registry-backup.json');
let context,
  registered = false;
const copiedKeys = ['openrouter-api-key.dpapi', 'api-key.dpapi'];
try {
  if (livePlanning) {
    for (const name of copiedKeys) {
      try {
        await copyFile(join(process.env.LOCALAPPDATA, 'VoiceQA', name), join(data, name));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  context = await chromium.launchPersistentContext(join(work, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    env: {
      ...process.env,
      VOICEQA_DATA_DIR: data,
      OPENAI_API_KEY: '',
      OPENROUTER_API_KEY: '',
      VOICEQA_TTS_API_KEY: '',
    },
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  await writeFile(
    registration,
    JSON.stringify({
      name: 'com.voiceqa.companion',
      description: 'Paced-run smoke test',
      path: resolve(
        process.argv.find((a) => a.startsWith('--host='))?.slice(7) || 'dist/voiceqa-host.exe',
      ),
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
    registration,
    '-BackupPath',
    backup,
  ]);
  registered = true;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  await panel.setViewportSize({ width: 420, height: 1000 });
  await panel.getByText('Engine connected', { exact: true }).waitFor({ timeout: 15000 });
  await panel.evaluate(() => {
    const port = chrome.runtime.connect({ name: 'voiceqa-panel' });
    const tasks = new Map();
    port.onMessage.addListener((m) => {
      if (m.type !== 'response') return;
      const task = tasks.get(m.id);
      if (!task) return;
      tasks.delete(m.id);
      clearTimeout(task.timer);
      m.error ? task.fail(new Error(m.error)) : task.done(m.result);
    });
    globalThis.__rpc = (method, payload = {}) =>
      new Promise((done, fail) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(
          () => {
            tasks.delete(id);
            fail(new Error('RPC timed out'));
          },
          method === 'plan.propose' ? 480000 : 130000,
        );
        tasks.set(id, { done, fail, timer });
        port.postMessage({ type: 'request', id, method, payload });
      });
  });
  const rpc = (method, payload = {}) =>
    panel.evaluate(({ method, payload }) => globalThis.__rpc(method, payload), { method, payload });
  const target = await context.newPage();
  await target.goto(url);
  await target.bringToFront();
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id,
    url,
  );
  await rpc('bind', { tabId });
  if (workspace && process.argv.includes('--fixture-auth')) {
    await rpc('auth.save', {
      id: 'relay',
      origin,
      label: 'Isolated synthetic account',
      username: 'qa@voiceqa.test',
      password: 'fixture-only',
      totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      algorithm: 'sha1',
      digits: 6,
      period: 30,
    });
  }
  if (livePlanning) {
    console.log(`Planning through the real extension with ${plan.model}...`);
    const started = Date.now();
    plan = await rpc('plan.propose', {
      request: plan.request,
      responsive: !plan.preserveViewport && plan.viewports.length > 1,
      mode: plan.mode || 'qa',
      securityAuthorized: Boolean(plan.securityAuthorized),
      apiWritesAllowed: Boolean(plan.apiWritesAllowed),
      visual: false,
    });
    await writeFile(join(work, 'live-extension-plan.json'), JSON.stringify(plan, null, 2));
    console.log(
      JSON.stringify({
        liveExtensionPlan: true,
        model: plan.model,
        cases: plan.cases.length,
        elapsedMs: Date.now() - started,
      }),
    );
    if (plan.clarification) throw new Error(plan.clarification);
  }
  await rpc('plan.confirm', { id: plan.id, version: plan.version });
  const { runId } = await rpc('run.start', {
    planId: plan.id,
    version: plan.version,
    key: crypto.randomUUID(),
  });
  let run,
    count = -1,
    captured = false;
  const deadline = Date.now() + 1200000;
  while (Date.now() < deadline) {
    run = await rpc('run.get', { id: runId });
    if (run.steps.length !== count) {
      count = run.steps.length;
      const last = run.steps.at(-1);
      console.log(`Step ${count}/${run.totalSteps}: ${last?.action.label || 'Starting'}`);
    }
    if (run.nextStep && !captured && run.steps.at(-1)?.action.operation === 'click') {
      await panel.screenshot({ path: join(work, 'paced-run.png'), fullPage: true });
      captured = true;
    }
    if (run.handoff) {
      if (!workspace || run.handoff.kind !== 'captcha')
        throw new Error('Unexpected operator checkpoint.');
      // The tester supplies the operator action only on the synthetic fixture.
      // The agent's following assertion must verify the application's result.
      await target.getByTestId('challenge').check();
      await rpc('handoff.complete', { id: run.handoff.id });
    }
    if (!['running', 'paused', 'queued'].includes(run.status)) break;
    await new Promise((done) => setTimeout(done, 250));
  }
  await writeFile(join(work, 'run.json'), JSON.stringify(run, null, 2));
  await panel.screenshot({ path: join(work, 'results.png'), fullPage: true });
  const assertions = run.steps.filter((s) => ['assert', 'http_check'].includes(s.action.operation));
  const gaps = run.steps
    .slice(1)
    .map((s, i) => Date.parse(s.startedAt) - Date.parse(run.steps[i].completedAt));
  console.log(
    JSON.stringify({
      status: run.status,
      recordedSteps: run.steps.length,
      checks: assertions.length,
      checksPassed: assertions.filter((s) => s.status === 'passed').length,
      minimumGapMs: Math.min(...gaps),
      evidence: join(work, 'run.json'),
    }),
  );
  const expectedFailure = process.argv.includes('--expect-failed');
  if (
    (expectedFailure
      ? run.status !== 'failed' ||
        !assertions.some((s) => s.status === 'failed') ||
        !assertions.some((s) => s.status === 'passed')
      : run.status !== 'passed') ||
    (!process.argv.includes('--fast') && gaps.some((ms) => ms < 3900))
  )
    throw new Error('Paced workflow did not pass with the required gap.');
} finally {
  try {
    await context?.close();
  } finally {
    try {
      if (registered)
        execFileSync('powershell.exe', [
          '-NoProfile',
          '-File',
          resolve('scripts/test-host-registration.ps1'),
          '-Mode',
          'restore',
          '-BackupPath',
          backup,
        ]);
    } finally {
      if (livePlanning)
        for (const name of copiedKeys)
          await unlink(join(data, name)).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          });
    }
  }
}
