// Supplementary real-browser privacy/form-identity probe, without AI substitutes.
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4179/');
  await page.evaluate(() => {
    globalThis.chrome = {
      runtime: {
        id: 'submission-probe',
        onMessage: {
          addListener(handler) {
            globalThis.probeHandler = handler;
          },
        },
      },
    };
    document.body.insertAdjacentHTML(
      'beforeend',
      '<form id="probe"><label>Private value<input type="password" id="private-value" value="probe-secret-a"></label><button id="probe-submit">Submit probe</button></form>',
    );
  });
  await page.evaluate(await readFile('extension/content.js', 'utf8'));
  const results = await page.evaluate(async () => {
    const send = (message) =>
      new Promise((done) => globalThis.probeHandler(message, { id: 'submission-probe' }, done));
    const first = await send({ type: 'vqa.action-context', target: '#probe-submit' });
    document.querySelector('#probe-submit').focus();
    const focused = await send({ type: 'vqa.action-context', target: '#probe-submit' });
    document.querySelector('#private-value').focus();
    const enter = await send({ type: 'vqa.action-context', focused: true, key: 'Enter' });
    const observe = await send({ type: 'vqa.observe' });
    document.querySelector('#private-value').value = 'probe-secret-b';
    const changed = await send({ type: 'vqa.action-context', target: '#probe-submit' });
    return { first, focused, enter, changed, observe };
  });
  const key = results.first.result.submissionKey;
  if (
    !/^[a-f0-9]{32}$/.test(key) ||
    key !== results.focused.result.submissionKey ||
    key !== results.enter.result.submissionKey ||
    key === results.changed.result.submissionKey
  )
    throw new Error(
      'Opaque submission identity did not track unchanged/changed form data consistently.',
    );
  if (
    JSON.stringify(results).includes('probe-secret-') ||
    JSON.stringify(results.observe).includes('submissionKey')
  )
    throw new Error(
      'Private values or controller-only identities leaked into public observations.',
    );
  await mkdir('.tools/live-checks', { recursive: true });
  await writeFile(
    '.tools/live-checks/submission-context.json',
    JSON.stringify(
      {
        unchangedStable: true,
        enterSharesIdentity: true,
        changedPrivateValueGetsNewIdentity: true,
        privateValuesExcluded: true,
        publicObservationHasNoIdentity: true,
      },
      null,
      2,
    ),
  );
  console.log(
    'Actual DOM probe passed: focus does not bypass submission identity, Enter shares it, changed private data gets a new opaque identity, no private values exposed.',
  );
} finally {
  await browser.close();
}
