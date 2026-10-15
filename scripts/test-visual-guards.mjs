// Real Chromium hit-testing and evidence revisions; no model calls here.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4181/');
  await page.evaluate(() => {
    globalThis.chrome = {
      runtime: {
        onMessage: {
          addListener(fn) {
            globalThis.__handler = fn;
          },
        },
      },
    };
  });
  await page.addScriptTag({ content: await readFile('extension/content.js', 'utf8') });
  const call = (p) => page.evaluate((p) => new Promise((resolve) => __handler(p, {}, resolve)), p);
  const a = (await call({ type: 'vqa.visual-state' })).result;
  await call({ type: 'vqa.redact' });
  await call({ type: 'vqa.cleanup' });
  assert.deepEqual(
    (await call({ type: 'vqa.visual-state' })).result,
    a,
    'Owned redaction must not invalidate the screenshot',
  );
  await page.locator('#output').evaluate((el) => (el.textContent = 'Changed'));
  assert.notEqual(
    (await call({ type: 'vqa.visual-state' })).result.revision,
    a.revision,
    'Text mutations must invalidate',
  );
  const b = (await call({ type: 'vqa.visual-state' })).result;
  await page.locator('#compile').evaluate((el) => (el.disabled = true));
  assert.notEqual(
    (await call({ type: 'vqa.visual-state' })).result.revision,
    b.revision,
    'Attribute changes must invalidate',
  );
  await page.evaluate(() => {
    const i = document.createElement('input');
    i.type = 'password';
    i.id = 'secret';
    i.style.cssText = 'position:fixed;left:500px;top:100px;width:150px;height:40px';
    document.body.append(i);
  });
  assert.match(
    (await call({ type: 'vqa.visual-point', point: { x: 520, y: 120 }, operation: 'fill' })).error,
    /private/,
  );
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.dataset.private = '';
    host.style.cssText = 'position:fixed;left:700px;top:100px;width:150px;height:40px';
    host.attachShadow({ mode: 'open' }).innerHTML = '<input style="width:140px;height:35px">';
    document.body.append(host);
  });
  assert.match(
    (await call({ type: 'vqa.visual-point', point: { x: 720, y: 120 }, operation: 'fill' })).error,
    /private/,
  );
  assert.match(
    (await call({ type: 'vqa.visual-point', point: { x: -1, y: 2 }, operation: 'click' })).error,
    /outside/,
  );
  const box = await page.locator('#canvas').boundingBox();
  const point = { x: Math.round(box.x + 25), y: Math.round(box.y + 30) };
  const hit = await call({ type: 'vqa.visual-point', point, operation: 'click' });
  assert.equal(hit.result.tag, 'CANVAS');
  assert.equal(hit.result.x, point.x);
  await page.mouse.click(hit.result.x, hit.result.y);
  assert.equal(await page.locator('#output').textContent(), 'Canvas checks passed');
  console.log(
    'Real browser visual guards passed: redaction, text/attribute revisions, private fields, bounds, canvas point preservation.',
  );
} finally {
  await browser.close();
}
