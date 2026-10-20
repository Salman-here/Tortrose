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
test('seller order details show buyer delivery instructions as wrapping plain text', () => {
  const source = readFileSync(new URL('../src/components/layout/OrderDetail.jsx', import.meta.url), 'utf8');
  assert.ok(source.includes("typeof order?.instructions === 'string' && order.instructions.trim()"));
  assert.ok(source.includes('Delivery instructions'));
  assert.ok(source.includes('whitespace-pre-wrap break-words [overflow-wrap:anywhere]'));
  assert.ok(source.includes('{order.instructions.trim()}'));
  assert.ok(!source.includes('dangerouslySetInnerHTML'));
});
