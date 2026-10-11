// Keep the outer bridges longer than the companion's 7-minute planning RPC.
// Ordinary speech, settings and browser requests retain their shorter limits.
export const nativeTimeout = (method) => (method === 'plan.propose' ? 450000 : 120000);
export const panelTimeout = (method) => (method === 'plan.propose' ? 480000 : 150000);
