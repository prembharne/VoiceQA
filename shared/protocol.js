export const VERSION = 1;
export const HOST_NAME = 'com.voiceqa.companion';
export const MAX_CHUNK_BYTES = 192 * 1024;
export const OPERATIONS = new Set([
  'capture_value',
  'http_check',
  'security_audit',
  'open_tab',
  'switch_tab',
  'close_tab',
  'wait_for',
  'fill_secret',
  'fill_totp',
  'human_checkpoint',
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
  'text_contains',
  'value',
  'hidden',
  'url_contains',
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
  if (['assert', 'wait_for'].includes(action.operation) && !ASSERTIONS.has(action.assertion?.kind))
    throw new Error('Unsupported assertion');
  if (
    action.operation === 'key' &&
    !['Tab', 'Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'Space'].includes(action.value)
  )
    throw new Error('Unsupported key');
  if (action.operation === 'navigate' && !/^https?:\/\//.test(action.value || ''))
    throw new Error('Only HTTP(S) navigation is allowed');
  if (
    action.timeoutMs &&
    (!Number.isInteger(action.timeoutMs) ||
      action.timeoutMs < 500 ||
      action.timeoutMs > (action.operation === 'wait_for' ? 120000 : 30000))
  )
    throw new Error('Invalid step timeout');
  if (action.operation === 'http_check') validateHTTP(action.http);
  return action;
}
export function validateHTTP(check) {
  if (check?.authSource) {
    if (
      !/^(local|session|cookie):[A-Za-z_][A-Za-z0-9_.:-]{0,99}$/.test(check.authSource) ||
      /password|otp|secret|api.?key/i.test(check.authSource)
    )
      throw new Error('Use a named browser bearer-token reference.');
    if (
      check.authPointer &&
      (!check.authPointer.startsWith('/') ||
        check.authPointer.length > 300 ||
        /password|otp|secret|api.?key/i.test(check.authPointer))
    )
      throw new Error('Invalid bearer-token JSON pointer.');
  } else if (check?.authPointer) throw new Error('Bearer-token pointer requires a browser source.');
  if (
    check?.expectedType &&
    (!['number', 'string', 'boolean', 'null'].includes(check.expectedType) || !check.jsonPointer)
  )
    throw new Error('Expected JSON type needs a checked pointer.');
  if (check?.tolerance != null && (!Number.isFinite(check.tolerance) || check.tolerance < 0))
    throw new Error('Invalid numeric tolerance.');
  if (check?.tolerance && check.expectedType !== 'number')
    throw new Error('Numeric tolerance requires expected JSON type number.');
  if (
    check?.expectedType === 'number' &&
    (check.expectedValue !== '' || !check.saveAs) &&
    (!check.expectedValue?.trim() || !Number.isFinite(Number(check.expectedValue)))
  )
    throw new Error('Expected JSON number must be finite.');
  if (
    check?.expectedType === 'boolean' &&
    !['true', 'false'].includes(check.expectedValue) &&
    (check.expectedValue !== '' || !check.saveAs)
  )
    throw new Error('Expected JSON boolean must be true or false.');
  if (
    check?.expectedType === 'null' &&
    check.expectedValue !== 'null' &&
    (check.expectedValue !== '' || !check.saveAs)
  )
    throw new Error('Expected JSON null must be null.');
  if (check?.csrfSource) {
    if (
      !/^(meta|input|cookie):[A-Za-z_][A-Za-z0-9_.-]{0,99}$/.test(check.csrfSource) ||
      !/csrf|xsrf|^__RequestVerificationToken$/i.test(check.csrfSource.split(':')[1])
    )
      throw new Error('Use a named anti-CSRF source reference.');
    if (
      check.csrfHeader &&
      ![
        'X-CSRF-Token',
        'X-CSRFToken',
        'X-XSRF-TOKEN',
        'RequestVerificationToken',
        'CSRF-Token',
      ].includes(check.csrfHeader)
    )
      throw new Error('Unsupported anti-CSRF header.');
    if (
      check.csrfBodyField &&
      (!/csrf|xsrf|^__RequestVerificationToken$/i.test(check.csrfBodyField) ||
        check.csrfBodyField.length > 100 ||
        check.csrfHeader)
    )
      throw new Error('Choose a named anti-CSRF body field or header.');
  } else if (check?.csrfHeader || check?.csrfBodyField)
    throw new Error('Anti-CSRF transport requires a source reference.');
  if (!check || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(check.method))
    throw new Error('HTTP check requires a supported method.');
  if (
    !/^https?:\/\//.test(check.url || '') ||
    check.url.length > 2000 ||
    (check.body || '').length > 8000
  )
    throw new Error('HTTP check input exceeds its scope or size limits.');
  if (
    !Number.isInteger(check.expectedStatus) ||
    check.expectedStatus < 100 ||
    check.expectedStatus > 599
  )
    throw new Error('HTTP check requires an expected response status.');
  if (check.body) {
    const body = JSON.parse(check.body);
    const privateData = (value) =>
      value &&
      typeof value === 'object' &&
      Object.entries(value).some(
        ([key, child]) =>
          /password|secret|token|cookie|authorization|otp|api.?key|csrf|xsrf/i.test(key) ||
          privateData(child),
      );
    if (privateData(body))
      throw new Error('HTTP bodies cannot contain credentials or session-token fields.');
    if (['GET', 'HEAD'].includes(check.method)) throw new Error('Read checks cannot send a body.');
  }
  if (
    check.jsonPointer &&
    (!check.jsonPointer.startsWith('/') ||
      /password|secret|token|cookie|authorization|otp|api.?key|csrf|xsrf|bearer/i.test(
        check.jsonPointer,
      ))
  )
    throw new Error('Only public JSON fields can be checked or captured.');
  if (
    (check.jsonPointer || '').length > 300 ||
    (check.expectedValue || '').length > 1000 ||
    (check.idempotencyKey || '').length > 100 ||
    /[\r\n]/.test(check.idempotencyKey || '')
  )
    throw new Error('HTTP check exceeds bounded field limits.');
  if (
    check.saveAs &&
    (!/^[a-z][a-z0-9_-]{0,31}$/.test(check.saveAs) ||
      /password|secret|token|cookie|authorization|otp|api.?key|csrf|xsrf|bearer/i.test(
        check.saveAs,
      ) ||
      !check.jsonPointer)
  )
    throw new Error('HTTP capture requires a public variable and JSON pointer.');
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
