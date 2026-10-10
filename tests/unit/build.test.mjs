import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
test('generated schema validator is compatible with extension CSP', async () => {
  const code = await readFile('shared/envelope-validator.js', 'utf8');
  assert.doesNotMatch(code, /\brequire\s*\(|\beval\s*\(|new Function/);
});
test('manifest scopes persistent host access to user-granted sites', async () => {
  const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.host_permissions, undefined);
  assert.ok(manifest.permissions.includes('nativeMessaging'));
  assert.ok(manifest.permissions.includes('debugger'));
  assert.equal(manifest.content_security_policy.extension_pages.includes('unsafe-eval'), false);
});
