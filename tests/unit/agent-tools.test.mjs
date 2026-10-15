import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvedReadLink,
  rememberPublicLinks,
  runtimeDiagnostic,
  validateLiveRead,
} from '../../extension/agent-tools.js';

test('live inspection reads cannot expand pages, become mutations or carry other arguments', () => {
  for (const tool of ['diagnostics', 'accessibility'])
    assert.doesNotThrow(() => validateLiveRead({ tool, page: 'main' }, 'main', true));
  assert.doesNotThrow(() =>
    validateLiveRead({ tool: 'inspect_element', page: 'main', target: 'node:3' }, 'main', true),
  );
  assert.doesNotThrow(() =>
    validateLiveRead({ tool: 'search_page', page: 'main', query: 'Create release' }, 'main', true),
  );
  for (const p of [
    { tool: 'click', page: 'main', target: '#submit' },
    { tool: 'inspect_element', page: 'other', target: '#input' },
    { tool: 'inspect_element', page: 'main', target: '#input', url: 'https://outside.test/' },
    { tool: 'inspect_element', page: 'main', target: '#input', query: 'extra' },
    { tool: 'inspect_element', page: 'main', target: ' ' },
    { tool: 'search_page', page: 'main', query: 'x'.repeat(201) },
    { tool: 'diagnostics', page: 'main', target: '#field' },
  ])
    assert.throws(() => validateLiveRead(p, 'main', true));
  assert.throws(() => validateLiveRead({ tool: 'diagnostics', page: 'main' }, 'main', false));
});

test('linked discovery accepts observed pages and rejects scope, token and action routes', () => {
  const origin = 'https://app.test';
  const links = [origin + '/help', origin + '/checkout', origin + '/%64elete'];
  assert.equal(approvedReadLink(links[0], links, [origin]), links[0]);
  assert.equal(approvedReadLink(links[1], links, [origin]), links[1]);
  for (const raw of [
    'https://outside.test/help',
    origin + '/unknown',
    origin + '/help?token=private',
    origin + '/%64elete',
  ])
    assert.throws(() => approvedReadLink(raw, links, [origin]));
});
test('parameterized links are not silently changed into navigation destinations', () => {
  const seen = new Set();
  rememberPublicLinks(
    {
      controls: [
        { href: 'https://app.test/help', parameterizedLink: true },
        { href: 'https://app.test/docs', parameterizedLink: false },
      ],
    },
    seen,
  );
  assert.deepEqual([...seen], ['https://app.test/docs']);
});
test('runtime evidence excludes raw console arguments and arbitrary exception data', () => {
  const result = runtimeDiagnostic(
    'Runtime.consoleAPICalled',
    {
      type: 'error',
      args: [{ value: 'password-secret' }],
      stackTrace: { callFrames: [{ url: 'https://app.test/app.js', lineNumber: 4 }] },
    },
    'main',
    (url) => url,
  );
  assert.equal(result.line, 4);
  assert.ok(!JSON.stringify(result).includes('password-secret'));
  const exception = runtimeDiagnostic(
    'Runtime.exceptionThrown',
    {
      exceptionDetails: {
        exception: { className: 'PrivatePasswordError', description: 'secret-value' },
      },
    },
    'main',
    (url) => url,
  );
  assert.equal(exception.exception, 'JavaScript exception');
  assert.ok(!JSON.stringify(exception).includes('secret-value'));
});
