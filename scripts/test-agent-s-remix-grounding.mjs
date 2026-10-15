// Read-only real-site grounding. Does not accept consent, connect a wallet or deploy.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
if (!process.argv.includes('--live-paid'))
  throw new Error('Explicit --live-paid authorization is required.');
const work = await mkdtemp(resolve('.tools/live-checks/remix-real-grounding-'));
const child = spawn(
  resolve(process.env.VOICEQA_AGENT_S_PYTHON || 'dist/agent-s-runtime/Scripts/python.exe'),
  ['scripts/agent-s-live-probe.py', '--live-paid'],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
);
const lines = createInterface({ input: child.stdout });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('https://app.remix.live/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const target = page.getByRole('button', { name: 'Manage Preferences', exact: true });
  await target.waitFor({ timeout: 30000 });
  const png = await page.screenshot({ path: join(work, 'remix.png') });
  const reply = await new Promise((resolveReply, reject) => {
    const timer = setTimeout(() => reject(new Error('Grounding deadline')), 120000);
    lines.once('line', (line) => {
      clearTimeout(timer);
      const r = JSON.parse(line);
      r.error ? reject(new Error(r.error)) : resolveReply(r);
    });
    child.stdin.write(
      JSON.stringify({
        mode: 'ground',
        readOnly: true,
        image: png.toString('base64'),
        description:
          'The Manage Preferences button in the AI and Analytics Preferences dialog at the top of the screen.',
      }) + '\n',
    );
  });
  const p = reply.result,
    box = await target.boundingBox();
  const inside =
    p.x >= box.x && p.x < box.x + box.width && p.y >= box.y && p.y < box.y + box.height;
  const evidence = {
    url: page.url(),
    model: reply.model,
    point: p,
    expected: box,
    inside,
    inputDispatched: false,
  };
  await writeFile(join(work, 'result.json'), JSON.stringify(evidence, null, 2));
  if (!inside) throw new Error('Actual Remix control grounding missed its real bounding box');
  console.log(JSON.stringify({ ...evidence, evidence: work }));
} finally {
  child.kill();
  await browser.close();
}
