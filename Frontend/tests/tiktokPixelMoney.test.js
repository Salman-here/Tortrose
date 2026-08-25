import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCheckoutEventPayload,
  trackAddToCart,
  trackProductView,
  trackSearch,
} from '../src/utils/tiktokPixel.js';

test('TikTok checkout payload uses selected currency and exact mixed-cart line allocations', () => {
  const payload = buildCheckoutEventPayload({
    orderId: 'ORD-MIXED',
    currency: 'pkr',
    totalAmount: 3000,
    cartItems: [
      {
        product: { _id: 'native-pkr', name: 'Native PKR item', price: 1000, currency: 'PKR' },
        qty: 2,
      },
      {
        product: { _id: 'foreign-usd', name: 'Converted USD item', price: 1, currency: 'USD' },
        qty: 3,
      },
    ],
    // These are the exact target-currency allocations displayed by checkout.
    lineTotals: [2000, 854],
  });

  assert.equal(payload.currency, 'PKR');
  assert.equal(payload.value, 3000);
  assert.equal(payload.order_id, 'ORD-MIXED');
  assert.deepEqual(payload.contents, [
    {
      content_id: 'native-pkr',
      content_type: 'product',
      content_name: 'Native PKR item',
      price: 1000,
      quantity: 2,
    },
    {
      content_id: 'foreign-usd',
      content_type: 'product',
      content_name: 'Converted USD item',
      price: 854 / 3,
      quantity: 3,
    },
  ]);
});

test('TikTok checkout payload never labels an unconverted native price as another currency', () => {
  const payload = buildCheckoutEventPayload({
    currency: 'EUR',
    totalAmount: 9,
    cartItems: [{
      product: { _id: 'native-usd', name: 'USD item', price: 10, currency: 'USD' },
      quantity: 1,
    }],
  });

  assert.equal(payload.currency, 'EUR');
  assert.equal(payload.value, 9);
  assert.equal(Object.hasOwn(payload.contents[0], 'price'), false);
});

test('TikTok checkout payload fails closed for present unsupported or corrupt currency codes', () => {
  ['JPY', 'USDX', '', '   ', null, undefined, true, 0, {}, { toString: () => 'USD' }].forEach((currency) => {
    assert.equal(buildCheckoutEventPayload({
      currency,
      totalAmount: 10,
      cartItems: [{ product: { _id: 'p1', name: 'Product' }, quantity: 1 }],
      lineTotals: [10],
    }), null);
  });
});

test('TikTok checkout payload defaults only a genuinely missing legacy currency to USD', () => {
  const payload = buildCheckoutEventPayload({
    totalAmount: 10,
    cartItems: [{ product: { _id: 'p1', name: 'Product' }, quantity: 1 }],
    lineTotals: [10],
  });

  assert.equal(payload.currency, 'USD');
  assert.equal(payload.contents[0].price, 10);
});

test('TikTok checkout payload rejects malformed totals and omits malformed line money', () => {
  for (const totalAmount of ['10.00', false, Infinity, -1, 0.001]) {
    assert.equal(buildCheckoutEventPayload({
      currency: 'USD',
      totalAmount,
      cartItems: [{ product: { _id: 'p1' }, quantity: 1 }],
      lineTotals: [10],
    }), null);
  }
  const payload = buildCheckoutEventPayload({
    currency: 'USD',
    totalAmount: 10,
    cartItems: [{ product: { _id: 'p1' }, quantity: 1 }],
    lineTotals: [0.001],
  });
  assert.equal(Object.hasOwn(payload.contents[0], 'price'), false);
});

test('single-product TikTok events label exact native money, never hardcoded USD', (t) => {
  const events = [];
  const previousWindow = globalThis.window;
  globalThis.window = { ttq: { track: (...args) => events.push(args) } };
  t.after(() => { globalThis.window = previousWindow; });

  assert.equal(trackProductView({ _id: 'pkr-1', name: 'PKR item', price: 1500, currency: 'PKR' }), true);
  assert.equal(trackAddToCart({ _id: 'eur-1', name: 'EUR item', price: 0.1, currency: 'EUR' }, 3), true);
  assert.equal(events[0][1].currency, 'PKR');
  assert.equal(events[0][1].value, 1500);
  assert.equal(events[1][1].currency, 'EUR');
  assert.equal(events[1][1].value, 0.3);

  assert.equal(trackProductView({ _id: 'bad', price: 10, currency: 'CAD' }), false);
  assert.equal(events.length, 2);
});

test('mixed-currency search emits no fabricated common-currency money', (t) => {
  const events = [];
  const previousWindow = globalThis.window;
  globalThis.window = { ttq: { track: (...args) => events.push(args) } };
  t.after(() => { globalThis.window = previousWindow; });

  assert.equal(trackSearch({
    searchString: 'mixed',
    products: [
      { _id: 'usd', price: 10, currency: 'USD' },
      { _id: 'pkr', price: 1000, currency: 'PKR' },
    ],
  }), true);
  const payload = events[0][1];
  assert.equal(Object.hasOwn(payload, 'value'), false);
  assert.equal(Object.hasOwn(payload, 'currency'), false);
  assert.equal(payload.contents.every((content) => !Object.hasOwn(content, 'price')), true);
});
