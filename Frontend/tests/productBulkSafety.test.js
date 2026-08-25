import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectProductBulkSelection,
  parseBulkPercentageInput,
  parseSignedBulkMoneyInput,
} from '../src/utils/productBulkSafety.js';

const product = (overrides = {}) => ({
  _id: '64b000000000000000000001',
  price: 200,
  discountedPrice: 150,
  currency: 'PKR',
  priceCurrency: 'PKR',
  discountedPriceCurrency: 'PKR',
  stock: 2,
  rating: 0,
  numReviews: 0,
  ...overrides,
});

test('bulk product selection preserves exact native currency and rejects corrupt or duplicate rows', () => {
  const valid = inspectProductBulkSelection([
    product(),
    product({
      _id: '64b000000000000000000002',
      price: 6,
      discountedPrice: 0,
      currency: 'USD',
      priceCurrency: 'USD',
      discountedPriceCurrency: 'USD',
    }),
  ]);
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.currencies, ['PKR', 'USD']);
  assert.deepEqual(valid.productIds, [
    '64b000000000000000000001',
    '64b000000000000000000002',
  ]);

  for (const rows of [
    [],
    [product({ price: '200' })],
    [product({ stock: '2' })],
    [product({ currency: 'pkr', priceCurrency: 'pkr', discountedPriceCurrency: 'pkr' })],
    [product({ _id: 'not-an-object-id' })],
    [product(), product()],
    Array.from({ length: 251 }, (_, index) => product({
      _id: index.toString(16).padStart(24, '0'),
    })),
  ]) {
    assert.equal(inspectProductBulkSelection(rows).valid, false);
  }
});

test('bulk money input accepts exact signed cents and rejects coercion or sub-cent values', () => {
  assert.equal(parseSignedBulkMoneyInput('12.34'), 12.34);
  assert.equal(parseSignedBulkMoneyInput('-2.50', { allowNegative: true }), -2.5);
  assert.equal(parseSignedBulkMoneyInput('0.01'), 0.01);
  assert.equal(parseSignedBulkMoneyInput('0', { allowZero: true }), 0);
  for (const value of [null, true, '', '0', '-1', '1.001', '1e2', 'NaN']) {
    assert.equal(parseSignedBulkMoneyInput(value), null, String(value));
  }
});

test('bulk percentages use bounded plain decimals without truthy or exponent coercion', () => {
  assert.equal(parseBulkPercentageInput('12.345678', { minimum: 0.000001, maximum: 100, maximumExclusive: true }), 12.345678);
  assert.equal(parseBulkPercentageInput('-100', { minimum: -100 }), -100);
  for (const value of [null, false, '', '0', '100', '1.0000001', '1e2']) {
    assert.equal(parseBulkPercentageInput(value, {
      minimum: 0.000001,
      maximum: 100,
      maximumExclusive: true,
    }), null, String(value));
  }
});
