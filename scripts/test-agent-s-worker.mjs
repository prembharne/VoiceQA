import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
if (!process.argv.includes('--live-paid'))
  throw new Error('Explicit paid Qwen authorization required: --live-paid');
const work = await mkdtemp(resolve('.tools/live-checks/agent-s-worker-'));
const child = spawn(
  resolve(process.env.VOICEQA_AGENT_S_PYTHON || 'dist/agent-s-runtime/Scripts/python.exe'),
  ['scripts/agent-s-live-probe.py', '--live-paid'],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
);
const lines = createInterface({ input: child.stdout });
let resolveReply;
lines.on('line', (line) => resolveReply?.(JSON.parse(line)));
async function ask(payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker deadline')), 160000);
    resolveReply = (r) => {
      clearTimeout(timer);
      r.error ? reject(new Error(JSON.stringify(r))) : resolve(r);
    };
    child.stdin.write(JSON.stringify(payload) + '\n');
  });
}
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent(await readFile('tests/fixtures/visual-workspace.html', 'utf8'));
  const history = [];
  for (let turn = 0; turn < 12; turn++) {
    const image = await page.screenshot({ path: join(work, `turn-${turn}.png`) });
    const reply = await ask({
      image: image.toString('base64'),
      instruction:
        'Create Probe.sol using New file. Fill the source editor with exactly: pragma solidity ^0.8.20; contract Probe { uint public count = 7; }. Compile it. Finally click the blue Run checks button in the canvas panel. Use done only after it shows Canvas checks passed. Prior actual results: ' +
        JSON.stringify(history),
    });
    const a = reply.result;
    console.log(JSON.stringify(a));
    if (a.operation === 'done') break;
    if (a.operation === 'click') await page.mouse.click(a.x, a.y);
    else if (a.operation === 'fill') {
      await page.mouse.click(a.x, a.y);
      await page.keyboard.press('Control+a');
      await page.keyboard.insertText(a.value);
    } else if (a.operation === 'key') await page.keyboard.press(a.value);
    else throw new Error('Unexpected intent ' + a.operation);
    history.push({
      intent: a,
      lastAction: await page.locator('body').getAttribute('data-last-action'),
    });
    await writeFile(join(work, 'results.json'), JSON.stringify(history, null, 2));
  }
  if (
    (await page.locator('#active-file').textContent()) !== 'Probe.sol' ||
    !(await page.locator('#editor').inputValue()).includes('contract Probe') ||
    (await page.locator('#output').textContent()) !== 'Canvas checks passed'
  )
    throw new Error('Independent workflow verification failed');
  console.log('Actual Agent S/Qwen worker workflow passed: ' + work);
} finally {
  child.kill();
  await browser.close();
}
