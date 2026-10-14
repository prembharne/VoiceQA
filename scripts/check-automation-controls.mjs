// Supplementary real-DOM policy probe. This does not replace live model journeys.
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4178/');
  await page.evaluate(() => {
    globalThis.chrome = {
      runtime: {
        id: 'policy-probe',
        onMessage: {
          addListener(handler) {
            globalThis.policyHandler = handler;
          },
        },
      },
    };
    document.body.insertAdjacentHTML(
      'beforeend',
      `
      <button id="send">Send message <span id="send-icon">↗</span></button>
      <button id="delete">Delete account</button>
      <form><input autocomplete="cc-number"><button id="financial">Continue</button></form>
      <a id="route" href="/%2564elete">Continue</a>
      <form action="/pay"><button id="submit-route">Continue</button></form>
      <button id="publish">Publish</button>`,
    );
  });
  await page.evaluate(await readFile('extension/content.js', 'utf8'));
  const checks = await page.evaluate(async () => {
    const get = (target, focused = false) =>
      new Promise((done) =>
        globalThis.policyHandler(
          { type: 'vqa.action-context', target, focused },
          { id: 'policy-probe' },
          done,
        ),
      );
    const results = {};
    for (const [label, target] of Object.entries({
      normal: 'role:button|Next',
      send: '#send',
      nestedIcon: '#send-icon',
      deletion: '#delete',
      financial: '#financial',
      encodedRoute: '#route',
      submitRoute: '#submit-route',
    }))
      results[label] = await get(target);
    document.querySelector('#publish').focus();
    results.focusedPublish = await get('', true);
    return results;
  });
  for (const [label, value] of Object.entries(checks)) {
    if (value.error || value.result?.consequential !== (label !== 'normal'))
      throw new Error(`Unexpected consequence classification: ${label}: ${JSON.stringify(value)}`);
  }
  await mkdir('.tools/live-checks', { recursive: true });
  await writeFile(
    '.tools/live-checks/automation-consequence-browser.json',
    JSON.stringify(checks, null, 2),
  );
  console.log(
    'Eight actual DOM classifications passed: ordinary Next allowed; sending/deletion/payment, nested icons, encoded routes and focused publishing guarded.',
  );
} finally {
  await browser.close();
}
