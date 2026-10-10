import test from 'node:test';
import assert from 'node:assert/strict';
import { say } from '../../extension/src/voice.js';
test('browser speech watchdog releases a blocked speaking state', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.SpeechSynthesisUtterance = class {};
  let cancelled = 0;
  globalThis.speechSynthesis = {
    cancel() {
      cancelled++;
    },
    speak() {},
  };
  let error;
  say('Hello', (e) => (error = e));
  t.mock.timers.tick(5001);
  assert.match(error.message, /did not start/);
  assert.equal(cancelled, 2);
});
test('cancelling speech clears its watchdog without a late completion callback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.SpeechSynthesisUtterance = class {};
  globalThis.speechSynthesis = { cancel() {}, speak() {} };
  let done = false;
  const stop = say('Hello', () => (done = true));
  stop();
  t.mock.timers.tick(6000);
  assert.equal(done, false);
});
