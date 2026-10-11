import test from 'node:test';
import assert from 'node:assert/strict';
import { Dictation } from '../../shared/dictation.js';

function fixture() {
  const recognizers = [],
    text = [],
    states = [],
    errors = [];
  const dictation = new Dictation(() => {
    const recognition = {
      start() {
        this.onstart?.();
      },
      stop() {
        this.onend?.();
      },
      abort() {
        this.onend?.();
      },
    };
    recognizers.push(recognition);
    return recognition;
  });
  return {
    dictation,
    recognizers,
    text,
    states,
    errors,
    start() {
      dictation.start(
        (t) => text.push(t),
        (s) => states.push(s),
        (e) => errors.push(e.message),
      );
    },
  };
}
test('dictation replaces interim results and returns text without triggering work', () => {
  const f = fixture();
  f.start();
  const r = f.recognizers[0];
  r.onresult({ results: [[{ transcript: 'test cart' }]] });
  r.onresult({
    results: [[{ transcript: 'test cart totals' }], [{ transcript: 'then invoices' }]],
  });
  assert.deepEqual(f.text, ['test cart', 'test cart totals then invoices']);
  f.dictation.stop(false);
  assert.equal(f.dictation.session, null);
  assert.equal(f.states.at(-1), 'Idle');
  assert.deepEqual(f.errors, []);
});
test('cancelled and superseded recognizers cannot change the new draft', () => {
  const f = fixture();
  f.start();
  const old = f.recognizers[0];
  f.start();
  old.onresult({ results: [[{ transcript: 'stale' }]] });
  old.onend();
  old.onerror({ error: 'network' });
  const current = f.recognizers[1];
  current.onresult({ results: [[{ transcript: 'fresh' }]] });
  f.dictation.stop(true);
  current.onresult({ results: [[{ transcript: 'late' }]] });
  assert.deepEqual(f.text, ['fresh']);
  assert.deepEqual(f.errors, []);
});
test('permission and service errors release the microphone state with a useful message', () => {
  const f = fixture();
  f.start();
  f.recognizers[0].onerror({ error: 'not-allowed' });
  assert.equal(f.dictation.session, null);
  assert.match(f.errors[0], /Microphone access was denied/);
  assert.equal(f.states.at(-1), 'Idle');
  const missing = new Dictation(() => {
    throw new Error('Unsupported browser');
  });
  missing.start(
    () => assert.fail('unexpected text'),
    () => {},
    (error) => assert.equal(error.message, 'Unsupported browser'),
  );
});
