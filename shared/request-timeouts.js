// Keep the outer bridges longer than the companion's 5-minute planning RPC.
// Ordinary speech, settings and browser requests retain their shorter limits.
export const nativeTimeout = (method) => (method === 'plan.propose' ? 330000 : 120000);
export const panelTimeout = (method) => (method === 'plan.propose' ? 360000 : 150000);
