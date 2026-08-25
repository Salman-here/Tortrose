import test from 'node:test';
import assert from 'node:assert/strict';

import {
  guestCartPresentationTotal,
  normalizeServerCartPayload,
} from '../src/utils/cartPresentation.js';

test('sums only same-native-currency guest lines in exact minor units', () => {
  assert.deepEqual(guestCartPresentationTotal([
    { product: { price: 200, currency: 'PKR' }, qty: 2 },
    { product: { price: 10, discountedPrice: 6.25, currency: 'PKR' }, qty: 2 },
  ]), { totalCartPrice: 412.5, totalCartCurrency: 'PKR' });
  assert.deepEqual(guestCartPresentationTotal([]), {
    totalCartPrice: 0,
    totalCartCurrency: null,
  });
});

test('does not add unlike native currencies without an authoritative rate table', () => {
  assert.deepEqual(guestCartPresentationTotal([
    { product: { price: 200, currency: 'PKR' }, qty: 1 },
    { product: { price: 6, currency: 'USD' }, qty: 1 },
  ]), { totalCartPrice: null, totalCartCurrency: null });
});

test('rejects corrupt guest money, quantity, and currency metadata', () => {
  for (const item of [
    { product: { price: '6.00', currency: 'USD' }, qty: 1 },
    { product: { price: 0.001, currency: 'USD' }, qty: 1 },
    { product: { price: 6, currency: 'usd' }, qty: 1 },
    { product: { price: 6, currency: 'USD', priceCurrency: 'PKR' }, qty: 1 },
    { product: { price: 6, currency: 'USD' }, qty: '1' },
  ]) {
    assert.throws(
      () => guestCartPresentationTotal([item]),
      (error) => error?.code === 'CART_PRESENTATION_DATA_INVALID',
    );
  }
});

test('accepts only an exact, canonical authoritative server cart snapshot', () => {
  assert.deepEqual(normalizeServerCartPayload({
    cart: [],
    totalCartPrice: 1880,
    totalCartCurrency: 'PKR',
  }), { cart: [], totalCartPrice: 1880, totalCartCurrency: 'PKR' });
  for (const payload of [
    { cart: {}, totalCartPrice: 0, totalCartCurrency: 'USD' },
    { cart: [], totalCartPrice: '0.00', totalCartCurrency: 'USD' },
    { cart: [], totalCartPrice: 0.001, totalCartCurrency: 'USD' },
    { cart: [], totalCartPrice: 0, totalCartCurrency: 'usd' },
    { cart: [], totalCartPrice: 0 },
  ]) {
    assert.throws(
      () => normalizeServerCartPayload(payload),
      (error) => error?.code === 'CART_PRESENTATION_DATA_INVALID',
    );
  }
});

test('validates and canonicalizes every authoritative server cart line before rendering', () => {
  const line = {
    _id: 'line-a',
    qty: 2,
    product: {
      _id: 'product-a',
      seller: 'seller-a',
      stock: 5,
      price: 200,
      discountedPrice: 150,
      currency: 'PKR',
    },
  };
  const normalized = normalizeServerCartPayload({
    cart: [line],
    totalCartPrice: 300,
    totalCartCurrency: 'PKR',
  });
  assert.equal(normalized.cart[0].qty, 2);
  assert.equal(normalized.cart[0].product.currency, 'PKR');
  assert.equal(normalized.cart[0].product.priceCurrency, 'PKR');

  const corruptions = [
    { _id: '', qty: 2 },
    { qty: '2' },
    { product: { price: '200' } },
    { product: { discountedPrice: 149.999 } },
    { product: { currency: 'pkr' } },
    { product: { stock: '5' } },
    { product: { seller: null } },
    { product: { _id: null } },
  ];
  for (const corruption of corruptions) {
    const corruptLine = {
      ...line,
      ...corruption,
      product: { ...line.product, ...(corruption.product || {}) },
    };
    assert.throws(
      () => normalizeServerCartPayload({
        cart: [corruptLine],
        totalCartPrice: 300,
        totalCartCurrency: 'PKR',
      }),
      (error) => error?.code === 'CART_PRESENTATION_DATA_INVALID',
    );
  }
});
