export function runCounts(run) {
  const steps = run.steps || [];
  const recorded = run.recordedSteps ?? steps.length;
  return {
    recorded,
    complete: Math.max(0, recorded - steps.filter((s) => s.status === 'dispatched').length),
    failed: run.failedSteps ?? steps.filter((s) => s.status === 'failed').length,
  };
}
