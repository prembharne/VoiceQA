// Investigation calls are bounded reads. Model arguments never become code.
export function approvedReadLink(raw, links, origins) {
  const u = new URL(raw);
  if (
    !['http:', 'https:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !origins.includes(u.origin)
  )
    throw new Error('Linked preview requires a parameter-free URL on an approved origin.');
  let path;
  try {
    path = decodeURIComponent(decodeURIComponent(u.pathname));
  } catch {
    throw new Error('Malformed link path.');
  }
  if (/\/(?:logout|signout|delete|remove|reset|submit|confirm)(?:\/|$)/i.test(path))
    throw new Error(
      'This link may perform an account or application action; use a reviewed test workflow.',
    );
  if (!links.includes(u.href))
    throw new Error('Link was not observed on a shared or previously previewed page.');
  return u.href;
}

export function rememberPublicLinks(observation, seen) {
  for (const control of observation?.controls || []) {
    if (control.href && !control.parameterizedLink) seen.add(control.href);
  }
}

export function runtimeDiagnostic(method, payload, page, publicURL) {
  if (method === 'Runtime.exceptionThrown') {
    const e = payload.exceptionDetails || {};
    return {
      type: 'exception',
      page,
      exception: [
        'Error',
        'TypeError',
        'ReferenceError',
        'SyntaxError',
        'RangeError',
        'URIError',
        'EvalError',
        'AggregateError',
      ].includes(e.exception?.className)
        ? e.exception.className
        : 'JavaScript exception',
      url: publicURL(e.url || e.stackTrace?.callFrames?.[0]?.url || ''),
      line: e.lineNumber,
      column: e.columnNumber,
    };
  }
  if (method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(payload.type)) {
    const frame = payload.stackTrace?.callFrames?.[0];
    // Arguments may contain passwords, tokens or application records. Never store them.
    return {
      type: payload.type,
      page,
      url: publicURL(frame?.url || ''),
      line: frame?.lineNumber,
      column: frame?.columnNumber,
    };
  }
  if (method === 'Network.loadingFailed')
    return {
      type: 'network',
      page,
      message: /^net::ERR_[A-Z_]+$/.test(payload.errorText || '')
        ? payload.errorText
        : 'Request failed',
    };
  return null;
}
