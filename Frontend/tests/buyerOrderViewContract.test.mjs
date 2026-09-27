import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('personal order details explicitly request buyer scope while management keeps its existing scope', () => {
  const buyer = readFileSync(new URL('../src/components/layout/UserOrderDetail.jsx', import.meta.url), 'utf8');
  const management = readFileSync(new URL('../src/components/layout/OrderDetail.jsx', import.meta.url), 'utf8');
  assert.ok(buyer.includes('api/order/detail/${id}?view=buyer'));
  assert.ok(management.includes('api/order/detail/${id}`'));
  assert.ok(!management.includes('api/order/detail/${id}?view=buyer'));
});
