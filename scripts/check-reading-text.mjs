// Supplementary real-DOM public-text/privacy check, not AI acceptance.
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4180/guide');
  await page.evaluate(() => {
    globalThis.chrome = {
      runtime: {
        id: 'reading-probe',
        onMessage: {
          addListener(handler) {
            globalThis.readingHandler = handler;
          },
        },
      },
    };
    document.body.insertAdjacentHTML(
      'beforeend',
      '<ul><li>Visible ordinary list rule</li><li data-private>private-list-sentinel</li></ul><div style="display:none"><p>css-hidden-sentinel</p></div><div aria-hidden="true"><span>aria-hidden-sentinel</span></div><input type="password" value="password-value-sentinel">',
    );
  });
  await page.evaluate(await readFile('extension/content.js', 'utf8'));
  const observation = await page.evaluate(
    () =>
      new Promise((resolve) =>
        globalThis.readingHandler({ type: 'vqa.observe' }, { id: 'reading-probe' }, resolve),
      ),
  );
  const text = observation.result.text;
  if (
    !text.includes('/api/orders/OB2002') ||
    !text.includes('Idempotency-Key') ||
    !text.includes('Visible ordinary list rule')
  )
    throw new Error('Visible list-based application rules were omitted.');
  for (const marker of [
    'private-list-sentinel',
    'css-hidden-sentinel',
    'aria-hidden-sentinel',
    'password-value-sentinel',
  ])
    if (text.includes(marker)) throw new Error('Private or hidden reading text leaked.');
  await mkdir('.tools/live-checks', { recursive: true });
  await writeFile(
    '.tools/live-checks/reading-text.json',
    JSON.stringify(
      { visibleRulesPresent: true, privateAndHiddenExcluded: true, characters: text.length },
      null,
      2,
    ),
  );
  console.log(
    'Actual DOM reading passed: ownership/idempotency list rules included; private, CSS-hidden, aria-hidden and password content excluded.',
  );
} finally {
  await browser.close();
}
