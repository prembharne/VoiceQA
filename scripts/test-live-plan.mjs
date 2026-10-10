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
const results = resolve('test-results');
await mkdir(results, { recursive: true });
const folder = await mkdtemp(join(results, 'live-plan-'));
const dataDir = join(folder, 'data');
await mkdir(dataDir);
let browser, host;
const secretFiles = ['openrouter-api-key.dpapi', 'api-key.dpapi'];
const tasks = new Map();
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
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:4173/');
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
  await page.addScriptTag({ path: resolve('extension/content.js') });
  const observation = await page.evaluate(
    () =>
      new Promise((done) => {
        globalThis.__observer({ type: 'vqa.observe' }, { id: 'smoke' }, (reply) =>
          done(reply.result),
        );
      }),
  );
  if (!observation) throw new Error('Demo observation failed.');

  host = spawn(resolve('dist/voiceqa-host.exe'), ['--stdio'], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, VOICEQA_DATA_DIR: dataDir, OPENAI_API_KEY: '', VOICEQA_TTS_API_KEY: '' },
  });
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
      const timer = setTimeout(() => {
        tasks.delete(id);
        fail(new Error('Native request timed out.'));
      }, 130000);
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
  await rpc('project.configure', { origin: 'http://127.0.0.1:4173', url: page.url() });
  console.log(`Drafting the coupon/cart request with OpenRouter ${model}...`);
  const plan = await rpc('plan.propose', {
    request: process.argv[2]
      ? await readFile(resolve(process.argv[2]), 'utf8')
      : 'Check that invalid coupon is rejected and cart total is updated correctly. The value for a mug is $12.',
    url: page.url(),
    origin: 'http://127.0.0.1:4173',
    responsive: true,
    visual: false,
  });
  const checks = plan.cases.flatMap((c) => c.steps.filter((s) => s.operation === 'assert'));
  if (!plan.clarification && !checks.length) throw new Error('Accepted plan has no checks.');
  if (plan.confirmed) throw new Error('Draft was incorrectly confirmed.');
  await writeFile(join(folder, 'accepted-plan.json'), JSON.stringify(plan, null, 2));
  console.log(
    JSON.stringify({
      accepted: true,
      model: plan.model,
      cases: plan.cases.length,
      checks: checks.length,
      clarification: plan.clarification,
      confirmed: plan.confirmed,
      usage: plan.usage,
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
      await browser?.close();
    } finally {
      for (const file of secretFiles)
        await unlink(join(dataDir, file)).catch((e) => {
          if (e.code !== 'ENOENT') throw e;
        });
    }
  }
}
