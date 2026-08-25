import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectProductFormSubmission,
  inspectSellerProductCurrencyState,
  normalizeProductForEdit,
  resolveProductFormCurrency,
} from '../src/utils/productFormCurrency.js';

test('product form money accepts intentional free products and rejects coercion or fake discounts', () => {
  const base = {
    price: '0',
    discountedPrice: '',
    stock: '0',
    currency: 'PKR',
    priceCurrency: 'PKR',
    discountedPriceCurrency: 'PKR',
  };
  assert.deepEqual(inspectProductFormSubmission(base, 'USD'), {
    valid: true,
    currency: 'PKR',
    price: 0,
    discountedPrice: 0,
    stock: 0,
  });
  for (const overrides of [
    { price: '' },
    { price: '1.001' },
    { price: '1e2' },
    { price: true },
    { discountedPrice: '0.01' },
    { stock: '1.5' },
    { stock: true },
    { discountedPriceCurrency: 'USD' },
  ]) {
    assert.equal(inspectProductFormSubmission({ ...base, ...overrides }, 'USD').valid, false);
  }
});

const makeState = (overrides = {}) => ({
  hasStore: true,
  activeCurrency: 'PKR',
  status: 'active',
  pendingCurrency: null,
  previousCurrency: null,
  productCount: 2,
  productCurrencies: ['PKR'],
  productCurrencyCounts: { PKR: 2 },
  canAddProduct: true,
  ...overrides,
});

test('a persisted currency-less legacy product edits in canonical USD, not the account currency', () => {
  const legacyProduct = { _id: 'legacy-1', price: 10, discountedPrice: 8 };

  assert.equal(resolveProductFormCurrency(legacyProduct, 'PKR'), 'USD');
  assert.deepEqual(normalizeProductForEdit(legacyProduct), {
    ...legacyProduct,
    currency: 'USD',
    priceCurrency: 'USD',
    discountedPriceCurrency: 'USD',
  });
});

test('new products may inherit the selected account currency', () => {
  assert.equal(resolveProductFormCurrency({ price: '' }, 'PKR'), 'PKR');
});

test('explicit native product currency remains authoritative while editing', () => {
  const product = { _id: 'pkr-1', price: 1500, currency: 'PKR', priceCurrency: 'PKR' };
  assert.equal(resolveProductFormCurrency(product, 'USD'), 'PKR');
  assert.equal(normalizeProductForEdit(product).discountedPriceCurrency, 'PKR');
});

test('present null, blank, unsupported, non-string, or conflicting edit currency fails closed', () => {
  for (const product of [
    { _id: 'null', currency: null },
    { _id: 'blank', currency: '' },
    { _id: 'unsupported', currency: 'CAD' },
    { _id: 'boolean', currency: false },
    { _id: 'conflict', currency: 'USD', priceCurrency: 'PKR' },
  ]) {
    assert.throws(
      () => resolveProductFormCurrency(product, 'USD'),
      error => error?.code === 'PRODUCT_CURRENCY_METADATA_INVALID',
    );
  }
});

test('an active discount with conflicting currency fails closed', () => {
  assert.throws(
    () => normalizeProductForEdit({
      _id: 'discount-conflict',
      price: 10,
      discountedPrice: 8,
      currency: 'USD',
      priceCurrency: 'USD',
      discountedPriceCurrency: 'PKR',
    }),
    error => error?.code === 'PRODUCT_CURRENCY_METADATA_INVALID',
  );
});

test('seller product currency state requires exact counts, canonical currencies, and coherent transitions', () => {
  assert.equal(inspectSellerProductCurrencyState(makeState()).valid, true);
  assert.equal(inspectSellerProductCurrencyState(makeState({
    status: 'pending_conversion',
    pendingCurrency: 'USD',
    previousCurrency: 'PKR',
    canAddProduct: false,
  })).valid, true);
  for (const invalid of [
    makeState({ activeCurrency: 'pkr' }),
    makeState({ productCount: '2' }),
    makeState({ productCurrencyCounts: { PKR: 1 } }),
    makeState({ canAddProduct: false }),
    makeState({ productCurrencies: ['USD'], productCurrencyCounts: { USD: 2 } }),
    makeState({ status: 'pending_conversion', pendingCurrency: 'USD', previousCurrency: null, canAddProduct: false }),
    makeState({ status: 'pending_conversion', pendingCurrency: 'USD', previousCurrency: 'PKR', canAddProduct: true }),
    makeState({ status: 'pending_conversion', activeCurrency: 'GBP', pendingCurrency: 'USD', previousCurrency: 'PKR', canAddProduct: false }),
    makeState({ hasStore: false, canAddProduct: false }),
  ]) {
    assert.equal(inspectSellerProductCurrencyState(invalid).valid, false);
  }
});
