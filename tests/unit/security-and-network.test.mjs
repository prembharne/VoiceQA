import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkRecorder, publicURL } from '../../extension/network-recorder.js';
import { auditConfiguration } from '../../extension/security-audit.js';
import { validateHTTP } from '../../shared/protocol.js';

test('network evidence removes query values, credentials and fragments', () => {
  const url = publicURL('https://user:password@app.test/api?token=real-token&id=123#secret');
  for (const secret of ['password', 'real-token', '123', 'secret'])
    assert.equal(url.includes(secret), false);
  const recorder = new NetworkRecorder();
  recorder.event(
    'Network.requestWillBeSent',
    {
      requestId: 'one',
      timestamp: 1,
      request: {
        method: 'POST',
        url: 'https://app.test/order',
        postData: 'password=real-secret',
        headers: { Authorization: 'secret' },
      },
    },
    'main',
  );
  recorder.event(
    'Network.responseReceived',
    {
      requestId: 'one',
      type: 'Fetch',
      response: { status: 403, headers: { 'Set-Cookie': 'secret-cookie' } },
    },
    'main',
  );
  recorder.event('Network.loadingFinished', { requestId: 'one', timestamp: 1.5 }, 'main');
  assert.equal(recorder.snapshot('main')[0].durationMs, 500);
  assert.equal(JSON.stringify(recorder.snapshot('main')).includes('secret'), false);
  assert.deepEqual(recorder.snapshot('other'), []);
});
test('security configuration findings are specific indicators and omit cookie values', () => {
  const findings = auditConfiguration({
    url: 'https://app.test',
    headers: {},
    cookies: [
      { name: 'session', value: 'actual-secret', secure: false, httpOnly: false, sameSite: 'None' },
    ],
  });
  assert.ok(findings.some((f) => f.id === 'cookie-http-session' && f.severity === 'high'));
  assert.ok(findings.some((f) => f.id === 'csp'));
  assert.equal(JSON.stringify(findings).includes('actual-secret'), false);
  const safe = auditConfiguration({
    url: 'http://127.0.0.1:4174',
    headers: {
      'content-security-policy': "frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
    },
    cookies: [{ name: 'session', httpOnly: true, secure: false, sameSite: 'Strict' }],
  });
  assert.deepEqual(safe, []);
});
test('HTTP checks reject raw credentials and token captures', () => {
  const valid = {
    method: 'POST',
    url: 'https://app.test/order',
    body: '{"quantity":1}',
    expectedStatus: 201,
    jsonPointer: '/total',
    expectedValue: '12',
  };
  assert.doesNotThrow(() => validateHTTP(valid));
  assert.throws(
    () => validateHTTP({ ...valid, body: '{"auth":{"password":"secret"}}' }),
    /credentials/,
  );
  assert.throws(() => validateHTTP({ ...valid, jsonPointer: '/sessionToken' }), /public JSON/);
  assert.throws(() => validateHTTP({ ...valid, idempotencyKey: 'bad\r\nheader' }), /bounded/);
});

test('named private references and typed JSON checks remain bounded and explicit', () => {
  const valid = {
    method: 'POST',
    url: 'https://app.test/api',
    body: '{"quantity":1}',
    expectedStatus: 200,
    jsonPointer: '/ok',
    expectedType: 'boolean',
    expectedValue: 'true',
    saveAs: 'ok',
    authSource: 'session:app-auth',
    authPointer: '/accessToken',
    csrfSource: 'meta:csrf-token',
    csrfHeader: 'X-CSRF-Token',
  };
  assert.doesNotThrow(() => validateHTTP(valid));
  for (const change of [
    { authSource: 'local:apiKey' },
    { authPointer: '/password' },
    { csrfSource: 'input:password' },
    { csrfBodyField: 'csrf' },
    { expectedValue: 'yes' },
    { tolerance: 1 },
    { expectedType: 'null' },
    { tolerance: NaN },
  ])
    assert.throws(() => validateHTTP({ ...valid, ...change }));
  assert.doesNotThrow(() =>
    validateHTTP({ ...valid, expectedType: 'number', expectedValue: '12', tolerance: 0.01 }),
  );
  assert.doesNotThrow(() => validateHTTP({ ...valid, expectedValue: '' }));
});

test('iframe headers cannot override top-level security evidence and navigation clears stale headers', () => {
  const r = new NetworkRecorder();
  const event = (frameId, headers) =>
    r.event(
      'Network.responseReceived',
      { requestId: frameId, frameId, type: 'Document', response: { status: 200, headers } },
      'main',
    );
  event('top', {
    'Content-Security-Policy': "frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
  });
  event('child', {});
  assert.deepEqual(
    auditConfiguration({ url: 'http://127.0.0.1:4173', headers: r.headersFor('main', 'top') }),
    [],
  );
  assert.deepEqual(r.headersFor('main', 'child'), {});
  r.event(
    'Network.requestWillBeSent',
    {
      requestId: 'new',
      frameId: 'top',
      type: 'Document',
      timestamp: 1,
      request: { method: 'GET', url: 'http://127.0.0.1:4173/next' },
    },
    'main',
  );
  assert.equal(r.headersFor('main', 'top'), undefined);
  const findings = auditConfiguration({ url: 'http://127.0.0.1:4173', headersObserved: false });
  assert.deepEqual(
    findings.map((f) => f.id),
    ['headers-unavailable'],
  );
  for (let i = 0; i < 50; i++) event('frame-' + i, {});
  assert.equal(r.documentHeaders.get('main').size, 20);
});
