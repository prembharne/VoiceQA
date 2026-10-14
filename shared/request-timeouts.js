// Keep the outer bridges longer than the companion's 7-minute planning RPC.
// Ordinary speech, settings and browser requests retain their shorter limits.
export const nativeTimeout = (method, payload = {}) =>
  method === 'plan.propose' && payload.discover === true
    ? 810000
    : ['plan.propose', 'agent.query', 'automation.propose'].includes(method)
      ? 450000
      : 120000;
export const panelTimeout = (method, payload = {}) =>
  method === 'plan.propose' && payload.discover === true
    ? 840000
    : ['plan.propose', 'agent.query', 'automation.propose'].includes(method)
      ? 480000
      : 150000;
