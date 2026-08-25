import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decrementGuestCartLine,
  guestCartPayload,
  incrementGuestCartLine,
  normalizeGuestCart,
  parseStoredGuestCart,
  serializeGuestCart,
} from '../src/utils/guestCart.js';

const product = {
  _id: 'product-a',
  seller: 'seller-a',
  name: 'Mixed-currency item',
  price: 200,
  discountedPrice: 150,
  currency: 'PKR',
  stock: 5,
};

test('normalizes guest variants deterministically and preserves exact native money', () => {
  const cart = normalizeGuestCart([
    { product, qty: 1, selectedColor: 'Black', selectedOptions: { Size: 'Large', Material: 'Cotton' } },
    { product, qty: 2, selectedColor: 'Black', selectedOptions: { Material: 'Cotton', Size: 'Large' } },
    { product, qty: 1, selectedColor: 'White' },
  ]);
  assert.equal(cart.length, 2);
  assert.equal(cart.find((line) => line.selectedColor === 'Black').qty, 3);
  assert.equal(cart[0].product.currency, 'PKR');
  assert.equal(cart[0].product.priceCurrency, 'PKR');
  assert.deepEqual(parseStoredGuestCart(serializeGuestCart(cart)), cart);
  assert.deepEqual(guestCartPayload([cart[0]])[0], {
    productId: 'product-a',
    qty: 3,
    selectedColor: 'Black',
    selectedOptions: { Material: 'Cotton', Size: 'Large' },
  });
});

test('guest persistence fails closed for corrupt JSON, shape, quantity, stock, and money', () => {
  assert.throws(() => parseStoredGuestCart('{broken'), (error) => error?.code === 'CART_PRESENTATION_DATA_INVALID');
  assert.throws(() => parseStoredGuestCart('{}'), (error) => error?.code === 'CART_PRESENTATION_DATA_INVALID');
  for (const line of [
    { product, qty: '2' },
    { product, qty: 0 },
    { product: { ...product, stock: '5' }, qty: 1 },
    { product: { ...product, price: '200' }, qty: 1 },
    { product: { ...product, discountedPrice: 150.001 }, qty: 1 },
    { product: { ...product, currency: 'pkr' }, qty: 1 },
    { product: { ...product, _id: '' }, qty: 1 },
  ]) {
    assert.throws(() => normalizeGuestCart([line]), (error) => error?.code === 'CART_PRESENTATION_DATA_INVALID');
  }
});

test('guest quantity mutations use validated integers and never coerce stored values', () => {
  const [line] = normalizeGuestCart([{ product: { ...product, stock: 2 }, qty: 1 }]);
  const incremented = incrementGuestCartLine([line], line._id);
  assert.equal(incremented.cart[0].qty, 2);
  assert.equal(incremented.reachedStockLimit, false);
  assert.equal(incrementGuestCartLine(incremented.cart, line._id).reachedStockLimit, true);
  assert.equal(decrementGuestCartLine(incremented.cart, line._id)[0].qty, 1);
  assert.deepEqual(decrementGuestCartLine([line], line._id), []);
});

test('duplicate guest lines with conflicting native money fail closed', () => {
  assert.throws(() => normalizeGuestCart([
    { product, qty: 1, selectedColor: 'Black' },
    { product: { ...product, price: 201 }, qty: 1, selectedColor: 'Black' },
  ]), (error) => error?.code === 'CART_PRESENTATION_DATA_INVALID');
});
