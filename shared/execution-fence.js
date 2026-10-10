// A monotonic generation prevents old async work from reviving after cancellation or reconnect.
export class ExecutionFence {
  generation = 0;
  invalidate() {
    this.generation++;
  }
  token(runId, tabId) {
    return { generation: this.generation, runId, tabId };
  }
  check(token, state) {
    if (!token) return;
    if (
      token.generation !== this.generation ||
      state.cancelled ||
      (token.runId && token.runId !== state.runId) ||
      token.tabId !== state.target?.tabId
    ) {
      const error = new Error('This browser operation was cancelled or superseded');
      error.code = 'cancelled';
      throw error;
    }
  }
}
