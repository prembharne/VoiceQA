import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
const nemotronOnly = process.argv.includes('--nemotron-only');
if (nemotronOnly && process.argv.includes('--live-paid'))
  throw new Error('Conflicting model modes');
if (!nemotronOnly && !process.argv.includes('--live-paid'))
  throw new Error('This calls paid Qwen. Pass --live-paid after authorizing that use.');

const work = await mkdtemp(resolve('.tools/live-checks/agent-s-grounding-'));
const child = spawn(
  resolve(process.env.VOICEQA_AGENT_S_PYTHON || 'dist/agent-s-runtime/Scripts/python.exe'),
  ['scripts/agent-s-live-probe.py', nemotronOnly ? '--nemotron-only' : '--live-paid'],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
);
const lines = createInterface({ input: child.stdout });
let queued;
lines.on('line', (line) => queued?.(JSON.parse(line)));
function ask(payload) {
  return new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Grounding request timed out')), 120000);
    queued = (result) => {
      clearTimeout(timer);
      result.error ? reject(new Error(JSON.stringify(result))) : done(result);
    };
    child.stdin.write(JSON.stringify(payload) + '\n');
  });
}
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const [width, height] of [
    [1280, 720],
    [1440, 900],
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(await readFile('tests/fixtures/visual-workspace.html', 'utf8'));
    const cases = [
      {
        selector: '#new-file',
        description: 'The New file button in the file explorer on the left.',
        effect: 'Filename input opened',
      },
      { selector: '#filename', description: 'The File name text input in the editor area.' },
      {
        selector: '#compile',
        description: 'The Compile contract button in the top toolbar.',
        effect: 'No contract source',
      },
      {
        selector: '#canvas',
        description: 'The blue Run checks button inside the small bottom-right panel.',
        canvas: true,
        effect: 'Canvas checks passed',
      },
    ];
    for (const [index, test] of cases.entries()) {
      const name = `${width}-${index + 1}`;
      const screenshot = await page.screenshot({ path: join(work, name + '.png') });
      const response = await ask({
        mode: 'ground',
        readOnly: false,
        image: screenshot.toString('base64'),
        description: test.description,
      });
      const point = response.result;
      if (nemotronOnly && response.model !== 'nvidia/nemotron-3.5-super-vl:free')
        throw new Error('Unexpected model identity');
      const box = await page.locator(test.selector).boundingBox();
      const expected = test.canvas ? { x: box.x + 14, y: box.y + 14, width: 94, height: 37 } : box;
      const inside =
        point.x >= expected.x &&
        point.x <= expected.x + expected.width &&
        point.y >= expected.y &&
        point.y <= expected.y + expected.height;
      let effect = false;
      if (inside) {
        await page.mouse.click(point.x, point.y);
        effect = test.effect
          ? (await page.locator('body').getAttribute('data-last-action')) === test.effect
          : await page.locator(test.selector).evaluate((e) => e === document.activeElement);
      }
      results.push({
        name,
        description: test.description,
        model: response.model,
        point,
        expected,
        inside,
        effect,
        modelCalls: response.modelCalls,
      });
      await writeFile(join(work, 'results.json'), JSON.stringify({ results }, null, 2));
      console.log(JSON.stringify({ name, inside, effect, point }));
    }
    await page.close();
  }
  if (results.some((x) => !x.inside || !x.effect))
    throw new Error('Actual visual grounding failed independent hit/effect verification');
  console.log('Actual Agent S grounding passed ' + results.length + ' targets. Evidence: ' + work);
} finally {
  child.stdin.end();
  child.kill();
  await browser.close();
}
