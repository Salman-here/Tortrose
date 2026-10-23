'use strict';
const { buyerGreeting, buyerProductSummary, buyerOrderMessage } = require('../../services/whatsapp/buyerOrderCopy');

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
