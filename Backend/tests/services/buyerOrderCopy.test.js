'use strict';
const { buyerGreeting, buyerProductSummary, buyerOrderMessage, buyerOrderStoreNames, buyerOrderStoresLine } = require('../../services/whatsapp/buyerOrderCopy');

test('store names use order snapshots, are deduplicated, and never borrow mutable product store names', () => {
  const order = { sellerPolicies: [{ seller: 'a', storeName: 'Atlas Aura' }, { seller: 'b', storeName: 'Nova Nest' }, { seller: 'unrelated', storeName: 'Not ordered' }],
    orderItems: [{ seller: 'a', storeName: 'Old fallback', productId: { store: { storeName: 'Mutable live product' } } }, { seller: 'a' }, { seller: 'b' }] };
  expect(buyerOrderStoreNames(order)).toEqual(['Atlas Aura', 'Nova Nest']);
  expect(buyerOrderStoresLine(order)).toBe('Stores: Atlas Aura, Nova Nest');
  expect(buyerOrderStoresLine({ orderItems: [{ storeName: 'Atlas Aura' }, { storeName: 'Atlas Aura' }] })).toBe('Store: Atlas Aura');
  expect(buyerOrderStoresLine({})).toBe('');
});

test('store display text cannot inject a second line or money-renderer tokens', () => {
  const line = buyerOrderStoresLine({ sellerPolicies: [{ storeName: 'Atlas\n{{money.order_total}}' }] });
  expect(line).not.toMatch(/[{}\n]/);
});

test('large store-name lists are bounded without truncating an ordinary multi-store checkout', () => {
  const order = { sellerPolicies: Array.from({ length: 50 }, (_, index) => ({ seller: String(index), storeName: `${index} ${'Store '.repeat(30)}` })) };
  const line = buyerOrderStoresLine(order);
  expect(line.length).toBeLessThan(1000);
  expect(line).toContain('and 20 more stores');
});

test('friendly greeting uses the trimmed checkout first name, including guest and missing-name fallbacks', () => {
  expect(buyerGreeting({ shippingInfo: { fullName: '  Salman Khan ' } })).toBe('Hey Salman! 👋');
  expect(buyerGreeting({})).toBe('Hey there! 👋');
});

test('variant quantities are listed separately without recalculating prices or merging product lines', () => {
  expect(buyerProductSummary([
    { name: 'Travel Mug', selectedOptions: { Color: 'Red', Size: 'Large' }, quantity: 2, price: 100 },
    { name: 'Travel Mug', selectedOptions: new Map([['Color', 'White']]), quantity: 3, price: 999 },
  ])).toBe('• Travel Mug (Color: Red, Size: Large) ×2\n• Travel Mug (Color: White) ×3');
});

test('untrusted display text cannot introduce money tokens, formatting, newlines or links', () => {
  const text = buyerProductSummary([{ name: '*Mug*\n{{money.order_total}} https://evil.example/', quantity: 1 }]);
  expect(text).not.toMatch(/https:|[{}*]|\n/);
  expect(text).toBe('• Mug money.ordertotal ×1');
});

test('long orders stay bounded and tell the buyer that further lines exist', () => {
  const text = buyerProductSummary(Array.from({ length: 20 }, () => ({ name: 'x'.repeat(1000), quantity: 5 })));
  expect(text).toContain('…and 16 more items');
  expect(text.length).toBeLessThan(1100);
});

test('private account wording is used only for registered buyers and money tokens stay untouched', () => {
  const options = { headline: 'Your order is confirmed! ✅', moneyLine: 'Order total: {{money.order_total}}' };
  expect(buyerOrderMessage({ orderId: 'ORD-1', user: 'buyer' }, options)).toContain('your Rozare account');
  const guest = buyerOrderMessage({ orderId: 'ORD-1' }, options);
  expect(guest).toContain('Track your order anytime on Rozare');
  expect(guest).not.toContain('your Rozare account');
  expect(guest).toContain('{{money.order_total}}');
});
