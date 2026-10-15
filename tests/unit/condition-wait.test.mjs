import test from 'node:test';
import assert from 'node:assert/strict';
import { pollCondition } from '../../shared/condition-wait.js';
import { validateAction } from '../../shared/protocol.js';

const wait = {
  operation: 'wait_for',
  target: 'role:button|Compile',
  assertion: { kind: 'enabled', expected: 'true' },
};
function clock(read, check = () => {}) {
  let time = 0;
  return {
    read: (a) => read(a, time),
    check,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
}
const measured = (passed) => ({ passed, actual: passed, expected: 'true', kind: 'enabled' });

test('readiness follows the same renamed node and outlasts the old six-second default', async () => {
  const targets = [];
  const result = await pollCondition(
    wait,
    clock((action, time) => {
      targets.push(action.target);
      return { ...measured(time >= 12500), targetHandle: 'node:42' };
    }),
  );
  assert.equal(targets[0], wait.target);
  assert.ok(targets.slice(1).every((t) => t === 'node:42'));
  assert.ok(result.waitedMs >= 12800);
  assert.equal(result.timeoutMs, 60000);
  assert.equal(result.passed, true);
});

test('stable selectors survive replacement and brief positive flashes do not pass a wait', async () => {
  const result = await pollCondition(
    { ...wait, target: '#job' },
    clock((a, time) => {
      assert.equal(a.target, '#job');
      return {
        ...measured(time === 250 || time >= 9000),
        targetHandle: time < 1000 ? 'node:1' : 'node:2',
      };
    }),
  );
  assert.ok(result.waitedMs >= 9300);
});

test('missing targets stay pending until the deadline; ordinary assertion failures stay failures', async () => {
  for (const operation of ['wait_for', 'assert']) {
    await assert.rejects(
      pollCondition(
        { ...wait, operation, timeoutMs: 1000 },
        clock(() => {
          throw Object.assign(new Error('Missing'), { code: 'target_missing' });
        }),
      ),
      (error) => {
        assert.equal(error.code, operation === 'wait_for' ? 'wait_timeout' : 'assertion_failed');
        assert.equal(error.result.actual, 'target missing');
        assert.equal(error.result.passed, false);
        assert.equal(error.result.waitedMs, 1000);
        assert.equal(error.result.polls, error.result.missingPolls);
        assert.equal(Boolean(error.result.pending), operation === 'wait_for');
        return true;
      },
    );
  }
});

test('cancellation and ambiguous/private selector errors are never retried as waits', async () => {
  let reads = 0;
  await assert.rejects(
    pollCondition(
      wait,
      clock(
        () => {
          reads++;
          return measured(false);
        },
        () => {
          if (reads) throw Object.assign(new Error('Stopped'), { code: 'cancelled' });
        },
      ),
    ),
    { code: 'cancelled' },
  );
  assert.equal(reads, 1);
  await assert.rejects(
    pollCondition(
      wait,
      clock(() => {
        throw Object.assign(new Error('Ambiguous'), { code: 'needs_review' });
      }),
    ),
    { code: 'needs_review' },
  );
});

test('only readiness permits a two-minute deadline', () => {
  assert.doesNotThrow(() => validateAction({ ...wait, timeoutMs: 120000 }));
  assert.throws(() => validateAction({ ...wait, timeoutMs: 120001 }));
  assert.throws(() => validateAction({ ...wait, operation: 'assert', timeoutMs: 120000 }));
});

test('live status changes return inconclusive evidence early; fixed waits and final assertions do not', async () => {
  const action = {
    operation: 'wait_for',
    target: '#job-status',
    timeoutMs: 120000,
    assertion: { kind: 'text', expected: 'Compilation complete' },
  };
  const read = (_a, time) => ({
    passed: false,
    expected: action.assertion.expected,
    actual: time < 2000 ? 'Compiling' : 'Compilation succeeded',
    kind: 'text',
  });
  await assert.rejects(pollCondition(action, { ...clock(read), reinspectOnChange: true }), (e) => {
    assert.equal(e.code, 'wait_changed');
    assert.equal(e.result.passed, false);
    assert.equal(e.result.pending, true);
    assert.equal(e.result.actual, 'Compilation succeeded');
    assert.ok(e.result.waitedMs >= 2500 && e.result.waitedMs < 3000);
    return true;
  });
  for (const operation of ['wait_for', 'assert']) {
    await assert.rejects(
      pollCondition({ ...action, operation, timeoutMs: 5000 }, clock(read)),
      (e) => {
        assert.equal(e.code, operation === 'assert' ? 'assertion_failed' : 'wait_timeout');
        assert.equal(e.result.waitedMs, 5000);
        return true;
      },
    );
  }
});
