import {
  canonicalProductCurrency,
  inspectSellerProductCurrencyState,
} from '../../src/utils/productCurrencyState';

const state = overrides => ({
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

describe('seller product currency state', () => {
  test('accepts only canonical supported product currencies', () => {
    expect(canonicalProductCurrency('PKR')).toBe('PKR');
    ['pkr', ' PKR ', 'JPY', '', true, null].forEach(value => {
      expect(canonicalProductCurrency(value)).toBeNull();
    });
  });

  test('requires exact counts and coherent active or pending transitions', () => {
    expect(inspectSellerProductCurrencyState(state()).valid).toBe(true);
    expect(inspectSellerProductCurrencyState(state({
      status: 'pending_conversion',
      pendingCurrency: 'USD',
      previousCurrency: 'PKR',
      canAddProduct: false,
    })).valid).toBe(true);

    [
      state({ activeCurrency: 'pkr' }),
      state({ productCount: '2' }),
      state({ productCurrencyCounts: { PKR: 1 } }),
      state({ productCurrencies: ['USD'], productCurrencyCounts: { USD: 2 } }),
      state({ canAddProduct: false }),
      state({ status: 'pending_conversion', pendingCurrency: 'USD', previousCurrency: null, canAddProduct: false }),
      state({ status: 'pending_conversion', activeCurrency: 'GBP', pendingCurrency: 'USD', previousCurrency: 'PKR', canAddProduct: false }),
      state({ hasStore: false, canAddProduct: false }),
      {},
    ].forEach(value => expect(inspectSellerProductCurrencyState(value).valid).toBe(false));
  });

  test('accepts the explicit no-store state without inventing a writable store', () => {
    expect(inspectSellerProductCurrencyState({
      hasStore: false,
      activeCurrency: 'PKR',
      status: 'active',
      pendingCurrency: null,
      previousCurrency: null,
      productCount: 0,
      productCurrencies: [],
      productCurrencyCounts: {},
      canAddProduct: false,
    })).toMatchObject({ valid: true, hasStore: false, canAddProduct: false });
  });
});
