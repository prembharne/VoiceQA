// Replay a generated cart or security draft against its lab in an isolated extension
// profile, with a real four-second gap. No model calls or production data writes.
import { chromium } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

const plan = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
const security = plan.mode === 'security';
const origin = security ? 'http://127.0.0.1:4175' : 'http://127.0.0.1:4173';
const url = security ? `${origin}/security` : `${origin}/`;
if (plan.origin !== origin || plan.url !== url || plan.clarification || !plan.cases?.length)
  throw new Error('This check requires a runnable local-demo plan.');
const targets = new Set([
  'testid:add-mug',
  'testid:cart-total',
  'testid:coupon',
  'testid:apply-coupon',
  'testid:coupon-error',
  ...(security
    ? [
        'testid:login-alice',
        'testid:login-bob',
        'testid:identity',
        'testid:client-admin',
        'testid:client-role',
        'testid:genuine-transfer',
        'testid:transfer-result',
        'testid:order-id',
        'testid:order-total',
        'testid:order-quantity',
        'testid:create-order',
      ]
    : []),
]);
for (const c of plan.cases)
  for (const a of c.steps) {
    if (
      ![
        'navigate',
        'click',
        'fill',
        'assert',
        ...(security ? ['http_check', 'security_audit', 'capture_value', 'wait_for'] : []),
      ].includes(a.operation) ||
      (a.operation === 'navigate'
        ? a.value !== url
        : a.operation === 'http_check'
          ? !a.http?.url.startsWith(`${origin}/security/api/`)
          : a.operation === 'security_audit'
            ? false
            : !targets.has(a.target))
    )
      throw new Error(
        'This smoke check permits only known actions and API routes in the selected synthetic lab.',
      );
  }
await mkdir(resolve('test-results'), { recursive: true });
const work = await mkdtemp(resolve('test-results/paced-live-run-'));
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
    stepDelayMs: 4000,
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
try {
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
        const timer = setTimeout(() => {
          tasks.delete(id);
          fail(new Error('RPC timed out'));
        }, 130000);
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
  await rpc('plan.confirm', { id: plan.id, version: plan.version });
  const { runId } = await rpc('run.start', {
    planId: plan.id,
    version: plan.version,
    key: crypto.randomUUID(),
  });
  let run,
    count = -1,
    captured = false;
  const deadline = Date.now() + 300000;
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
  if (run.status !== 'passed' || gaps.some((ms) => ms < 3900))
    throw new Error('Paced workflow did not pass with the required gap.');
} finally {
  await context?.close();
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
}
