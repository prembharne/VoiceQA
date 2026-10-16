// Execute an AI-generated plan in an isolated extension profile. --plan-live
// drafts through the real extension and provider first. Four-second gaps are
// default; --fast is for diagnosis. Production settings/runs are never written.
import { allowedDemoAPI } from './live-demo-scope.mjs';
import { chromium } from '@playwright/test';
import {
  cp,
  copyFile,
  unlink,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  realpath,
} from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

let plan = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
const debugPath = process.argv
  .find((arg) => arg.startsWith('--debug-run='))
  ?.slice('--debug-run='.length);
const debugRecord = debugPath ? JSON.parse(await readFile(resolve(debugPath), 'utf8')) : null;
const automationUI = process.argv.includes('--automation-ui');
if (process.argv.includes('--expect-status-defect') && !process.argv.includes('--live-reads'))
  throw new Error('Status-defect acceptance requires the owned live-read workspace check.');
if (
  process.argv.includes('--expect-continued-failure') &&
  !process.argv.includes('--expect-status-defect')
)
  throw new Error('Failure-continuation acceptance requires the owned status defect.');
const automationLive = process.argv.includes('--automation-live') || automationUI;
const remixVM = process.argv.includes('--remix-local-vm');
if (remixVM && (!automationLive || plan.origin !== 'https://app.remix.live'))
  throw new Error(
    'Remix acceptance requires live automation on the explicitly approved public Remix origin.',
  );
const livePlanning = process.argv.includes('--plan-live') || automationLive;
const lowTokens = process.argv.includes('--paid-qwen-low-tokens');
const paidQwen = lowTokens || process.argv.includes('--paid-qwen');
const exactModel = process.argv.includes('--nemotron-only')
  ? 'nvidia/nemotron-3.5-super-vl:free'
  : '';
if (exactModel && (paidQwen || plan.aiProvider !== 'openrouter' || plan.model !== exactModel))
  throw new Error('Nemotron-only acceptance forbids other models and paid fallback.');
if (paidQwen && (plan.aiProvider !== 'openrouter' || plan.model !== 'qwen/qwen3.7-flash'))
  throw new Error('Paid acceptance permits only the explicitly authorized Qwen 3.7 Flash.');
if (
  (debugRecord ||
    process.argv.includes('--visual-qa') ||
    livePlanning ||
    process.argv.includes('--followup') ||
    process.argv.includes('--investigate') ||
    process.argv.includes('--ask-ui')) &&
  (plan.aiProvider !== 'openrouter' || (!plan.model.endsWith(':free') && !paidQwen))
)
  throw new Error('Live extension planning is restricted to the selected free OpenRouter model.');
const security = plan.mode === 'security';
const workspace = plan.origin === 'http://127.0.0.1:4176';
const multiWorkspace = plan.origin === 'http://127.0.0.1:4179';
const parcelWorkspace = plan.origin === 'http://127.0.0.1:4180';
const visualWorkspace = plan.origin === 'http://127.0.0.1:4181';
const timingWorkspace = visualWorkspace && new URL(plan.url).pathname === '/timing';
const expectedStale = multiWorkspace && process.argv.includes('--expect-stale-original');
const generic = [
  'http://127.0.0.1:4177',
  'http://127.0.0.1:4178',
  'http://127.0.0.1:4179',
  'http://127.0.0.1:4180',
  'http://127.0.0.1:4181',
].includes(plan.origin);
const origin = remixVM
  ? 'https://app.remix.live'
  : generic
    ? plan.origin
    : workspace
      ? 'http://127.0.0.1:4176'
      : security
        ? 'http://127.0.0.1:4175'
        : 'http://127.0.0.1:4173';
const url = plan.url;
if (plan.origin !== origin || plan.clarification || (!automationLive && !plan.cases?.length))
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
      (remixVM
        ? u.pathname === '/'
        : parcelWorkspace
          ? /^\/(?:guide)?$/.test(u.pathname)
          : multiWorkspace
            ? /^\/(?:review)?$/.test(u.pathname)
            : visualWorkspace
              ? /^\/(?:timing)?$/.test(u.pathname)
              : generic
                ? /^\/(?:help)?$/.test(u.pathname)
                : workspace
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
if (
  debugRecord &&
  (debugRecord.plan.origin !== origin ||
    ['running', 'paused', 'queued'].includes(debugRecord.status))
)
  throw new Error('Debug acceptance requires a completed actual run from this owned origin.');
for (const c of plan.cases || [])
  for (const a of c.steps) {
    if (
      !operations.has(a.operation) ||
      (['navigate', 'open_tab'].includes(a.operation) && !demoURL(a.value)) ||
      (a.operation === 'http_check' &&
        !allowedDemoAPI(
          a.http?.url,
          origin,
          parcelWorkspace ? 'parcel' : workspace ? 'workspace' : 'security',
        )) ||
      (a.operation === 'security_audit' && !security)
    )
      throw new Error('Live replay is limited to known routes in the owned local sandbox.');
  }
await mkdir(resolve('.tools/live-checks'), { recursive: true });
const work = await mkdtemp(resolve('.tools/live-checks/paced-live-run-'));
let profile = join(work, 'profile');
const resumeFrom = process.argv
  .find((arg) => arg.startsWith('--resume-remix-from='))
  ?.slice('--resume-remix-from='.length);
if (resumeFrom) {
  const prior = await realpath(resolve(resumeFrom));
  const root = await realpath(resolve('.tools/live-checks'));
  if (
    !remixVM ||
    !exactModel ||
    dirname(prior).toLowerCase() !== root.toLowerCase() ||
    !/^paced-live-run-[A-Za-z0-9]+$/.test(basename(prior))
  )
    throw new Error('Resume is limited to an owned isolated Remix acceptance profile.');
  const previous = await readFile(join(prior, 'run.json'), 'utf8')
    .then(JSON.parse)
    .catch(async (error) => {
      if (error.code !== 'ENOENT' || !process.argv.includes('--resume-interrupted')) throw error;
      return JSON.parse(await readFile(join(prior, 'partial-runs.json'), 'utf8')).at(-1);
    });
  if (
    previous.plan?.origin !== origin ||
    previous.plan?.model !== exactModel ||
    (['running', 'paused', 'queued'].includes(previous.status) &&
      !process.argv.includes('--resume-interrupted'))
  )
    throw new Error('Resume requires a completed NVIDIA-only Remix attempt.');
  profile = await realpath(join(prior, 'profile'));
  if (dirname(profile).toLowerCase() !== prior.toLowerCase())
    throw new Error('Unexpected profile path');
  await writeFile(
    join(work, 'resumed-from.json'),
    JSON.stringify({
      prior,
      previousRunId: previous.id,
      interruptedByTester: process.argv.includes('--resume-interrupted'),
    }),
  );
}
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
if (debugRecord) put.run('run', debugRecord.id, JSON.stringify(debugRecord));
db.close();
const extension = join(work, 'extension');
await cp(resolve('dist/extension'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = remixVM ? ['https://app.remix.live/*'] : ['http://127.0.0.1/*'];
await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
const registration = join(work, 'native-host.json');
const backup = join(work, 'registry-backup.json');
let context,
  registered = false;
// Close the owned profile on interruption so catch/finally can restore native
// registration and remove this attempt's temporary encrypted key copies.
process.once('SIGINT', () => {
  void context?.close().catch(() => {});
});
const copiedKeys = ['openrouter-api-key.dpapi', 'api-key.dpapi'];
try {
  if (
    debugRecord ||
    process.argv.includes('--visual-qa') ||
    livePlanning ||
    process.argv.includes('--followup') ||
    process.argv.includes('--investigate') ||
    process.argv.includes('--ask-ui')
  ) {
    for (const name of copiedKeys) {
      try {
        await copyFile(join(process.env.LOCALAPPDATA, 'VoiceQA', name), join(data, name));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    ...(visualWorkspace || remixVM ? { viewport: null } : {}),
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      ...(visualWorkspace || remixVM ? ['--window-size=1440,1000'] : []),
    ],
    env: {
      ...process.env,
      VOICEQA_DATA_DIR: data,
      VOICEQA_ACCEPTANCE_QWEN: paidQwen ? '1' : '',
      VOICEQA_ACCEPTANCE_MODEL: exactModel,
      VOICEQA_AGENT_S_DIAGNOSTICS: process.argv.includes('--visual-agent')
        ? join(work, 'visual-error.json')
        : '',
      VOICEQA_ACCEPTANCE_QWEN_LOW_TOKENS: lowTokens ? '1' : '',
      OPENAI_API_KEY: '',
      OPENROUTER_API_KEY: '',
      VOICEQA_TTS_API_KEY: '',
    },
  });
  if (remixVM) {
    // Only in this isolated acceptance: no browser POST or WebSocket can
    // reach a remote RPC/wallet service. The Go AI provider uses its own client.
    await context.route('**/*', (route) =>
      ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort(),
    );
    await context.routeWebSocket('**/*', (socket) => socket.close());
  }
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
  const panelErrors = [];
  panel.on('pageerror', (error) => panelErrors.push(error.message));
  await panel.addInitScript(() => {
    globalThis.__recordedAnalyses = [];
    const connect = chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect = (...args) => {
      const port = connect(...args);
      port.onMessage.addListener((message) => {
        if (message.type === 'response' && message.result?.runId)
          globalThis.__recordedAnalyses.push(message.result);
      });
      return port;
    };
    globalThis.__voiceQAAnnouncements = 0;
    if (globalThis.speechSynthesis)
      globalThis.speechSynthesis.speak = () => {
        globalThis.__voiceQAAnnouncements++;
      };
  });
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  await panel.setViewportSize({ width: 420, height: 1000 });
  await panel.getByText('Engine connected', { exact: true }).waitFor({ timeout: 15000 });
  await panel.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [360, 420]) {
    await panel.setViewportSize({ width, height: 900 });
    await panel.screenshot({ path: join(work, `chat-${width}.png`), fullPage: true });
    const clipped = await panel.evaluate(() => {
      const bounds = document.querySelector('.chat-composer').getBoundingClientRect();
      return [
        ...document.querySelectorAll(
          '.composer-toolbar > select,.composer-options > summary,.composer-actions > button,.model-button',
        ),
      ]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width && r.height && (r.left < bounds.left || r.right > bounds.right);
        })
        .map((e) => e.getAttribute('aria-label') || e.textContent);
    });
    if (clipped.length)
      throw new Error(`Composer controls clipped at ${width}px: ${clipped.join(', ')}`);
    for (const selector of ['.model-picker', '.composer-options']) {
      const popupFits = await panel.evaluate((selector) => {
        const details = document.querySelector(selector);
        details.open = true;
        const popup = details.querySelector('.model-popover,.options-popover');
        const r = popup.getBoundingClientRect();
        details.open = false;
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
      }, selector);
      if (!popupFits) throw new Error(`Composer popup clipped at ${width}px: ${selector}`);
    }
    if (await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error(`Chat overflow at ${width}px`);
  }
  await panel.setViewportSize({ width: 420, height: 1000 });
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
          method === 'plan.propose' && payload.discover === true
            ? 840000
            : ['plan.propose', 'agent.query', 'automation.propose'].includes(method)
              ? 480000
              : 130000,
        );
        tasks.set(id, { done, fail, timer });
        port.postMessage({ type: 'request', id, method, payload });
      });
  });
  const rpc = (method, payload = {}) =>
    panel.evaluate(({ method, payload }) => globalThis.__rpc(method, payload), { method, payload });
  const target = await context.newPage();
  await target.goto(url);
  if (remixVM)
    await target.waitForFunction(
      () => {
        const ready =
          document.readyState === 'complete' &&
          globalThis.monaco?.editor?.getEditors &&
          document.querySelector('#verticalIconsKindfilePanel');
        if (!ready) return false;
        const probe = globalThis.__voiceqaAcceptanceReady;
        if (!probe || probe.url !== location.href) {
          globalThis.__voiceqaAcceptanceReady = { url: location.href, at: performance.now() };
          return false;
        }
        return performance.now() - probe.at >= 2000;
      },
      null,
      { timeout: 90000 },
    );
  await target.bringToFront();
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id,
    target.url(),
  );
  await rpc('bind', { tabId });
  let sharedGuide;
  if (parcelWorkspace && process.argv.includes('--share-guide')) {
    const guide = await context.newPage();
    await guide.goto(origin + '/guide');
    const guideTab = await worker.evaluate(
      async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id,
      origin + '/guide',
    );
    await rpc('pages.share', { tabId: guideTab, alias: 'guide' });
    sharedGuide = { url: guide.url(), text: await guide.locator('body').innerText() };
    await writeFile(join(work, 'shared-guide.json'), JSON.stringify(sharedGuide, null, 2));
    await target.bringToFront();
  }
  if (debugRecord) {
    const before = await target.locator('body').innerText();
    await panel.getByRole('button', { name: 'History', exact: true }).click();
    await panel.locator('.history-item').first().click();
    await panel.getByRole('button', { name: 'Investigate with AI', exact: true }).click();
    await panel.waitForFunction(
      () =>
        globalThis.__recordedAnalyses.length > 0 ||
        document.querySelector('article[data-kind=error]'),
      null,
      {
        timeout: 480000,
      },
    );
    const answer = await panel.evaluate(() => globalThis.__recordedAnalyses.at(-1));
    if (!answer) {
      await panel.screenshot({ path: join(work, 'debug-error.png'), fullPage: true });
      const failure = await panel.locator('article[data-kind=error]').first().innerText();
      throw new Error(`Actual debugging failed: ${failure}`);
    }
    await writeFile(join(work, 'debug-answer.json'), JSON.stringify(answer, null, 2));
    if (!answer.assessment)
      throw new Error(
        `Actual debugging asked for clarification instead of analyzing the available record: ${answer.clarification || 'no assessment'}`,
      );
    if (answer.model !== plan.model || !answer.usage?.total_tokens)
      throw new Error('Debugging did not return usage from the selected actual model.');
    await panel.screenshot({ path: join(work, 'debug-answer.png'), fullPage: true });
    const category = process.argv
      .find((arg) => arg.startsWith('--expect-category='))
      ?.slice('--expect-category='.length);
    if (
      answer.runId !== debugRecord.id ||
      !answer.sources.some((id) =>
        answer.evidence.some((e) => e.id === id && e.tool === 'read_run' && !e.error),
      ) ||
      (category && answer.assessment.category !== category)
    )
      throw new Error('Actual debugging did not classify and cite the selected recorded evidence.');
    if (
      category === 'application_behavior' &&
      (!JSON.stringify(answer.assessment).includes('410') ||
        !JSON.stringify(answer.assessment).includes('435'))
    )
      throw new Error(
        'Actual debugging missed the recorded expected/observed pricing discrepancy.',
      );
    if (
      (await target.locator('body').innerText()) !== before ||
      (await rpc('run.get', { id: debugRecord.id })).status !== debugRecord.status
    )
      throw new Error('Investigation mutated the page or rewrote the historical run verdict.');
    if (panelErrors.length || (await panel.evaluate(() => globalThis.__voiceQAAnnouncements !== 0)))
      throw new Error('Debugging chat produced runtime errors or unwanted voice.');
    console.log(
      JSON.stringify({
        recordedRun: answer.runId,
        category: answer.assessment.category,
        confidence: answer.assessment.confidence,
        toolCalls: answer.evidence.filter(
          (e) => e.id !== 'E0' && e.tool !== 'assessment_validation',
        ).length,
        evidence: join(work, 'debug-answer.json'),
        currentPageUnchanged: true,
        historicalVerdictUnchanged: true,
      }),
    );
  } else {
    if (generic && (process.argv.includes('--investigate') || process.argv.includes('--ask-ui'))) {
      const answer = await rpc('agent.query', {
        request:
          'Read the linked Workshop help page and report its cancellation window. Inspect the Attendee field and report its validation pattern and maximum length. Cite the evidence you used. Do not create a test plan, fill fields or submit a booking.',
        readLinks: true,
      });
      await writeFile(join(work, 'investigation.json'), JSON.stringify(answer, null, 2));
      if (
        answer.clarification ||
        !answer.answer ||
        !answer.evidence.some((e) => e.tool === 'read_link' && !e.error) ||
        !answer.evidence.some((e) => e.tool === 'inspect_element' && !e.error)
      )
        throw new Error(
          'Actual investigation did not read linked evidence and inspect the control.',
        );
      console.log(
        `Actual agent used ${answer.evidence.length - 1} browser tool calls and returned an evidence-backed answer.`,
      );
    }
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
    if (parcelWorkspace) {
      for (const [id, username, password, label] of [
        ['owner', 'alice@parcel.test', 'synthetic-owner-password', 'North member test account'],
        [
          'manager',
          'manager@parcel.test',
          'synthetic-manager-password',
          'North manager test account',
        ],
      ])
        await rpc('auth.save', { id, origin, username, password, label });
    }
    let runId;
    if (automationUI) {
      await panel
        .getByRole('button', { name: 'Browser automation', exact: true })
        .evaluate((button) => button.click());
      await panel.waitForFunction(
        () =>
          document.querySelector('.intent-picker option:checked')?.textContent.trim() ===
          'Automate & execute',
      );
      for (const width of [360, 420]) {
        await panel.setViewportSize({ width, height: 1000 });
        const fits = await panel.evaluate(
          () =>
            document.documentElement.scrollWidth <= innerWidth &&
            [...document.querySelectorAll('.workspace-switch button,.intent-picker')].every(
              (el) => {
                const r = el.getBoundingClientRect();
                return r.left >= 0 && r.right <= innerWidth;
              },
            ),
        );
        if (!fits) throw new Error(`Automation controls overflow at ${width}px`);
      }
      await panel.evaluate((request) => {
        const textarea = document.querySelector('#request');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
          textarea,
          request,
        );
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }, plan.request);
      await panel.waitForFunction(
        () => !document.querySelector('[aria-label="Send automation request"]').disabled,
      );
      await panel
        .getByRole('button', { name: 'Send automation request', exact: true })
        .evaluate((button) => button.click());
      await panel
        .getByRole('button', { name: 'Start live automation' })
        .waitFor({ timeout: 480000 });
      if (process.argv.includes('--review-permissions')) {
        await panel.locator('.composer-options > summary').click();
        await panel.getByLabel('Allow consequential actions').check();
        await panel.locator('.composer-options > summary').click();
        await panel.getByRole('button', { name: 'Start live automation' }).click();
        await panel
          .getByText('Automation permissions changed.', { exact: false })
          .first()
          .waitFor();
        if ((await rpc('state')).runId)
          throw new Error('Changed permissions started the previously reviewed mission.');
        await panel.locator('.composer-options > summary').click();
        await panel.getByLabel('Allow consequential actions').uncheck();
        await panel.locator('.composer-options > summary').click();
        console.log('Actual UI blocked approval after permissions changed; no run started.');
      }
      await panel.screenshot({ path: join(work, 'mission-review.png'), fullPage: true });
      await panel.getByRole('button', { name: 'Start live automation' }).click();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const state = await rpc('state');
        if (state.runId) {
          runId = state.runId;
          break;
        }
        await new Promise((done) => setTimeout(done, 100));
      }
      if (!runId) throw new Error('Automation mission did not start through UI approval');
      // Approval is clicked in the panel page. Explicitly return focus to the
      // owned target before the real agent resolves controls; keep production
      // pause checks enabled rather than mistaking an inactive test tab for AI delay.
      await target.bringToFront();
      const approvedState = await rpc('state');
      if (approvedState.paused && !approvedState.handoff) await rpc('resume');
      plan = (await rpc('run.get', { id: runId })).plan;
      if (
        !plan.automation?.live ||
        plan.cases.length ||
        plan.automation.criteria.length ||
        Object.values(plan.usage || {}).some((value) => value !== 0)
      )
        throw new Error(
          'Automation prepared an AI plan/checklist instead of starting the live tool loop.',
        );
      await writeFile(join(work, 'live-extension-plan.json'), JSON.stringify(plan, null, 2));
    } else if (livePlanning) {
      console.log(`Planning through the real extension with ${plan.model}...`);
      const started = Date.now();
      plan = await rpc(automationLive ? 'automation.propose' : 'plan.propose', {
        request: plan.request,
        conversation: plan.conversation || [],
        maxActions: remixVM ? 100 : 40,
        allowConsequential: remixVM || (visualWorkspace && process.argv.includes('--visual-agent')),
        discover: process.argv.includes('--discover'),
        readLinks: true,
        responsive: !automationLive && !plan.preserveViewport && plan.viewports.length > 1,
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
    if (!runId) {
      if (parcelWorkspace) {
        const investigationStore = new DatabaseSync(join(data, 'voiceqa.db'), { readOnly: true });
        let discoveries;
        try {
          discoveries = investigationStore
            .prepare('SELECT body FROM records WHERE kind=?')
            .all('investigation')
            .map((row) => JSON.parse(row.body));
        } finally {
          investigationStore.close();
        }
        await writeFile(join(work, 'investigations.json'), JSON.stringify(discoveries, null, 2));
        if (
          !sharedGuide &&
          !discoveries.some((d) =>
            d.evidence.some(
              (e) => e.tool === 'read_link' && !e.error && e.result?.url === origin + '/guide',
            ),
          )
        )
          throw new Error(
            'Actual agent did not read the public API guide before security planning.',
          );
        if (
          JSON.stringify([plan, discoveries]).includes('synthetic-owner-password') ||
          JSON.stringify([plan, discoveries]).includes('synthetic-manager-password')
        )
          throw new Error(
            'Synthetic credential values leaked into model-visible planning evidence.',
          );
        for (const step of plan.cases.flatMap((c) => c.steps)) {
          if (
            (['navigate', 'open_tab'].includes(step.operation) && !demoURL(step.value)) ||
            (step.operation === 'http_check' && !allowedDemoAPI(step.http?.url, origin, 'parcel'))
          )
            throw new Error('Actual AI plan left the owned ParcelGate route allowlist.');
        }
      }
      await rpc('plan.confirm', { id: plan.id, version: plan.version });
      const started = await rpc('run.start', {
        planId: plan.id,
        version: plan.version,
        key: crypto.randomUUID(),
      });
      runId = started.runId;
    }
    let run,
      count = -1,
      captured = false;
    const deadline = Date.now() + 1200000;
    while (Date.now() < deadline) {
      const runtime = await rpc('state');
      if (runtime.paused && !runtime.handoff) {
        // Follow the executor's current approved tab, including actor-created
        // aliases; never switch a multi-tab run back to the original tab here.
        const activeURL = await worker.evaluate(async (tabId) => {
          const tab = await chrome.tabs.get(tabId);
          await chrome.windows.update(tab.windowId, { focused: true });
          await chrome.tabs.update(tab.id, { active: true });
          return tab.url;
        }, runtime.target.tabId);
        if (!demoURL(activeURL))
          throw new Error('Paused acceptance target left the owned route scope.');
        await rpc('resume');
        console.log('Resumed the owned acceptance target after panel focus changed.');
      }
      run = await rpc('run.get', { id: runId });
      if (run.steps.length !== count) {
        count = run.steps.length;
        const last = run.steps.at(-1);
        console.log(`Step ${count}/${run.totalSteps}: ${last?.action.label || 'Starting'}`);
      }
      await writeFile(
        join(work, 'runtime-status.json'),
        JSON.stringify(
          {
            status: run.status,
            phase: run.agentPhase,
            model: run.agentModel,
            runtime: run.agentRuntime,
            steps: run.steps.length,
            paused: runtime.paused,
            connected: runtime.connected,
            page: runtime.currentPage,
            events: run.agentEvents?.slice(-6),
          },
          null,
          2,
        ),
      );
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
    if (parcelWorkspace) {
      const reviewDB = new DatabaseSync(join(data, 'voiceqa.db'), { readOnly: true });
      try {
        await writeFile(
          join(work, 'plan-reviews.json'),
          JSON.stringify(
            reviewDB
              .prepare('SELECT body FROM records WHERE kind=?')
              .all('plan_review')
              .map((row) => JSON.parse(row.body)),
            null,
            2,
          ),
        );
      } finally {
        reviewDB.close();
      }
    }
    await panel.screenshot({ path: join(work, 'results.png'), fullPage: true });
    const assertions = run.steps.filter((s) =>
      ['assert', 'http_check'].includes(s.action.operation),
    );
    if (
      process.argv.includes('--eino') &&
      (run.agentRuntime !== 'eino-adk/0.9.21' ||
        !run.agentEvents?.some((e) => e.kind === 'tool_dispatch'))
    )
      throw new Error('Acceptance did not execute the real Eino agent harness.');
    if (parcelWorkspace) {
      const state = await target.evaluate(() => fetch('/api/testing-state').then((r) => r.json()));
      await writeFile(join(work, 'security-state.json'), JSON.stringify(state, null, 2));
      const http = assertions.filter((s) => s.action.operation === 'http_check');
      const checked = (method, path, status) =>
        http.some(
          (s) =>
            s.action.http.method === method &&
            new URL(s.action.http.url).pathname === path &&
            s.action.http.expectedStatus === status,
        );
      if (
        !checked('GET', '/api/orders/OA1001', 200) ||
        !checked('GET', '/api/orders/OB2002', 403) ||
        !checked('POST', '/api/orders/OA1001/approve', 403) ||
        !checked('POST', '/api/orders/OA1001/approve', 200) ||
        !http.some(
          (s) =>
            s.action.http.method === 'POST' &&
            /^\/api\/orders(?:\/OA1001\/approve)?$/.test(new URL(s.action.http.url).pathname) &&
            !s.action.http.csrfSource &&
            s.action.http.expectedStatus === 403,
        )
      )
        throw new Error(
          'Actual AI did not exercise ownership, server roles and missing-CSRF controls.',
        );
      const creates = http.filter(
        (s) =>
          s.action.http.method === 'POST' &&
          new URL(s.action.http.url).pathname === '/api/orders' &&
          s.action.http.expectedStatus === 201,
      );
      if (
        !creates.some((s) => {
          const body = JSON.parse(s.action.http.body);
          if (!(
            (body.unitPrice !== undefined && body.unitPrice !== 35) ||
            (body.total !== undefined && body.total !== body.quantity * 35)
          ))
            return false;
          const createdId = s.action.http.jsonPointer === '/id' ? s.result?.value : undefined;
          return http.some(
            (price) =>
              price.action.http.jsonPointer === '/total' &&
              price.action.http.expectedType === 'number' &&
              Number(price.action.http.expectedValue) === body.quantity * 35 &&
              (price === s ||
                (createdId &&
                  price.action.http.method === 'GET' &&
                  new URL(price.action.http.url).pathname === '/api/orders/' + createdId)),
          );
        })
      )
        throw new Error('Actual AI omitted independently derived authoritative-price checks.');
      const keys = creates.map((s) => s.action.http.idempotencyKey);
      if (
        new Set(keys).size === keys.length ||
        state.creations !== new Set(keys).size ||
        !state.events.some(
          (e) =>
            e.actor === 'alice' &&
            e.path.endsWith('/approve') &&
            e.status === 403 &&
            e.csrfAccepted === true,
        ) ||
        !state.events.some(
          (e) =>
            e.actor === 'manager' &&
            e.path.endsWith('/approve') &&
            e.status === 200 &&
            e.csrfAccepted === true,
        )
      )
        throw new Error(
          'Actual server evidence did not establish duplicate prevention and legitimate role controls.',
        );
      if (
        process.argv.includes('--expect-ownership-defect') &&
        !http.some(
          (s) =>
            s.status === 'failed' &&
            new URL(s.action.http.url).pathname === '/api/orders/OB2002' &&
            s.action.http.expectedStatus === 403 &&
            s.result?.status === 200,
        )
      )
        throw new Error('Actual AI did not detect the deliberately broken ownership boundary.');
      if (process.argv.includes('--expect-ownership-defect')) {
        const unexpected = run.steps
          .filter((s) => s.status === 'failed')
          .filter(
            (s) =>
              s.action.operation !== 'http_check' ||
              new URL(s.action.http.url).pathname !== '/api/orders/OB2002' ||
              s.action.http.expectedStatus !== 403 ||
              s.result?.status !== 200,
          );
        if (unexpected.length)
          throw new Error(
            'Ownership negative control also had unexpected failures; it is not a clean defect-detection result.',
          );
      }
      console.log(
        `Actual server security controls verified: ${http.length} HTTP checks, ${state.creations} unique created orders, genuine member/manager sessions.`,
      );
    }
    if (multiWorkspace) {
      const finalState = await target.evaluate(() => fetch('/api/state').then((r) => r.json()));
      await writeFile(join(work, 'workspace-state.json'), JSON.stringify(finalState, null, 2));
      const primary = await target.locator('#project-summary').innerText();
      if (
        finalState.creations !== 1 ||
        finalState.theme !== 'dark' ||
        finalState.project?.name !== 'Aurora' ||
        finalState.project?.total !== 84 ||
        !run.steps.some((s) => s.action.operation === 'open_tab')
      )
        throw new Error(
          'Actual model did not complete the multi-tab server-backed workflow correctly.',
        );
      if (expectedStale) {
        const recordedRegression = assertions.some((s) => {
          if (s.status !== 'failed' || s.page !== 'main' || !s.result?.historical) return false;
          const prior = run.observations.find((o) => o.id === s.result.priorObservationId);
          const bad = run.observations.find((o) => o.id === s.result.observationId);
          const text = (o) =>
            o?.evidence?.results?.find((x) => x.target === '#project-summary')?.text;
          return (
            prior?.evidence?.page === 'main' &&
            bad?.evidence?.page === 'main' &&
            prior.evidence.url === origin + '/' &&
            bad.evidence.url === origin + '/' &&
            /Aurora.*Pro.*3 seats.*84/.test(text(prior) || '') &&
            text(bad) === 'Project details unavailable after workspace update' &&
            s.result.actual === text(bad) &&
            /Aurora|84/.test(s.action.assertion?.expected || '')
          );
        });
        if (
          run.status !== 'failed' ||
          (!primary.includes('unavailable') && !recordedRegression) ||
          !assertions.some(
            (s) =>
              s.status === 'failed' &&
              s.page === 'main' &&
              /Aurora|84/.test(s.action.assertion?.expected || ''),
          )
        )
          throw new Error(
            'Actual model did not detect the original tab changing after the review tab updated.',
          );
      } else if (
        run.status !== 'passed' ||
        !primary.includes('Aurora') ||
        !assertions.some((s) => s.status === 'passed' && s.page === 'main') ||
        !assertions.some((s) => s.status === 'passed' && s.page !== 'main')
      ) {
        throw new Error('Actual model did not independently verify both pages.');
      }
      const survivors = await worker.evaluate(() => chrome.tabs.query({}));
      if (
        !survivors.some((t) => t.id === tabId) ||
        survivors.some((t) => t.url === origin + '/review')
      )
        throw new Error(
          'Multi-tab cleanup removed the user tab or left the actor-created review tab behind.',
        );
      console.log(
        'Actual multi-tab state verified: one Aurora Pro project, $84 total, dark preference; original tab preserved and actor tab cleaned up.',
      );
    }
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
    if (panelErrors.length || (await panel.evaluate(() => globalThis.__voiceQAAnnouncements !== 0)))
      throw new Error('Chat produced a runtime error or unwanted voice announcement.');
    await writeFile(
      join(work, 'ui-checks.json'),
      JSON.stringify(
        {
          widths: [360, 420],
          reducedMotion: true,
          pageErrors: panelErrors,
          spokenAnnouncements: 0,
        },
        null,
        2,
      ),
    );
    if (generic && process.argv.includes('--followup') && run.status === 'passed') {
      const revised = await rpc('plan.propose', {
        request:
          'Revise the booking check to use three Advanced seats instead. Calculate the new total from the earlier fee. Do not submit another booking; verify the preview total only.',
        conversation: [
          { role: 'user', text: plan.request },
          { role: 'assistant', text: plan.summary },
        ],
        responsive: false,
        mode: 'qa',
        visual: false,
      });
      await writeFile(join(work, 'followup-plan.json'), JSON.stringify(revised, null, 2));
      const steps = revised.cases.flatMap((c) => c.steps);
      if (
        revised.clarification ||
        !steps.some((a) => a.operation === 'fill' && a.value === '3') ||
        !steps.some(
          (a) =>
            a.operation === 'assert' && ['75', '$75.00', '75.00'].includes(a.assertion?.expected),
        )
      )
        throw new Error('Actual AI follow-up did not preserve and revise the booking context.');
      await rpc('plan.confirm', { id: revised.id, version: revised.version });
      const next = await rpc('run.start', {
        planId: revised.id,
        version: revised.version,
        key: crypto.randomUUID(),
      });
      let followupRun;
      const followupDeadline = Date.now() + 180000;
      while (Date.now() < followupDeadline) {
        followupRun = await rpc('run.get', { id: next.runId });
        if (!['running', 'paused', 'queued'].includes(followupRun.status)) break;
        await new Promise((done) => setTimeout(done, 250));
      }
      await writeFile(join(work, 'followup-run.json'), JSON.stringify(followupRun, null, 2));
      if (followupRun.status !== 'passed')
        throw new Error('Actual AI follow-up execution did not pass.');
      console.log(
        'Actual AI follow-up revised three seats and verified the $75 preview in the browser.',
      );
    }
    if (generic && process.argv.includes('--ask-ui') && run.status === 'passed') {
      await panel.getByLabel('Request mode').selectOption('ask');
      await panel.evaluate(() => {
        const textarea = document.querySelector('#request');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
          textarea,
          'Read Workshop help and tell me how far in advance I can cancel. Cite the evidence.',
        );
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await panel.waitForFunction(
        () => !document.querySelector('[aria-label="Send question"]').disabled,
      );
      await panel
        .getByRole('button', { name: 'Send question', exact: true })
        .evaluate((button) => button.click());
      await panel
        .getByText(/Cancellation.*24|cancel.*24|24 hours/i)
        .last()
        .waitFor({ timeout: 480000 });
      await panel
        .getByText(/Evidence and tool calls/)
        .last()
        .waitFor();
      await panel.screenshot({ path: join(work, 'ask-answer.png'), fullPage: true });
      if (
        panelErrors.length ||
        (await panel.evaluate(() => globalThis.__voiceQAAnnouncements !== 0))
      )
        throw new Error('Q&A chat failed runtime/silent-operation checks');
      console.log(
        'Actual Ask chat submitted the question and rendered the evidence-backed model answer.',
      );
    }
    const expectedTotalDefect = process.argv.includes('--expect-total-defect');
    const expectedStatusDefect = process.argv.includes('--expect-status-defect');
    if (process.argv.includes('--live-reads')) {
      if (
        !automationLive ||
        origin !== 'http://127.0.0.1:4177' ||
        run.status !== (expectedStatusDefect ? 'failed' : 'passed')
      )
        throw new Error(
          'Live-read workspace did not finish: ' + run.status + ': ' + (run.error || ''),
        );
      const saved = await target.evaluate(() =>
        JSON.parse(localStorage.getItem('release-studio') || 'null'),
      );
      const inspected = run.readEvidence?.some(
        (o) =>
          o.evidence.tool === 'inspect_element' &&
          o.evidence.toolResult?.pattern === 'rel-[a-z]{4,8}',
      );
      if (
        !saved ||
        saved.title !== 'Atlas launch' ||
        !/^rel-[a-z]{4,8}$/.test(saved.handle) ||
        saved.status !== (expectedStatusDefect ? 'Archived' : 'Ready') ||
        saved.saves !== 1 ||
        !inspected ||
        !run.steps.some((s) => s.action.operation === 'navigate') ||
        (!expectedStatusDefect && assertions.filter((s) => s.status === 'passed').length < 3) ||
        (expectedStatusDefect &&
          !assertions.some(
            (s) =>
              s.status === 'failed' &&
              s.action.assertion?.expected === 'Ready' &&
              String(s.result?.actual).includes('Archived'),
          ))
      )
        throw new Error(
          'Actual agent omitted constraints inspection, custom selection, persistence verification, or saved more than once.',
        );
      await writeFile(join(work, 'persisted-release.json'), JSON.stringify(saved, null, 2));
      console.log(
        expectedStatusDefect
          ? 'Actual AI detected the corrupted persisted status: expected Ready, observed Archived after refresh, with one save.'
          : 'Actual AI inspected field constraints, created one compliant release through a custom combobox, refreshed and verified persisted values.',
      );
      if (process.argv.includes('--expect-continued-failure')) {
        const failedAt = run.steps.findIndex((s) => s.status === 'failed');
        if (
          failedAt < 0 ||
          !run.steps
            .slice(failedAt + 1)
            .some((s) => s.action.operation === 'assert' && s.status === 'passed')
        )
          throw new Error(
            'The actual agent did not continue independent verification after recording the defect',
          );
        console.log(
          'Actual AI continued verification after the recorded defect; the overall run correctly remains failed.',
        );
      }
    }
    if (process.argv.includes('--ide-controls')) {
      if (!automationLive || origin !== 'http://127.0.0.1:4177')
        throw new Error('IDE control acceptance is limited to the owned source editor fixture.');
      if (run.status !== 'passed')
        throw new Error(
          'IDE agent did not complete: ' + run.status + ': ' + (run.error || 'unverified outcome'),
        );
      const saved = {
        path: await target.locator('#saved-path').textContent(),
        source: await target.locator('#saved-source').textContent(),
        saves: await target.locator('#save-count').textContent(),
      };
      await writeFile(join(work, 'saved-source.json'), JSON.stringify(saved, null, 2));
      const expected =
        'pragma solidity ^0.8.20; contract VoiceQAProbe { uint256 public totalSupply = 1000; }';
      if (
        saved.path !== 'contracts/VoiceQAProbe.sol' ||
        saved.source !== expected ||
        saved.saves !== 'Saves: 1' ||
        !run.steps.some(
          (s) => s.action.operation === 'fill' && s.action.target.startsWith('node:'),
        ) ||
        assertions.filter((s) => s.status === 'passed').length < 2
      )
        throw new Error(
          'Actual agent did not create/edit/save once and verify the requested file and source.',
        );
      console.log(
        'Actual AI created the file through an unnamed input, edited the caret-based source control and verified saved content; one save. This is not a Solidity compilation/deployment test.',
      );
    }
    if (expectedTotalDefect) {
      if (!automationLive || origin !== 'http://127.0.0.1:4178')
        throw new Error('The receipt-defect check is limited to the owned adaptive wizard.');
      const receipt = await target.locator('#receipt').textContent();
      const submitted = await target.locator('#submitted').textContent();
      const failedTotal = assertions.some(
        (s) => s.status === 'failed' && /410(?:\.00)?/.test(s.action.assertion?.expected || ''),
      );
      if (
        run.status !== 'failed' ||
        !failedTotal ||
        !receipt.includes('$435.00') ||
        submitted !== 'Reservations submitted: 1'
      )
        throw new Error(
          'Actual AI did not detect the incorrect receipt using the independently expected $410 total, or submitted more than once.',
        );
      console.log(
        'Actual AI caught the incorrect $435 receipt against the $410 pricing oracle; exactly one reservation submitted.',
      );
    }
    const expectedFailure = process.argv.includes('--expect-failed');
    if (remixVM) {
      const text = await target.locator('body').innerText();
      const models = await target.evaluate(() =>
        globalThis.monaco.editor
          .getEditors()
          .map((e) => e.getModel?.())
          .filter((m) => m?.uri.path.endsWith('token.sol'))
          .map((m) => ({ uri: m.uri.toString(), value: m.getValue() })),
      );
      const state = {
        text,
        source: models.map((m) => m.value),
        models,
        width: await target.evaluate(() => innerWidth),
        progress: run.goalProgress,
      };
      await writeFile(join(work, 'remix-state.json'), JSON.stringify(state, null, 2));
      if (
        run.status !== 'passed' ||
        !models.some((m) => /\/contracts\/token\.sol$/.test(m.uri)) ||
        state.width !== plan.viewports[0].width ||
        !/Token\.\(constructor\)/.test(text) ||
        !text.includes('Remix VM')
      )
        throw new Error(
          'Actual Remix workflow did not complete with a local VM deployment and preserved width',
        );
      const expected = [
        'VoiceQA Token',
        'VQA',
        '18',
        '1000000000000000000000',
        '990000000000000000000',
        '10000000000000000000',
      ];
      if (
        !expected.every((value) =>
          assertions.some(
            (s) =>
              s.status === 'passed' &&
              String(s.result?.actual).includes(value) &&
              !/Editor content/.test(s.action.target),
          ),
        )
      )
        throw new Error(
          'Actual Remix getters were not independently checked with the requested token metadata/supply',
        );
      // Source text and button dispatches cannot stand in for actual calls.
      for (const method of ['name', 'symbol', 'decimals', 'totalSupply', 'balanceOf', 'transfer'])
        if (!new RegExp('\\.' + method + '\\s*\\(').test(text))
          throw new Error(`Remix has no recorded contract call/transaction for ${method}`);
      console.log(
        'Actual Remix local-VM creation, compilation, deployment and contract output checks completed; current width preserved.',
      );
    }
    if (visualWorkspace && process.argv.includes('--visual-qa')) {
      if (
        !run.agentEvents?.some((e) => e.kind === 'agent_route' && e.name === 'agent-s3') ||
        !run.steps.some((s) => s.result?.agent === 'agent-s3') ||
        !assertions.some(
          (s) =>
            s.action.assertion?.kind === 'visible' &&
            s.action.assertion.expected === 'true' &&
            s.status === 'passed',
        )
      )
        throw new Error(
          'Reviewed QA did not use actual visual recovery and preserve the original assertion',
        );
    }
    if (timingWorkspace) {
      const state = await target.evaluate(() => ({
        status: document.querySelector('#job-status').textContent,
        artifact: document.querySelector('#build-artifact')?.textContent,
        requests: document.querySelector('#compile-count').textContent,
        jobMs: Number(document.body.dataset.finishedAt) - Number(document.body.dataset.startedAt),
        width: innerWidth,
      }));
      await writeFile(join(work, 'timing-state.json'), JSON.stringify(state, null, 2));
      if (
        state.status !== 'Compilation succeeded' ||
        state.artifact !== 'TimingProbe artifact ready' ||
        state.requests !== 'Compile requests: 1' ||
        state.jobMs < 19500 ||
        state.width !== plan.viewports[0].width ||
        assertions.length < 3 ||
        (!process.argv.includes('--expect-readiness-recovery') &&
          !run.steps.some(
            (s) =>
              s.action.operation === 'wait_for' &&
              s.status === 'passed' &&
              s.result?.waitedMs >= 6000,
          ))
      )
        throw new Error(
          'Live AI did not wait for delayed readiness, independently verify all outcomes or preserve single dispatch/width.',
        );
      if (
        process.argv.includes('--expect-readiness-recovery') &&
        (!run.steps.some(
          (s) => ['wait_timeout', 'wait_changed'].includes(s.status) && s.result?.pending,
        ) ||
          !run.agentEvents?.some((e) =>
            ['readiness_timeout', 'readiness_changed'].includes(e.kind),
          ) ||
          run.steps.filter((s) => s.action.operation === 'click').length !== 1)
      )
        throw new Error(
          'The actual AI did not exercise a recorded short readiness timeout followed by non-replayed recovery.',
        );
      console.log(
        'Actual AI waited for a 20-second job and verified its status, artifact and exactly one compile request; browser width preserved.',
      );
    }
    if (visualWorkspace && process.argv.includes('--visual-agent')) {
      const state = {
        file: await target.locator('#active-file').textContent(),
        source: await target.locator('#editor').inputValue(),
        build: await target.locator('#build-status').textContent(),
        output: await target.locator('#output').textContent(),
        viewport: await target.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      };
      await writeFile(join(work, 'visual-state.json'), JSON.stringify(state, null, 2));
      if (
        state.file !== 'RouterProbe.sol' ||
        state.source !==
          'pragma solidity ^0.8.20; contract RouterProbe { uint public count = 7; }' ||
        state.build !== 'Compilation succeeded' ||
        state.output !== 'Canvas checks passed' ||
        state.viewport.width !== plan.viewports[0].width ||
        !run.steps.some((s) => s.result?.agent === 'agent-s3') ||
        !run.agentEvents?.some((e) => e.kind === 'agent_route' && e.name === 'agent-s3') ||
        !assertions.length
      )
        throw new Error(
          'Actual hybrid workflow did not satisfy independent state, routing and assertion checks',
        );
      console.log(
        'Actual Dots → Agent S/Qwen → DOM verification passed; file, source, fixture build, canvas and current viewport independently checked.',
      );
      if (process.argv.includes('--goal-recovery')) {
        const counts = await target.evaluate(() => ({
          clicks: Number(document.body.dataset.fileClicks || 0),
          creations: Number(document.body.dataset.fileCreations || 0),
        }));
        await writeFile(join(work, 'goal-recovery-state.json'), JSON.stringify(counts, null, 2));
        if (counts.clicks < 2 || counts.creations !== 1)
          throw new Error(
            'Goal recovery did not retry the ineffective UI control and create exactly one file',
          );
        console.log(
          'Actual AI recovered from an ineffective first click, completed the goal, and created exactly one file.',
        );
      }
      if (process.argv.includes('--visual-investigate')) {
        const before = await target.locator('body').innerText();
        const answer = await rpc('agent.query', {
          request:
            'Inspect the rendered canvas panel and report the two button labels and their colors. DOM text does not expose their labels. Use visual inspection and cite evidence. Do not click, type, scroll or change the application.',
          readLinks: false,
        });
        await writeFile(join(work, 'visual-investigation.json'), JSON.stringify(answer, null, 2));
        if (
          !answer.evidence?.some(
            (e) =>
              e.tool === 'visual_inspect' && !e.error && e.result?.model === 'qwen/qwen3.7-flash',
          ) ||
          before !== (await target.locator('body').innerText())
        )
          throw new Error('Actual read-only Agent S investigation failed or changed the page');
        console.log(
          'Actual Dots → Agent S/Qwen read-only canvas investigation passed; page unchanged.',
        );
      }
    }
    if (
      (expectedTotalDefect || expectedStale || expectedStatusDefect
        ? false
        : expectedFailure
          ? run.status !== 'failed' ||
            !assertions.some((s) => s.status === 'failed') ||
            !assertions.some((s) => s.status === 'passed')
          : run.status !== 'passed') ||
      (!process.argv.includes('--fast') && gaps.some((ms) => ms < 3900))
    )
      throw new Error('Paced workflow did not pass with the required gap.');
  }
} catch (error) {
  const diagnostic = new DatabaseSync(join(data, 'voiceqa.db'), { readOnly: true });
  try {
    // Transport loss can prevent RPC from returning the final run. Preserve
    // local partial records as such; never label them completed acceptance.
    const partialRuns = diagnostic
      .prepare('SELECT body FROM records WHERE kind=?')
      .all('run')
      .map((row) => JSON.parse(row.body));
    await writeFile(join(work, 'partial-runs.json'), JSON.stringify(partialRuns, null, 2));
    const investigations = diagnostic
      .prepare('SELECT body FROM records WHERE kind=?')
      .all('investigation')
      .map((row) => JSON.parse(row.body));
    const planning = diagnostic
      .prepare('SELECT body FROM records WHERE kind=?')
      .all('planning_diagnostic')
      .map((row) => JSON.parse(row.body));
    await writeFile(join(work, 'investigations.json'), JSON.stringify(investigations, null, 2));
    await writeFile(join(work, 'planning-diagnostics.json'), JSON.stringify(planning, null, 2));
    const reviews = diagnostic
      .prepare('SELECT body FROM records WHERE kind=?')
      .all('plan_review')
      .map((row) => JSON.parse(row.body));
    await writeFile(join(work, 'plan-reviews.json'), JSON.stringify(reviews, null, 2));
    const reviewDiagnostics = diagnostic
      .prepare('SELECT body FROM records WHERE kind=?')
      .all('plan_review_diagnostic')
      .map((row) => JSON.parse(row.body));
    await writeFile(
      join(work, 'plan-review-diagnostics.json'),
      JSON.stringify(reviewDiagnostics, null, 2),
    );
    await writeFile(
      join(work, 'failure.json'),
      JSON.stringify({ error: String(error.message).slice(0, 1600) }, null, 2),
    );
  } finally {
    diagnostic.close();
  }
  throw error;
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
      if (
        debugRecord ||
        process.argv.includes('--visual-qa') ||
        livePlanning ||
        process.argv.includes('--followup') ||
        process.argv.includes('--investigate') ||
        process.argv.includes('--ask-ui')
      )
        for (const name of copiedKeys)
          await unlink(join(data, name)).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          });
    }
  }
}
