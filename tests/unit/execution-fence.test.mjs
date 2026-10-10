import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionFence } from '../../shared/execution-fence.js';
test('cancelled async work cannot revive when the UI clears its cancelled flag', () => {
  const fence = new ExecutionFence();
  const state = { runId: 'run', target: { tabId: 1 }, cancelled: false };
  const token = fence.token('run', 1);
  fence.check(token, state);
  fence.invalidate();
  state.cancelled = false;
  assert.throws(() => fence.check(token, state), /cancelled or superseded/);
});
test('operation tokens are bound to the run and target identity', () => {
  const fence = new ExecutionFence();
  const token = fence.token('run', 1);
  assert.throws(() => fence.check(token, { runId: 'other', target: { tabId: 1 } }));
  assert.throws(() => fence.check(token, { runId: 'run', target: { tabId: 2 } }));
});
