// Opt-in live OpenRouter check. Reads saved credentials, drafts one plan (with
// at most one repair), and never confirms a plan or executes test actions.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { copyFile, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { once } from 'node:events';

if (process.platform !== 'win32')
  throw new Error('Saved-key smoke check currently requires Windows.');
const source = join(process.env.LOCALAPPDATA, 'VoiceQA');
const security = process.argv.includes('--security');
const workspace = process.argv.includes('--workspace');
const modelOverride = process.argv
  .find((arg) => arg.startsWith('--model='))
  ?.slice('--model='.length);
const hostPath = resolve(
  process.argv.find((arg) => arg.startsWith('--host='))?.slice('--host='.length) ||
    'dist/voiceqa-host.exe',
);
const origin = workspace
  ? 'http://127.0.0.1:4176'
  : security
    ? 'http://127.0.0.1:4175'
    : 'http://127.0.0.1:4173';
let targetURL = workspace
  ? `${origin}/`
  : security
    ? `${origin}/security`
    : `${origin}/fixtures/shop`;
const bug = process.argv.find((arg) => arg.startsWith('--bug='))?.slice(6);
if (bug) {
  if (
    !workspace ||
    !['ownership', 'role', 'price', 'csrf', 'duplicate', 'settings', 'search', 'async'].includes(
      bug,
    )
  )
    throw new Error('Choose a known isolated RelayDesk fault.');
  targetURL += `?reset=1&bug=${bug}`;
}
const requestFile = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const results = resolve('.tools/live-checks');
await mkdir(results, { recursive: true });
const folder = await mkdtemp(join(results, 'live-plan-'));
const dataDir = join(folder, 'data');
await mkdir(dataDir);
let browser, host;
const secretFiles = ['openrouter-api-key.dpapi', 'api-key.dpapi'];
const tasks = new Map();
const progress = [];
let planningStartedAt;
let diagnosticText = '';
let diagnosticWrites = Promise.resolve();
try {
  for (const file of secretFiles) {
    try {
      await copyFile(join(source, file), join(dataDir, file));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  let model = 'openai/gpt-4o';
  const db = new DatabaseSync(join(source, 'voiceqa.db'), { readOnly: true });
  try {
    const row = db.prepare("SELECT body FROM records WHERE kind='settings' AND id='default'").get();
    const saved = row ? JSON.parse(row.body) : {};
    if (saved.aiProvider === 'openrouter' && saved.model?.includes('/')) model = saved.model;
  } finally {
    db.close();
  }
  if (modelOverride) model = modelOverride;
  if ((security || workspace) && !model.endsWith(':free') && !process.argv.includes('--allow-paid'))
    throw new Error(
      'The live security check requires your selected OpenRouter :free model. It will not switch models or spend paid credits.',
    );
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(targetURL);
  // Run the bundled observer against the real DOM; stub only Chrome message delivery.
  await page.evaluate(() => {
    globalThis.chrome = {
      runtime: {
        id: 'smoke',
        onMessage: {
          addListener: (fn) => {
            globalThis.__observer = fn;
          },
        },
      },
    };
  });
  // Test instrumentation uses the trusted bundled observer; do not weaken the app's CSP.
  await page.evaluate(await readFile(resolve('extension/content.js'), 'utf8'));
  const observation = await page.evaluate(
    () =>
      new Promise((done) => {
        globalThis.__observer({ type: 'vqa.observe' }, { id: 'smoke' }, (reply) =>
          done(reply.result),
        );
      }),
  );
  if (!observation) throw new Error('Demo observation failed.');

  host = spawn(hostPath, ['--stdio'], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      VOICEQA_DATA_DIR: dataDir,
      OPENAI_API_KEY: '',
      VOICEQA_TTS_API_KEY: '',
      VOICEQA_PLAN_DIAGNOSTICS: '1',
    },
  });
  host.stderr.on('data', (chunk) => {
    diagnosticText += chunk.toString();
    const snapshot = diagnosticText;
    diagnosticWrites = diagnosticWrites.then(() =>
      writeFile(join(folder, 'draft-diagnostics.ndjson'), snapshot),
    );
  });
  console.log(`Diagnostic folder: ${folder}`);
  const send = (type, payload, extra = {}) => {
    const raw = Buffer.from(
      JSON.stringify({ version: 1, id: crypto.randomUUID(), type, payload, ...extra }),
    );
    const header = Buffer.alloc(4);
    header.writeUInt32LE(raw.length);
    host.stdin.write(Buffer.concat([header, raw]));
  };
  const rpc = (type, payload = {}) =>
    new Promise((done, fail) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(
        () => {
          tasks.delete(id);
          fail(new Error('Native request timed out.'));
        },
        type === 'plan.propose' ? 480000 : 130000,
      );
      tasks.set(id, { done, fail, timer });
      send(type, payload, { id });
    });
  let buffer = Buffer.alloc(0);
  host.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const length = buffer.readUInt32LE(0);
      const message = JSON.parse(buffer.subarray(4, 4 + length));
      buffer = buffer.subarray(4 + length);
      if (message.type === 'plan.progress') {
        progress.push({
          phase: message.payload.phase,
          receivedChars: message.payload.receivedChars,
          at: Date.now(),
        });
        if (progress.length === 1 || progress.at(-2).phase !== message.payload.phase)
          console.log(`Planning: ${message.payload.phase}`);
      }
      if (message.type === 'browser.request') {
        if (message.payload.operation !== 'observe') {
          send('browser.result', {
            requestId: message.id,
            error: 'Smoke test forbids page mutations.',
          });
        } else send('browser.result', { requestId: message.id, result: observation });
      }
      if (message.type === 'rpc.result') {
        const task = tasks.get(message.payload.requestId);
        if (!task) continue;
        tasks.delete(message.payload.requestId);
        clearTimeout(task.timer);
        message.payload.error
          ? task.fail(new Error(message.payload.error))
          : task.done(message.payload.result);
      }
    }
  });
  host.on('error', (e) => {
    for (const task of tasks.values()) {
      clearTimeout(task.timer);
      task.fail(e);
    }
    tasks.clear();
  });
  await rpc('hello');
  const settings = await rpc('settings.save', {
    aiProvider: 'openrouter',
    model,
    ttsProvider: 'browser',
  });
  if (!settings.hasApiKey) throw new Error('No saved OpenRouter key is available.');
  await rpc('project.configure', { origin, url: page.url() });
  // Explicit opt-in, isolated synthetic account only. Never edit user profiles.
  if (workspace && process.argv.includes('--fixture-auth')) {
    secretFiles.push('auth-relay.dpapi');
    await rpc('auth.save', {
      id: 'relay',
      origin,
      label: 'Isolated RelayDesk fixture',
      username: 'qa@voiceqa.test',
      password: 'fixture-only',
      totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      algorithm: 'sha1',
      digits: 6,
      period: 30,
    });
  }
  console.log(
    `Drafting the ${workspace ? 'RelayDesk order workflow' : security ? 'logical security' : 'coupon/cart'} request with OpenRouter ${model}...`,
  );
  const startedAt = Date.now();
  planningStartedAt = startedAt;
  const plan = await rpc('plan.propose', {
    request: requestFile
      ? await readFile(resolve(requestFile), 'utf8')
      : workspace
        ? 'Create only one case for the RelayDesk order workflow. Reset the sandbox first. Open New order, attempt Next with missing fields and verify the validation message. Fill Northstar Studio, qa@relay.test, express delivery, and quantity 2 of Studio display. Verify INVALID coupon is rejected, clear it, then review the exact total 255. Submit the synthetic order, wait for Order confirmed, capture its actual order ID, independently verify the server total at the provided order API, open the known invoice route in an owned tab, verify its ID and total, return to main and close only the created invoice tab. Do not add the other suite cases or duplicate viewports. Use the trusted fixture contract.'
        : security
          ? 'On this synthetic lab, verify anonymous and cross-user order access are denied with positive authorized controls. Verify a client price of 0.01 cannot change the server mug price of 12. Verify a client admin claim cannot grant server admin access. Verify missing CSRF is denied and the legitimate protected API works using its named CSRF source. Verify a repeated idempotency key returns the same order ID. Verify the bearer session uses the provided named browser source and enforces ownership. Reset before each case. Use the exact fixture contract and never capture credentials or tokens.'
          : 'Check that invalid coupon is rejected and cart total is updated correctly. The value for a mug is $12.',
    url: page.url(),
    origin,
    responsive: !security && !workspace,
    mode: security ? 'security' : 'qa',
    securityAuthorized: security,
    apiWritesAllowed: security && workspace && process.argv.includes('--writes'),
    visual: false,
  });
  const checks = plan.cases.flatMap((c) =>
    c.steps.filter((s) => ['assert', 'http_check'].includes(s.operation)),
  );
  if (!plan.clarification && !checks.length) throw new Error('Accepted plan has no checks.');
  if (plan.confirmed) throw new Error('Draft was incorrectly confirmed.');
  await writeFile(join(folder, 'accepted-plan.json'), JSON.stringify(plan, null, 2));
  await writeFile(
    join(folder, 'planning-progress.json'),
    JSON.stringify({ startedAt, elapsedMs: Date.now() - startedAt, progress }, null, 2),
  );
  console.log(
    JSON.stringify({
      accepted: true,
      model: plan.model,
      cases: plan.cases.length,
      checks: checks.length,
      clarification: plan.clarification,
      confirmed: plan.confirmed,
      usage: plan.usage,
      elapsedMs: Date.now() - startedAt,
      progressEvents: progress.length,
      evidence: join(folder, 'accepted-plan.json'),
    }),
  );
} finally {
  for (const task of tasks.values()) clearTimeout(task.timer);
  try {
    if (host && host.exitCode === null) {
      const closed = once(host, 'close');
      host.stdin.end();
      const timer = setTimeout(() => host.kill(), 2000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    try {
      await diagnosticWrites;
      await writeFile(
        join(folder, 'planning-progress.json'),
        JSON.stringify(
          {
            startedAt: planningStartedAt,
            elapsedMs: planningStartedAt ? Date.now() - planningStartedAt : 0,
            progress,
          },
          null,
          2,
        ),
      );
    } finally {
      try {
        await browser?.close();
      } finally {
        for (const file of secretFiles)
          await unlink(join(dataDir, file)).catch((e) => {
            if (e.code !== 'ENOENT') throw e;
          });
      }
    }
  }
}
