import test from 'node:test';
import assert from 'node:assert/strict';
import validate from '../../shared/envelope-validator.js';
import { validateAction, isAllowedURL } from '../../shared/protocol.js';
test('envelope schema rejects version mismatch and extra fields', () => {
  assert.equal(validate({ version: 1, id: 'a', type: 'hello', payload: {} }), true);
  assert.equal(validate({ version: 2, id: 'a', type: 'hello', payload: {} }), false);
  assert.equal(validate({ version: 1, id: 'a', type: 'hello', payload: {}, evil: true }), false);
});
test('executor rejects arbitrary code and unsupported keyboard shortcuts', () => {
  assert.throws(() => validateAction({ operation: 'eval', value: 'fetch(secret)' }));
  assert.throws(() => validateAction({ operation: 'key', value: 'Control+W' }));
  assert.doesNotThrow(() => validateAction({ operation: 'key', value: 'Tab' }));
});
test('origin check does not accept lookalike domains', () => {
  assert.equal(isAllowedURL('https://qa.test.evil/', 'https://qa.test'), false);
  assert.equal(isAllowedURL('chrome://settings', 'chrome://settings'), false);
  assert.equal(isAllowedURL('https://qa.test/cart', 'https://qa.test'), true);
});
