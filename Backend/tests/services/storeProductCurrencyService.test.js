'use strict';

jest.mock('../../services/currencyService', () => {
  const CURRENCIES = {
    USD: { code: 'USD' },
    PKR: { code: 'PKR' },
    EUR: { code: 'EUR' },
    GBP: { code: 'GBP' },
  };
  const normalizeCurrency = value => (
    CURRENCIES[String(value || 'USD').trim().toUpperCase()]
      ? String(value || 'USD').trim().toUpperCase()
      : 'USD'
  );
  const isSupportedCurrency = value => Boolean(CURRENCIES[String(value || '').trim().toUpperCase()]);
  const getExchangeRateSnapshot = jest.fn();
  const convertAmountUsingTrustedRates = jest.fn(async (amount, fromCurrency, toCurrency, snapshot) => {
    const value = Number(amount || 0);
    const from = normalizeCurrency(fromCurrency);
    const to = normalizeCurrency(toCurrency);
    if (from === to) return Math.round(value * 100) / 100;
    if (snapshot?.fallback) {
      const error = new Error('Exchange rates unavailable');
      error.code = 'EXCHANGE_RATES_UNAVAILABLE';
      error.statusCode = 503;
      throw error;
    }
    const rates = snapshot?.rates || { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 };
    return Math.round(((value / rates[from]) * rates[to]) * 100) / 100;
  });
  return {
    CURRENCIES,
    isSupportedCurrency,
    normalizeCurrency,
    getExchangeRateSnapshot,
    convertAmountUsingTrustedRates,
  };
});

jest.mock('../../services/walletService', () => ({
  runInTransaction: jest.fn(async work => work({ id: 'session-1' })),
}));

jest.mock('../../models/Product', () => ({
  aggregate: jest.fn(),
  find: jest.fn(),
  bulkWrite: jest.fn(),
}));

jest.mock('../../models/Store', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn(),
}));

jest.mock('../../models/User', () => ({ findById: jest.fn() }));

const Product = require('../../models/Product');
const Store = require('../../models/Store');
const User = require('../../models/User');
const {
  getExchangeRateSnapshot,
  convertAmountUsingTrustedRates,
} = require('../../services/currencyService');
const { runInTransaction } = require('../../services/walletService');
const {
  requestProductCurrencyChange,
  cancelPendingProductCurrencyChange,
  assertProductCreationAllowed,
  convertPendingProductPrices,
  getSellerProductCurrencyState,
  normalizeProductCurrency,
  requireSellerProductCurrency,
  sellerDefaultProductCurrency,
} = require('../../services/storeProductCurrencyService');

const liveSnapshot = {
  rates: { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 },
  source: 'test-live',
  fallback: false,
};

const mockUser = (currency = 'PKR') => {
  User.findById.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue({ currency }),
  });
};

const pendingStore = () => ({
  _id: 'store-1',
  seller: 'seller-1',
  productCurrency: 'PKR',
  productCurrencyStatus: 'pending_conversion',
  previousProductCurrency: 'PKR',
  pendingProductCurrency: 'USD',
  save: jest.fn(),
});

describe('storeProductCurrencyService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser('PKR');
    getExchangeRateSnapshot.mockResolvedValue(liveSnapshot);
    Product.bulkWrite.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    Store.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  });

  test('rejects an unsupported requested currency instead of silently normalizing it to USD', async () => {
    await expect(requestProductCurrencyChange('seller-1', 'CAD')).rejects.toMatchObject({ status: 400 });
    expect(Store.findOne).not.toHaveBeenCalled();
  });

  test('fails closed instead of normalizing a present corrupt stored currency to USD', async () => {
    expect(normalizeProductCurrency(undefined)).toBe('USD');
    for (const corruptCurrency of ['CAD', '', '   ', null, false]) {
      expect(() => normalizeProductCurrency(corruptCurrency)).toThrow(expect.objectContaining({
        status: 409,
        code: 'PRODUCT_CURRENCY_METADATA_INVALID',
      }));
    }

    Store.findOne.mockResolvedValue({ productCurrency: 'CAD', productCurrencyStatus: 'active' });
    Product.aggregate.mockResolvedValue([]);
    await expect(getSellerProductCurrencyState('seller-1')).rejects.toMatchObject({
      code: 'PRODUCT_CURRENCY_METADATA_INVALID',
    });
  });

  test('uses the authoritative supported seller currency for auto-created stores', () => {
    expect(requireSellerProductCurrency({ currency: 'PKR' })).toBe('PKR');
    expect(requireSellerProductCurrency({ currency: 'gbp' })).toBe('GBP');
    expect(sellerDefaultProductCurrency({ address: { country: 'United States' } }, {
      currency: 'PKR',
    })).toBe('PKR');
    for (const corruptSeller of [{}, { currency: '' }, { currency: 'CAD' }, { currency: false }]) {
      expect(() => requireSellerProductCurrency(corruptSeller)).toThrow(expect.objectContaining({
        status: 409,
        code: 'SELLER_CURRENCY_METADATA_INVALID',
      }));
    }
  });

  test('fails closed for corrupt product-currency aggregate rows', async () => {
    Store.findOne.mockResolvedValue({ productCurrency: null, productCurrencyStatus: 'active' });
    Product.aggregate.mockResolvedValue([{ _id: 'CAD', count: 1 }]);

    await expect(getSellerProductCurrencyState('seller-1')).rejects.toMatchObject({
      code: 'PRODUCT_CURRENCY_METADATA_INVALID',
    });
  });

  test.each([
    {
      currencyType: 'string', currency: 'USD',
      priceCurrencyType: 'string', priceCurrency: 'CAD',
      discountedPriceCurrencyType: 'missing', discountedCurrencyType: 'missing',
    },
    {
      currencyType: 'string', currency: 'USD',
      priceCurrencyType: 'string', priceCurrency: 'PKR',
      discountedPriceCurrencyType: 'missing', discountedCurrencyType: 'missing',
    },
    {
      currencyType: 'null', currency: null,
      priceCurrencyType: 'missing', discountedPriceCurrencyType: 'missing', discountedCurrencyType: 'missing',
    },
    {
      currencyType: 'missing', priceCurrencyType: 'missing',
      discountedPriceCurrencyType: 'string', discountedPriceCurrency: 'CAD',
      discountedCurrencyType: 'missing',
    },
  ])('fails closed when another aggregate currency field is corrupt: %j', async aggregateId => {
    Store.findOne.mockResolvedValue({ productCurrency: 'USD', productCurrencyStatus: 'active' });
    Product.aggregate.mockResolvedValue([{ _id: aggregateId, count: 1 }]);

    await expect(getSellerProductCurrencyState('seller-1')).rejects.toMatchObject({
      code: 'PRODUCT_CURRENCY_METADATA_INVALID',
    });
  });

  test('canonicalizes only genuinely missing aggregate metadata to USD', async () => {
    Store.findOne.mockResolvedValue({ productCurrency: null, productCurrencyStatus: 'active' });
    Product.aggregate.mockResolvedValue([{
      _id: {
        currencyType: 'missing',
        priceCurrencyType: 'missing',
        discountedPriceCurrencyType: 'missing',
        discountedCurrencyType: 'missing',
      },
      count: 2,
    }]);

    await expect(getSellerProductCurrencyState('seller-1')).resolves.toMatchObject({
      activeCurrency: 'USD',
      productCurrencies: ['USD'],
      productCurrencyCounts: { USD: 2 },
    });
  });

  test.each(['CAD', '', null, false])(
    'fails closed for a corrupt seller fallback currency when no store exists: %j', async currency => {
      Store.findOne.mockResolvedValue(null);
      mockUser(currency);

      await expect(getSellerProductCurrencyState('seller-1')).rejects.toMatchObject({
        code: 'PRODUCT_CURRENCY_METADATA_INVALID',
      });
    }
  );

  test('allows the Store schema null sentinel to initialize from a valid seller/product fallback', async () => {
    Store.findOne.mockResolvedValue({ productCurrency: null, productCurrencyStatus: 'active' });
    Product.aggregate.mockResolvedValue([]);

    await expect(getSellerProductCurrencyState('seller-1')).resolves.toMatchObject({
      activeCurrency: 'PKR',
    });
  });

  test('requires confirmation before changing currency when products already exist', async () => {
    const store = { productCurrency: 'PKR', productCurrencyStatus: 'active', save: jest.fn() };
    Store.findOne.mockResolvedValue(store);
    Product.aggregate.mockResolvedValue([{ _id: 'PKR', count: 2 }]);

    const state = await requestProductCurrencyChange('seller-1', 'USD');

    expect(state).toMatchObject({ requiresConfirmation: true, activeCurrency: 'PKR', requestedCurrency: 'USD' });
    expect(store.save).not.toHaveBeenCalled();
  });

  test('confirmed change creates a pending conversion state and blocks new products', async () => {
    const store = {
      _id: 'store-1',
      seller: 'seller-1',
      __v: 2,
      productCurrency: 'PKR',
      productCurrencyStatus: 'active',
      pendingProductCurrency: null,
      previousProductCurrency: null,
      save: jest.fn(),
    };
    Store.findOne.mockResolvedValue(store);
    Store.findOneAndUpdate.mockImplementation(async (_filter, update) => {
      Object.assign(store, update.$set);
      store.__v += 1;
      return store;
    });
    Product.aggregate.mockResolvedValue([{ _id: 'PKR', count: 1 }]);

    const state = await requestProductCurrencyChange('seller-1', 'USD', { confirm: true });

    expect(state).toMatchObject({
      activeCurrency: 'PKR',
      previousCurrency: 'PKR',
      pendingCurrency: 'USD',
      status: 'pending_conversion',
    });
    expect(Store.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'store-1', seller: 'seller-1', __v: 2 }),
      expect.objectContaining({
        $set: expect.objectContaining({
          productCurrency: 'PKR',
          previousProductCurrency: 'PKR',
          pendingProductCurrency: 'USD',
          productCurrencyStatus: 'pending_conversion',
        }),
        $inc: { __v: 1 },
      }),
      { new: true, runValidators: true }
    );
    expect(state.canAddProduct).toBe(false);
    await expect(assertProductCreationAllowed('seller-1')).rejects.toMatchObject({ status: 409 });
  });

  test('fails a stale zero-product currency change instead of racing a product insert lock', async () => {
    const store = {
      _id: 'store-1',
      seller: 'seller-1',
      __v: 7,
      productCurrency: 'PKR',
      productCurrencyStatus: 'active',
      pendingProductCurrency: null,
      previousProductCurrency: null,
    };
    Store.findOne.mockResolvedValue(store);
    Store.findOneAndUpdate.mockResolvedValue(null);
    Product.aggregate.mockResolvedValue([]);

    await expect(requestProductCurrencyChange('seller-1', 'USD', { confirm: true })).rejects.toMatchObject({
      status: 409,
      code: 'PRODUCT_CURRENCY_CONVERSION_CONFLICT',
    });
    expect(Store.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'store-1', seller: 'seller-1', __v: 7 }),
      expect.any(Object),
      { new: true, runValidators: true }
    );
  });

  test('fails a stale cancellation after conversion wins the store version race', async () => {
    const store = { ...pendingStore(), __v: 11 };
    Store.findOne.mockResolvedValue(store);
    Store.findOneAndUpdate.mockResolvedValue(null);
    Product.aggregate.mockResolvedValue([{ _id: 'PKR', count: 1 }]);

    await expect(cancelPendingProductCurrencyChange('seller-1')).rejects.toMatchObject({
      status: 409,
      code: 'PRODUCT_CURRENCY_CONVERSION_CONFLICT',
    });
    expect(Store.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'store-1', seller: 'seller-1', __v: 11 }),
      expect.any(Object),
      { new: true, runValidators: true }
    );
  });

  test('converts all prices with one trusted snapshot and atomically activates the store currency', async () => {
    const storeBefore = pendingStore();
    const storeAfter = {
      ...storeBefore,
      productCurrency: 'USD',
      productCurrencyStatus: 'active',
      previousProductCurrency: null,
      pendingProductCurrency: null,
    };
    const products = [
      {
        _id: 'product-1',
        seller: 'seller-1',
        price: 284.6,
        discountedPrice: 0.46,
        currency: 'PKR',
        priceCurrency: 'PKR',
        discountedPriceCurrency: 'EUR',
        updatedAt: new Date('2026-08-13T00:00:00.000Z'),
      },
      {
        _id: 'product-2',
        seller: 'seller-1',
        price: 569.2,
        discountedPrice: 0,
        currency: 'PKR',
        priceCurrency: 'PKR',
        updatedAt: new Date('2026-08-13T00:00:01.000Z'),
      },
    ];
    Store.findOne.mockResolvedValueOnce(storeBefore).mockResolvedValueOnce(storeAfter);
    Product.aggregate
      .mockResolvedValueOnce([{ _id: 'PKR', count: 2 }])
      .mockResolvedValueOnce([{ _id: 'USD', count: 2 }]);
    Product.find.mockResolvedValue(products);
    Product.bulkWrite.mockResolvedValue({ matchedCount: 2, modifiedCount: 2 });

    const result = await convertPendingProductPrices('seller-1');

    expect(result.converted).toBe(2);
    expect(getExchangeRateSnapshot).toHaveBeenCalledTimes(1);
    expect(convertAmountUsingTrustedRates).toHaveBeenCalledTimes(3);
    expect(new Set(convertAmountUsingTrustedRates.mock.calls.map(call => call[3]))).toEqual(new Set([liveSnapshot]));
    expect(convertAmountUsingTrustedRates).toHaveBeenCalledWith(0.46, 'EUR', 'USD', liveSnapshot);
    expect(runInTransaction).toHaveBeenCalledTimes(1);
    expect(Product.bulkWrite).toHaveBeenCalledWith([
      expect.objectContaining({
        updateOne: expect.objectContaining({
          filter: expect.objectContaining({ _id: 'product-1', seller: 'seller-1', updatedAt: products[0].updatedAt }),
          update: { $set: expect.objectContaining({ price: 1, discountedPrice: 0.5, currency: 'USD' }) },
        }),
      }),
      expect.objectContaining({
        updateOne: expect.objectContaining({
          filter: expect.objectContaining({ _id: 'product-2', seller: 'seller-1', updatedAt: products[1].updatedAt }),
          update: { $set: expect.objectContaining({ price: 2, discountedPrice: 0, currency: 'USD' }) },
        }),
      }),
    ], { session: { id: 'session-1' } });
    expect(Store.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'store-1',
        seller: 'seller-1',
        productCurrencyStatus: 'pending_conversion',
        pendingProductCurrency: 'USD',
      }),
      { $set: expect.objectContaining({ productCurrency: 'USD', productCurrencyStatus: 'active' }) },
      { session: { id: 'session-1' } }
    );
  });

  test('refuses fallback rates before opening a transaction or writing any product', async () => {
    const store = pendingStore();
    Store.findOne.mockResolvedValue(store);
    Product.aggregate.mockResolvedValue([{ _id: 'PKR', count: 1 }]);
    Product.find.mockResolvedValue([{
      _id: 'product-1', seller: 'seller-1', price: 284.6, discountedPrice: 0, currency: 'PKR', priceCurrency: 'PKR',
    }]);
    getExchangeRateSnapshot.mockResolvedValue({ ...liveSnapshot, source: 'fallback', fallback: true });

    await expect(convertPendingProductPrices('seller-1')).rejects.toMatchObject({
      status: 503,
      code: 'EXCHANGE_RATES_UNAVAILABLE',
    });
    expect(runInTransaction).not.toHaveBeenCalled();
    expect(convertAmountUsingTrustedRates).not.toHaveBeenCalled();
    expect(Product.bulkWrite).not.toHaveBeenCalled();
    expect(Store.updateOne).not.toHaveBeenCalled();
  });

  test('fails before writes when a positive PKR price would become zero USD', async () => {
    const store = pendingStore();
    Store.findOne.mockResolvedValue(store);
    Product.aggregate.mockResolvedValue([{ _id: 'PKR', count: 1 }]);
    Product.find.mockResolvedValue([{
      _id: 'product-tiny',
      name: 'Tiny PKR product',
      seller: 'seller-1',
      price: 1,
      discountedPrice: 0,
      currency: 'PKR',
      priceCurrency: 'PKR',
    }]);

    await expect(convertPendingProductPrices('seller-1')).rejects.toMatchObject({
      status: 409,
      code: 'PRODUCT_CURRENCY_PRICE_UNREPRESENTABLE',
    });
    expect(runInTransaction).not.toHaveBeenCalled();
    expect(Product.bulkWrite).not.toHaveBeenCalled();
    expect(Store.updateOne).not.toHaveBeenCalled();
  });

  test('fails before writes when a real discount collapses onto the converted base-price cent', async () => {
    const store = pendingStore();
    Store.findOne.mockResolvedValue(store);
    Product.aggregate.mockResolvedValue([{ _id: 'PKR', count: 1 }]);
    Product.find.mockResolvedValue([{
      _id: 'product-collapsed-discount',
      name: 'Collapsed discount product',
      seller: 'seller-1',
      price: 284.6,
      discountedPrice: 283.6,
      currency: 'PKR',
      priceCurrency: 'PKR',
      discountedPriceCurrency: 'PKR',
    }]);

    await expect(convertPendingProductPrices('seller-1')).rejects.toMatchObject({
      status: 409,
      code: 'PRODUCT_CURRENCY_PRICE_UNREPRESENTABLE',
    });
    expect(runInTransaction).not.toHaveBeenCalled();
    expect(Product.bulkWrite).not.toHaveBeenCalled();
    expect(Store.updateOne).not.toHaveBeenCalled();
  });

  test('raises a conflict when a product changed and keeps store activation in the same failed transaction', async () => {
    const store = pendingStore();
    Store.findOne.mockResolvedValue(store);
    Product.aggregate.mockResolvedValue([{ _id: 'PKR', count: 1 }]);
    Product.find.mockResolvedValue([{
      _id: 'product-1', seller: 'seller-1', price: 284.6, discountedPrice: 0, currency: 'PKR', priceCurrency: 'PKR',
      updatedAt: new Date('2026-08-13T00:00:00.000Z'),
    }]);
    Product.bulkWrite.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });

    await expect(convertPendingProductPrices('seller-1')).rejects.toMatchObject({
      status: 409,
      code: 'PRODUCT_CURRENCY_CONVERSION_CONFLICT',
    });
    expect(Store.updateOne).toHaveBeenCalledTimes(1);
    expect(Store.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'store-1',
        productCurrencyStatus: 'pending_conversion',
        pendingProductCurrency: 'USD',
      }),
      { $inc: { __v: 1 } },
      { session: { id: 'session-1' } }
    );
  });
});
