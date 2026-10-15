// Actual Chromium/content-script polling. Independent of live-model acceptance.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pollCondition } from '../shared/condition-wait.js';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1111, height: 777 } });
  await page.goto('http://127.0.0.1:4181/timing?delay=12500');
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
  const send = async (message) => {
    const reply = await page.evaluate(
      (message) => new Promise((resolve) => __handler(message, {}, resolve)),
      message,
    );
    if (reply.error) throw Object.assign(new Error(reply.error), { code: reply.code });
    return reply.result;
  };
  const call = (action) => send({ type: 'vqa.assert', action });
  const wait = {
    operation: 'wait_for',
    target: 'role:button|Compile',
    assertion: { kind: 'enabled', expected: 'true' },
  };
  await send({ type: 'vqa.resolve', target: wait.target });
  await page.locator('#compile').click();
  const renamed = await pollCondition(wait, {
    check() {},
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    read: call,
  });
  assert.equal(renamed.passed, true);
  assert.ok(renamed.waitedMs > 12000);
  assert.match(renamed.checkedTarget, /^node:/);
  assert.equal(await page.locator('#compile-count').textContent(), 'Compile requests: 1');
  assert.equal(await page.locator('#build-artifact').textContent(), 'TimingProbe artifact ready');
  const polling = {
    read: call,
    check() {},
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
  await assert.rejects(
    pollCondition({ ...wait, target: '#never-created', timeoutMs: 1000 }, polling),
    {
      code: 'wait_timeout',
    },
  );
  await page.evaluate(() => {
    document.querySelector('#job-status').textContent = 'Compilation running';
    setTimeout(() => {
      document.querySelector('#job-status').textContent = 'Compilation succeeded';
    }, 300);
  });
  await assert.rejects(
    pollCondition(
      {
        operation: 'wait_for',
        target: '#job-status',
        timeoutMs: 120000,
        assertion: { kind: 'text', expected: 'Compilation complete' },
      },
      { ...polling, reinspectOnChange: true },
    ),
    (e) => {
      assert.equal(e.code, 'wait_changed');
      assert.equal(e.result.pending, true);
      assert.ok(e.result.waitedMs < 2500);
      return true;
    },
  );
  await assert.rejects(
    pollCondition(
      {
        operation: 'assert',
        target: '#job-status',
        timeoutMs: 500,
        assertion: { kind: 'text', expected: 'Incorrect result' },
      },
      polling,
    ),
    { code: 'assertion_failed' },
  );
  let cancelled = false;
  const cancelling = pollCondition(
    { ...wait, target: '#never-created' },
    {
      ...polling,
      check() {
        if (cancelled) throw Object.assign(new Error('Stopped'), { code: 'cancelled' });
      },
    },
  );
  setTimeout(() => {
    cancelled = true;
  }, 300);
  await assert.rejects(cancelling, { code: 'cancelled' });
  assert.equal(await page.evaluate(() => innerWidth), 1111);
  console.log(
    JSON.stringify({
      renamedButtonWaitMs: renamed.waitedMs,
      timeoutClass: 'wait_timeout',
      genuineMismatchClass: 'assertion_failed',
      cancellation: 'passed',
      singleCompileRequest: true,
      width: 1111,
    }),
  );
} finally {
  await browser.close();
}
