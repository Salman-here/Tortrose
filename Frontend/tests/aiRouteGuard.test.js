import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAIRoute } from '../src/utils/aiRouteGuard.js';

globalThis.window = { location: { origin: 'https://rozare.com' } };

test('normalizes common AI seller route aliases to real dashboard pages', () => {
  assert.equal(
    normalizeAIRoute('/seller-dashboard/products'),
    '/seller-dashboard/product-management',
  );
  assert.equal(
    normalizeAIRoute('/seller-dashboard/orders'),
    '/seller-dashboard/order-management',
  );
  assert.equal(
    normalizeAIRoute('/seller-dashboard/shipping'),
    '/seller-dashboard/shipping-configuration',
  );
});

test('allows known dashboard and dynamic detail routes', () => {
  assert.equal(normalizeAIRoute('/seller-dashboard/coupons'), '/seller-dashboard/coupons');
  assert.equal(
    normalizeAIRoute('/seller-dashboard/order/6a9a4ef5650544c39046cba3'),
    '/seller-dashboard/order/6a9a4ef5650544c39046cba3',
  );
  assert.equal(normalizeAIRoute('/user-dashboard/orders'), '/user-dashboard/orders');
});

test('rejects nonexistent dashboard children instead of opening a blank page', () => {
  assert.equal(normalizeAIRoute('/seller-dashboard/not-a-page'), '/');
  assert.equal(normalizeAIRoute('/admin-dashboard/not-a-page'), '/');
  assert.equal(normalizeAIRoute('/user-dashboard/not-a-page'), '/');
});
