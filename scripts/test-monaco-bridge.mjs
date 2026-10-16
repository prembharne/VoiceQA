// Exercise the closed adapter against real Monaco in an isolated Remix page.
// Only a disposable editor is changed; this is not an AI workflow acceptance.
import { chromium } from '@playwright/test';
import { editorModelBridge } from '../extension/editor-bridge.js';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto('https://app.remix.live/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.monaco?.editor?.create, null, { timeout: 90000 });
  const context = await page.evaluate(() => {
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;top:0;left:0;width:600px;height:250px;z-index:999999';
    document.body.append(container);
    const model = monaco.editor.createModel('old\r\nsource', 'solidity');
    const editor = monaco.editor.create(container, { model });
    const target = editor.getDomNode().querySelector('textarea');
    const marker = crypto.randomUUID();
    target.setAttribute('data-voiceqa-editor', marker);
    return {
      url: location.href,
      marker,
      privateSelectors: '[data-private]',
      binding: editor.getDomNode().getAttribute('data-uri') || '',
    };
  });
  // Use the same static function through Chrome's page execution mechanism.
  const cdp = await page.context().newCDPSession(page);
  const global = await cdp.send('Runtime.evaluate', { expression: 'globalThis' });
  const call = async (operation, value = '') => {
    const result = await cdp.send('Runtime.callFunctionOn', {
      functionDeclaration: editorModelBridge.toString(),
      objectId: global.result.objectId,
      // This static adapter is supplied by the test, not by the model or website.
      arguments: [{ value: context }, { value: operation }, { value }],
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const source = 'pragma solidity ^0.8.0;\ncontract Probe { uint public count=7; }\n';
  const first = await call('replace', source);
  assert.equal(first.verified, true);
  assert.equal((await call('read')).value, source);
  const crlf = source.replaceAll('\n', '\r\n');
  assert.equal((await call('replace', crlf)).verified, true);
  assert.equal((await call('read')).value, crlf);
  console.log('Real Monaco LF/CRLF replacement and complete exact readbacks passed.');
} finally {
  await browser.close();
}
