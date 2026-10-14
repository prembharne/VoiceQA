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

test('owned security app route scope accepts public captures and rejects other API surfaces', () => {
  const origin='http://127.0.0.1:4180';
  for (const path of ['/api/me','/api/orders','/api/orders/OA1001/approve','/api/orders/${order-id}','/api/orders/PCaabbccdd'])
    assert.equal(allowedDemoAPI(origin+path,origin,'parcel'),true);
  for (const path of ['/api/sign-in','/api/testing-state','/api/orders/../sign-in','/api/orders/OA1001?token=private','/api/orders/%2Foutside'])
    assert.equal(allowedDemoAPI(origin+path,origin,'parcel'),false);
  assert.equal(allowedDemoAPI('http://127.0.0.1:4173/api/orders',origin,'parcel'),false);
});
