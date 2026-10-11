import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedDemoAPI } from '../../scripts/live-demo-scope.mjs';
test('live replay normalizes API URLs and rejects scope escapes', () => {
  const origin = 'http://127.0.0.1:4176';
  assert.equal(
    allowedDemoAPI(origin + '/workspace/api/orders/${order_id}', origin, 'workspace'),
    true,
  );
  for (const raw of [
    origin + '/workspace/api/../fixture/reset',
    origin + '/workspace/api/%2e%2e/fixture/reset',
    'http://user:secret@127.0.0.1:4176/workspace/api/orders',
    'http://127.0.0.1:4175/workspace/api/orders',
    'invalid',
  ])
    assert.equal(allowedDemoAPI(raw, origin, 'workspace'), false);
});
