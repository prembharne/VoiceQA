export const VERSION = 1;
export const HOST_NAME = 'com.voiceqa.companion';
export const MAX_CHUNK_BYTES = 192 * 1024;
export const OPERATIONS = new Set([
  'navigate',
  'click',
  'fill',
  'select',
  'scroll',
  'key',
  'observe',
  'assert',
  'capture',
  'viewport',
  'accessibility',
]);
export const ASSERTIONS = new Set([
  'text',
  'visible',
  'count',
  'enabled',
  'selected',
  'number',
  'url',
  'focus',
  'no_overflow',
]);
export function id() {
  return crypto.randomUUID();
}
export function envelope(type, payload = {}, extra = {}) {
  return { version: VERSION, id: id(), type, payload, ...extra };
}
export function validateAction(action) {
  if (!action || !OPERATIONS.has(action.operation)) throw new Error('Unsupported action');
  if (action.target && (typeof action.target !== 'string' || action.target.length > 500))
    throw new Error('Invalid target');
  if (action.value && (typeof action.value !== 'string' || action.value.length > 4000))
    throw new Error('Invalid action value');
  if (action.operation === 'assert' && !ASSERTIONS.has(action.assertion?.kind))
    throw new Error('Unsupported assertion');
  if (
    action.operation === 'key' &&
    !['Tab', 'Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'Space'].includes(action.value)
  )
    throw new Error('Unsupported key');
  if (action.operation === 'navigate' && !/^https?:\/\//.test(action.value || ''))
    throw new Error('Only HTTP(S) navigation is allowed');
  return action;
}
export function isAllowedURL(url, origin) {
  try {
    const u = new URL(url);
    return (
      ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && u.origin === origin
    );
  } catch {
    return false;
  }
}
