import test from 'node:test';
import assert from 'node:assert/strict';
import { runCounts } from '../../extension/run-counts.js';
test('compacted run progress and announcements retain exact counts', () => {
  assert.deepEqual(
    runCounts({
      recordedSteps: 100,
      failedSteps: 4,
      steps: [{ status: 'passed' }, { status: 'dispatched' }],
    }),
    { recorded: 100, complete: 99, failed: 4 },
  );
  assert.deepEqual(runCounts({ steps: [{ status: 'failed' }, { status: 'passed' }] }), {
    recorded: 2,
    complete: 2,
    failed: 1,
  });
  assert.deepEqual(runCounts({ recordedSteps: 0, failedSteps: 0, steps: [] }), {
    recorded: 0,
    complete: 0,
    failed: 0,
  });
});
