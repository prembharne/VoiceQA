export function auditConfiguration({
  url,
  headers = {},
  cookies = [],
  forms = [],
  headersObserved = true,
}) {
  const findings = [];
  const parsed = new URL(url);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  const add = (id, title, severity, evidence, recommendation) =>
    findings.push({ id, title, severity, evidence, recommendation });
  if (parsed.protocol !== 'https:' && !loopback)
    add(
      'transport',
      'Unencrypted page transport',
      'high',
      'The approved page is served over HTTP.',
      'Use HTTPS before entering real account data.',
    );
  if (!headersObserved)
    add(
      'headers-unavailable',
      'Main-document response headers unavailable',
      'medium',
      'No response headers were recorded for the current top-level frame.',
      'Reload the approved page while the debugger is attached, then repeat the audit.',
    );
  else {
    if (!headers['content-security-policy'])
      add(
        'csp',
        'No observed Content Security Policy',
        'medium',
        'The main document response did not contain a CSP header.',
        'Review an application-specific CSP; absence is a configuration indicator, not proof of an exploit.',
      );
    if (
      !headers['x-frame-options'] &&
      !/frame-ancestors/i.test(headers['content-security-policy'] || '')
    )
      add(
        'framing',
        'No observed framing restriction',
        'medium',
        'Neither X-Frame-Options nor CSP frame-ancestors was observed.',
        'Evaluate clickjacking exposure and use a suitable frame-ancestors policy.',
      );
    if (headers['x-content-type-options']?.toLowerCase() !== 'nosniff')
      add(
        'nosniff',
        'Missing nosniff response policy',
        'low',
        'X-Content-Type-Options: nosniff was not observed.',
        'Set nosniff on responses with appropriate Content-Type values.',
      );
    if (parsed.protocol === 'https:' && !headers['strict-transport-security'])
      add(
        'hsts',
        'No observed HSTS policy',
        'low',
        'The HTTPS document did not provide HSTS.',
        'Evaluate HSTS after confirming all required hosts support HTTPS.',
      );
  }
  for (const cookie of cookies
    .filter((c) => /session|auth|token|^sid$/i.test(c.name))
    .slice(0, 20)) {
    const label = cookie.name.slice(0, 100);
    if (!cookie.httpOnly)
      add(
        `cookie-http-${label}`,
        'Session-like cookie is script-readable',
        'high',
        `Cookie ${label} lacks HttpOnly. Its value was not collected.`,
        'Verify whether this is a session credential; if so, use HttpOnly.',
      );
    if (!loopback && !cookie.secure)
      add(
        `cookie-secure-${label}`,
        'Session-like cookie lacks Secure',
        'high',
        `Cookie ${label} lacks Secure.`,
        'Use Secure for session credentials on HTTPS.',
      );
    if (!cookie.sameSite || cookie.sameSite === 'None')
      add(
        `cookie-samesite-${label}`,
        'Cross-site session-cookie behavior needs review',
        'medium',
        `Cookie ${label} has ${cookie.sameSite || 'unspecified'} SameSite.`,
        'Verify application CSRF defenses and the intended cross-site authentication flow.',
      );
  }
  for (const form of forms.slice(0, 10))
    if (new URL(form.action, url).protocol === 'http:' && parsed.protocol === 'https:')
      add(
        'form-downgrade',
        'Form submits over unencrypted transport',
        'high',
        'An HTTPS page has an HTTP form action.',
        'Submit account data only over HTTPS.',
      );
  return findings;
}
