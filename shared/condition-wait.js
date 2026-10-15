// Poll only reads. A readiness timeout is inconclusive, never a business verdict
// and never permission to repeat the mutation which started the operation.
export async function pollCondition(
  action,
  { read, check, sleep, now = () => performance.now(), reinspectOnChange = false },
) {
  const readiness = action.operation === 'wait_for';
  const timeoutMs = action.timeoutMs || (readiness ? 60000 : 6000);
  const started = now();
  let stableAt = null;
  let target = action.target;
  let polls = 0;
  let missingPolls = 0;
  let last = {};
  let initialText;
  let changedText;
  let changedAt = null;
  while (true) {
    check();
    let missing = false;
    try {
      last = await read({ ...action, target });
      check();
      // Same DOM node, even if its accessible name changes while busy. Handles
      // are minted by the content script, scoped to its document and never fuzzy.
      if (readiness && /^(role:|label:|text:)/.test(action.target) && last.targetHandle)
        target = last.targetHandle;
    } catch (error) {
      if (error.code !== 'target_missing') throw error;
      missing = true;
      target = action.target;
      missingPolls++;
      last = {
        passed: false,
        expected: action.assertion.expected,
        actual: 'target missing',
        kind: action.assertion.kind,
      };
    }
    polls++;
    const elapsed = now() - started;
    if (last.passed) stableAt ??= now();
    else stableAt = null;
    const evidence = {
      ...last,
      waitedMs: Math.round(elapsed),
      timeoutMs,
      polls,
      missingPolls,
      checkedTarget: target,
    };
    // A transient success banner/empty state must not end an asynchronous wait.
    if (last.passed && (!readiness || now() - stableAt >= 300)) return evidence;
    if (
      readiness &&
      reinspectOnChange &&
      !missing &&
      ['text', 'text_contains'].includes(action.assertion.kind) &&
      typeof last.actual === 'string'
    ) {
      initialText ??= last.actual;
      if (last.actual !== initialText) {
        if (changedText !== last.actual) {
          changedText = last.actual;
          changedAt = now();
        }
        if (!last.passed && now() - changedAt >= 500) {
          const error = new Error(
            'The observed status changed without satisfying the readiness condition. Inspect the new state before continuing; no success was inferred and no mutation was repeated.',
          );
          error.code = 'wait_changed';
          error.result = { ...evidence, passed: false, pending: true };
          throw error;
        }
      } else {
        changedText = undefined;
        changedAt = null;
      }
    }
    if (elapsed >= timeoutMs) {
      const error = new Error(
        readiness
          ? `Readiness condition was not stable within ${timeoutMs / 1000}s. Expected ${JSON.stringify(last.expected)}; observed ${JSON.stringify(last.actual)}. The target may have changed or the operation may still be running; inspect fresh evidence before continuing.`
          : `Expected ${JSON.stringify(last.expected)}; observed ${JSON.stringify(last.actual)}`,
      );
      error.code = readiness ? 'wait_timeout' : 'assertion_failed';
      error.result = { ...evidence, passed: false, ...(readiness ? { pending: true } : {}) };
      throw error;
    }
    await sleep(Math.min(250, timeoutMs - elapsed));
  }
}
