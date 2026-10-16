import test from 'node:test';
import assert from 'node:assert/strict';
import { editorModelBridge } from '../../extension/editor-bridge.js';

function environment(t, source) {
  const previous = {
    location: globalThis.location,
    document: globalThis.document,
    monaco: globalThis.monaco,
  };
  const root = { closest: () => null, querySelector: () => null };
  const target = {
    isConnected: true,
    value: 'return false; } }',
    closest: (s) => (s === '.monaco-editor' ? root : null),
  };
  let value = source,
    writes = 0,
    eol = '\r\n';
  const model = {
    getValue: () => value,
    getValueLength: () => value.length,
    getFullModelRange: () => ({ startLineNumber: 1, endLineNumber: 50 }),
    getVersionId: () => writes + 1,
    getEOL: () => eol,
    pushEOL: (kind) => {
      eol = kind === 1 ? '\r\n' : '\n';
    },
  };
  const editor = {
    getDomNode: () => root,
    getModel: () => model,
    getOption: () => false,
    pushUndoStop: () => {},
    executeEdits: (_, edits) => {
      writes++;
      value = edits[0].text.replace(/\r\n|\r|\n/g, eol);
    },
  };
  globalThis.location = { href: 'https://app.test/' };
  globalThis.document = { querySelector: () => target };
  globalThis.monaco = { editor: { getEditors: () => [editor], EditorOption: { readOnly: 1 } } };
  t.after(() => Object.assign(globalThis, previous));
  return {
    root,
    target,
    writes: () => writes,
    context: {
      url: location.href,
      marker: '00000000-0000-4000-8000-000000000000',
      privateSelectors: '[data-private]',
    },
  };
}
test('editor reads the full bound model instead of the virtual typing buffer', (t) => {
  const source = 'pragma solidity ^0.8.0;\ncontract Token { uint public totalSupply=1000; }';
  const e = environment(t, source);
  const result = editorModelBridge(e.context, 'read');
  assert.equal(result.value, source);
  assert.equal(result.complete, true);
  assert.equal(e.writes(), 0);
  const next = source + '\n';
  const written = editorModelBridge(e.context, 'replace', next);
  assert.equal(written.value, next);
  assert.equal(written.verified, true);
  assert.equal(e.writes(), 1);
});
test('wrong document, private editor and oversize models cannot produce complete values', (t) => {
  const e = environment(t, 'x'.repeat(4001));
  assert.equal(editorModelBridge(e.context, 'read').complete, false);
  assert.equal(
    editorModelBridge({ ...e.context, url: 'https://other.test/' }, 'replace', 'anything')
      .unavailable,
    true,
  );
  e.root.querySelector = () => ({});
  assert.equal(editorModelBridge(e.context, 'replace', 'anything').unavailable, true);
  assert.equal(e.writes(), 0);
});
