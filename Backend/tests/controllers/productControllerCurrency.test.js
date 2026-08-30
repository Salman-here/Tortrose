'use strict';

jest.mock('../../services/currencyService', () => {
  const actual = jest.requireActual('../../services/currencyService');
  return {
    ...actual,
    getExchangeRateSnapshot: jest.fn(),
    convertAmountUsingTrustedRates: jest.fn(),
  };
});

jest.mock('../../services/walletService', () => ({
  runInTransaction: jest.fn(async work => work({ id: 'session-1' })),
}));

const Product = require('../../models/Product');
const Store = require('../../models/Store');
const User = require('../../models/User');
const {
  getExchangeRateSnapshot,
  convertAmountUsingTrustedRates,
} = require('../../services/currencyService');
const {
  __private,
  addProduct,
  bulkDeleteProducts,
  bulkDiscount,
  bulkPriceUpdate,
  editProduct,
  removeDiscount,
} = require('../../controllers/productController');
const {
  applyProductPricePercentage,
  normalizeProductPricePercentage,
} = require('../../services/productPricingService');

describe('productController currency write helpers', () => {
  const snapshot = {
    rates: { USD: 1, PKR: 280, EUR: 0.8, GBP: 0.75 },
    source: 'test-live',
    fallback: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    getExchangeRateSnapshot.mockResolvedValue(snapshot);
    convertAmountUsingTrustedRates.mockImplementation(async (amount, from, to, supplied) => {
      const rates = supplied.rates;
      return Math.round(((Number(amount) / rates[from]) * rates[to]) * 100) / 100;
    });
  });

  test('converts regular and discounted price from their declared source with one trusted snapshot', async () => {
    const result = await __private.applyProductCurrencyMetadata({
      price: 80,
      discountedPrice: 64,
      currency: 'EUR',
    }, 'EUR', 'USD');

    expect(result).toMatchObject({
      price: 100,
      discountedPrice: 80,
      currency: 'USD',
      priceCurrency: 'USD',
      discountedPriceCurrency: 'USD',
    });
    expect(getExchangeRateSnapshot).toHaveBeenCalledTimes(1);
    expect(convertAmountUsingTrustedRates).toHaveBeenNthCalledWith(1, 80, 'EUR', 'USD', snapshot);
    expect(convertAmountUsingTrustedRates).toHaveBeenNthCalledWith(2, 64, 'EUR', 'USD', snapshot);
  });

  test('uses the fallback source before converting currency-less legacy money to a forced store target', async () => {
    const result = await __private.applyProductCurrencyMetadata({
      name: 'Legacy USD product',
      price: 10,
      discountedPrice: 8,
    }, 'USD', 'PKR');

    expect(result).toMatchObject({
      price: 2800,
      discountedPrice: 2240,
      currency: 'PKR',
      priceCurrency: 'PKR',
      discountedPriceCurrency: 'PKR',
    });
    expect(convertAmountUsingTrustedRates).toHaveBeenNthCalledWith(1, 10, 'USD', 'PKR', snapshot);
    expect(convertAmountUsingTrustedRates).toHaveBeenNthCalledWith(2, 8, 'USD', 'PKR', snapshot);
  });

  test('serializes a raw currency-less legacy product as canonical USD', () => {
    expect(__private.serializeProductCurrencyMetadata({
      _id: '64b000000000000000000002',
      name: 'Legacy product',
      price: 10,
      discountedPrice: 8,
    }, 'USD')).toMatchObject({
      price: 10,
      discountedPrice: 8,
      currency: 'USD',
      priceCurrency: 'USD',
      discountedPriceCurrency: 'USD',
    });
  });

  test('serialization preserves explicit native product currency metadata', () => {
    expect(__private.serializeProductCurrencyMetadata({
      price: 1500,
      discountedPrice: 1200,
      currency: 'PKR',
      priceCurrency: 'PKR',
    }, 'USD')).toMatchObject({
      price: 1500,
      discountedPrice: 1200,
      currency: 'PKR',
      priceCurrency: 'PKR',
      discountedPriceCurrency: 'PKR',
    });
  });

  test.each([
    { currency: 'CAD' },
    { priceCurrency: 'CAD' },
    { currency: null },
    { currency: '' },
    { currency: 'PKR', priceCurrency: 'USD' },
  ])('serialization fails closed for corrupt stored product currency metadata: %j', metadata => {
    expect(() => __private.serializeProductCurrencyMetadata({ price: 10, ...metadata }, 'USD')).toThrow(
      expect.objectContaining({ code: 'PRODUCT_CURRENCY_METADATA_INVALID' })
    );
  });

  test.each([Number.POSITIVE_INFINITY, 0.001, 10.001])(
    'serialization fails closed for corrupt stored product price: %s',
    price => {
      expect(() => __private.serializeProductCurrencyMetadata({ price, discountedPrice: 0 }, 'USD')).toThrow(
        expect.objectContaining({ code: 'PRODUCT_PRICE_INVALID' })
      );
    }
  );

  test('admin product serialization preserves a corrupt row for repair without exposing it as valid money', () => {
    expect(__private.serializeAdminProductCurrencyMetadata({
      _id: '64b000000000000000000002',
      name: 'Legacy precision issue',
      price: 10.001,
      discountedPrice: 0,
      currency: 'USD',
      priceCurrency: 'USD',
      discountedPriceCurrency: 'USD',
    }, 'USD')).toMatchObject({
      _id: '64b000000000000000000002',
      price: 10.001,
      _comparablePrice: null,
      adminDataIssue: {
        scope: 'money',
        code: 'PRODUCT_PRICE_INVALID',
      },
    });
  });

  test('admin comparable pricing isolates a corrupt product instead of rejecting the complete dashboard list', async () => {
    const [product] = await __private.attachAdminComparablePrices([{
      _id: '64b000000000000000000002',
      name: 'Legacy precision issue',
      price: 10.001,
      discountedPrice: 0,
      currency: 'USD',
      priceCurrency: 'USD',
      discountedPriceCurrency: 'USD',
    }], 'USD');

    expect(product).toMatchObject({
      _id: '64b000000000000000000002',
      price: 10.001,
      _comparablePrice: null,
      adminDataIssue: {
        scope: 'money',
        code: 'PRODUCT_PRICE_INVALID',
      },
    });
  });

  test('rejects a positive product price that converts below one target cent', async () => {
    await expect(__private.applyProductCurrencyMetadata({
      name: 'Tiny PKR product',
      price: 1,
      currency: 'PKR',
    }, 'PKR', 'USD')).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRODUCT_CURRENCY_PRICE_UNREPRESENTABLE',
    });
  });

  test.each([
    [{ price: 0.001, currency: 'USD' }, 'positive price'],
    [{ price: 0.005, currency: 'USD' }, 'positive price'],
    [{ price: 10.001, currency: 'USD' }, 'positive price'],
    [{ price: 10, discountedPrice: 0.001, currency: 'USD' }, 'discount'],
    [{ price: 10, discountedPrice: 8.005, currency: 'USD' }, 'discount'],
  ])('rejects positive sub-cent manual product money before it can become zero: %j', async (input, message) => {
    await expect(__private.applyProductCurrencyMetadata(input, 'USD', 'USD')).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRODUCT_CURRENCY_PRICE_UNREPRESENTABLE',
      message: expect.stringContaining(message),
    });
  });

  test('manual create rejects a positive sub-cent price without saving a free product', async () => {
    const saveSpy = jest.spyOn(Product.prototype, 'save');
    const req = {
      user: { id: '64b000000000000000000001', role: 'admin', currency: 'USD' },
      body: { product: {
        name: 'Sub-cent product', description: 'A real description', price: 0.001,
        stock: 1, category: 'Other', brand: 'Test', image: 'https://example.com/p.jpg', currency: 'USD',
      } },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await addProduct(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PRODUCT_CURRENCY_PRICE_UNREPRESENTABLE',
    }));
    expect(saveSpy).not.toHaveBeenCalled();
    saveSpy.mockRestore();
  });

  test('manual edit rejects a positive sub-cent price before updating the product', async () => {
    const existing = new Product({
      _id: '64b000000000000000000002', name: 'Existing product', description: 'Description',
      price: 10, stock: 1, category: 'Other', brand: 'Test', image: 'https://example.com/p.jpg',
      currency: 'USD', seller: null,
    });
    const findSpy = jest.spyOn(Product, 'findById').mockResolvedValue(existing);
    const updateSpy = jest.spyOn(Product, 'findOneAndUpdate');
    const req = {
      params: { id: existing._id.toString() },
      user: { id: '64b000000000000000000001', role: 'admin', currency: 'PKR' },
      body: { product: { price: 0.001, currency: 'USD' } },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await editProduct(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PRODUCT_CURRENCY_PRICE_UNREPRESENTABLE',
    }));
    expect(updateSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
    updateSpy.mockRestore();
  });

  test('description-only edit of a currency-less admin product preserves its canonical USD money', async () => {
    const existing = new Product({
      _id: '64b000000000000000000002',
      name: 'Legacy admin product',
      description: 'Original description',
      price: 10,
      discountedPrice: 8,
      stock: 1,
      category: 'Other',
      brand: 'Test',
      image: 'https://example.com/p.jpg',
      seller: null,
    });
    const findSpy = jest.spyOn(Product, 'findById').mockResolvedValue(existing);
    const updateSpy = jest.spyOn(Product, 'findOneAndUpdate').mockImplementation(async (_filter, update) => {
      expect(update.$set).not.toHaveProperty('price');
      expect(update.$set).not.toHaveProperty('discountedPrice');
      expect(update.$set).not.toHaveProperty('currency');
      expect(update.$set).not.toHaveProperty('priceCurrency');
      existing.description = update.$set.description;
      return existing;
    });
    const req = {
      params: { id: existing._id.toString() },
      user: { id: '64b000000000000000000001', role: 'admin', currency: 'PKR' },
      body: { product: { description: 'Updated description only' } },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await editProduct(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      product: expect.objectContaining({
        price: 10,
        discountedPrice: 8,
        currency: 'USD',
        priceCurrency: 'USD',
      }),
    }));
    findSpy.mockRestore();
    updateSpy.mockRestore();
  });

  test('discount-only edit carries the validated final price into the atomic update', async () => {
    const existing = new Product({
      _id: '64b000000000000000000002',
      name: 'Discount-only product',
      description: 'Original description',
      price: 10,
      discountedPrice: 0,
      currency: 'USD',
      priceCurrency: 'USD',
      stock: 1,
      category: 'Other',
      brand: 'Test',
      image: 'https://example.com/p.jpg',
      seller: null,
    });
    const findSpy = jest.spyOn(Product, 'findById').mockResolvedValue(existing);
    const updateSpy = jest.spyOn(Product, 'findOneAndUpdate').mockImplementation(async (_filter, update) => {
      expect(update.$set).toMatchObject({ price: 10, discountedPrice: 8 });
      existing.set(update.$set);
      return existing;
    });
    const req = {
      params: { id: existing._id.toString() },
      user: { id: '64b000000000000000000001', role: 'admin', currency: 'PKR' },
      body: { product: { discountedPrice: 8 } },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await editProduct(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      product: expect.objectContaining({ price: 10, discountedPrice: 8, currency: 'USD' }),
    }));
    findSpy.mockRestore();
    updateSpy.mockRestore();
  });

  test('bulk discount removal writes every exact zero in one optimistic transaction', async () => {
    const productIds = ['64b000000000000000000002', '64b000000000000000000003'];
    const products = productIds.map((id, index) => ({
      _id: id,
      seller: null,
      price: 10,
      discountedPrice: 8 - index,
      currency: 'USD',
      priceCurrency: 'USD',
      discountedPriceCurrency: 'USD',
      discountedPriceInputAmount: 8 - index,
      updatedAt: new Date(`2026-08-25T00:00:0${index}.000Z`),
    }));
    const findSpy = jest.spyOn(Product, 'find').mockResolvedValue(products);
    const bulkSpy = jest.spyOn(Product, 'bulkWrite').mockResolvedValue({ matchedCount: 2 });
    const req = {
      user: { id: '64b000000000000000000001', role: 'admin' },
      body: { productIds },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await removeDiscount(req, res);

    expect(bulkSpy).toHaveBeenCalledWith(
      products.map(product => ({
        updateOne: {
          filter: expect.objectContaining({
            _id: product._id,
            seller: null,
            discountedPrice: product.discountedPrice,
            discountedPriceInputAmount: product.discountedPriceInputAmount,
            updatedAt: product.updatedAt,
          }),
          update: { $set: { discountedPrice: 0, discountedPriceInputAmount: 0 } },
        },
      })),
      { session: { id: 'session-1' } },
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ updatedCount: 2 }));
    findSpy.mockRestore();
    bulkSpy.mockRestore();
  });

  test('description-only edit fails recoverably when legacy USD must first convert to the active PKR store currency', async () => {
    const sellerId = new Product()._id;
    const existing = new Product({
      _id: '64b000000000000000000002',
      seller: sellerId,
      name: 'Legacy seller product',
      description: 'Original description',
      price: 10,
      discountedPrice: 0,
      stock: 1,
      category: 'Other',
      brand: 'Test',
      image: 'https://example.com/p.jpg',
    });
    const findSpy = jest.spyOn(Product, 'findById').mockResolvedValue(existing);
    const aggregateSpy = jest.spyOn(Product, 'aggregate').mockResolvedValue([{ _id: 'USD', count: 1 }]);
    const storeSpy = jest.spyOn(Store, 'findOne').mockResolvedValue({
      productCurrency: 'PKR',
      productCurrencyStatus: 'active',
      pendingProductCurrency: null,
      previousProductCurrency: null,
    });
    const userSpy = jest.spyOn(User, 'findById').mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ currency: 'USD' }),
    });
    const updateSpy = jest.spyOn(Product, 'findOneAndUpdate');
    const req = {
      params: { id: existing._id.toString() },
      user: { id: '64b000000000000000000001', role: 'admin', currency: 'PKR' },
      body: { product: { description: 'Description cannot relabel the price' } },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await editProduct(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      msg: expect.stringContaining('Include the price to convert it'),
    }));
    expect(updateSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
    aggregateSpy.mockRestore();
    storeSpy.mockRestore();
    userSpy.mockRestore();
    updateSpy.mockRestore();
  });

  test.each([
    [{ price: '' }, 'price must be a non-negative number.'],
    [{ price: null }, 'price must be a non-negative number.'],
    [{ price: false }, 'price must be a non-negative number.'],
    [{ discountedPrice: '   ' }, 'discountedPrice must be a non-negative number.'],
    [{ stock: null }, 'stock must be a non-negative safe whole number.'],
    [{ stock: 1.5 }, 'stock must be a non-negative safe whole number.'],
  ])('rejects empty, non-numeric, or fractional numeric writes: %j', (input, expected) => {
    expect(__private.invalidProductNumber(input)).toBe(expected);
  });

  test.each([
    { currency: null },
    { currency: '' },
    { priceCurrency: false },
    { discountedPriceCurrency: 'CAD' },
  ])('rejects present corrupt product currency input: %j', input => {
    expect(__private.invalidProductCurrencyField(input)).toBe(Object.keys(input)[0]);
  });

  test.each([0.001, 0.005, 10.001, -0.001, -0.005, -10.001])(
    'bulk money normalization rejects a non-exact-cent amount: %s', value => {
    expect(__private.normalizeBulkMoneyInput(value)).toBeNull();
    }
  );

  test('treats an optimistic bulk mismatch as an atomic conflict', async () => {
    const bulkSpy = jest.spyOn(Product, 'bulkWrite').mockResolvedValue({ matchedCount: 1 });
    const updates = [
      { updateOne: { filter: { _id: 'a' }, update: { $set: { price: 1 } } } },
      { updateOne: { filter: { _id: 'b' }, update: { $set: { price: 2 } } } },
    ];

    await expect(__private.writeProductsAtomically(updates)).rejects.toMatchObject({
      status: 409,
      code: 'PRODUCT_PRICE_UPDATE_CONFLICT',
    });
    expect(bulkSpy).toHaveBeenCalledWith(updates, { session: { id: 'session-1' } });
    bulkSpy.mockRestore();
  });

  test('rejects unsafe bulk percentages and computed prices as client errors', () => {
    expect(() => normalizeProductPricePercentage(1e100)).toThrow(expect.objectContaining({
      code: 'PRODUCT_PRICE_UPDATE_OUT_OF_RANGE',
      statusCode: 400,
    }));
    expect(() => normalizeProductPricePercentage(-1e100)).toThrow(expect.objectContaining({
      code: 'PRODUCT_PRICE_UPDATE_OUT_OF_RANGE',
      statusCode: 400,
    }));
    expect(() => applyProductPricePercentage(Number.MAX_SAFE_INTEGER / 100, 100)).toThrow(expect.objectContaining({
      code: 'PRODUCT_PRICE_UPDATE_OUT_OF_RANGE',
      statusCode: 400,
    }));
    expect(applyProductPricePercentage(19.99, 12.5)).toBe(22.49);
    expect(applyProductPricePercentage(19.99, -100)).toBe(0);
  });

  test.each([1e100, -1e100])('returns HTTP 400 for an unsafe manual bulk percentage: %s', async value => {
    const req = {
      user: { id: '64b000000000000000000001', role: 'seller' },
      body: {
        productIds: ['64b000000000000000000002'],
        updateType: 'percentage',
        value,
      },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await bulkPriceUpdate(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PRODUCT_PRICE_UPDATE_OUT_OF_RANGE',
      msg: expect.stringContaining('too large'),
    }));
  });

  test('rejects a bulk set-price that would turn a positive PKR amount into zero USD', async () => {
    const findSpy = jest.spyOn(Product, 'find').mockResolvedValue([{
      _id: '64b000000000000000000002',
      name: 'Tiny set price',
      price: 10,
      discountedPrice: 0,
      currency: 'USD',
    }]);
    const bulkSpy = jest.spyOn(Product, 'bulkWrite');
    const req = {
      user: { id: '64b000000000000000000001', role: 'admin' },
      body: {
        productIds: ['64b000000000000000000002'],
        updateType: 'set',
        value: 1,
        currency: 'PKR',
      },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await bulkPriceUpdate(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PRODUCT_CURRENCY_PRICE_UNREPRESENTABLE',
    }));
    expect(bulkSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
    bulkSpy.mockRestore();
  });

  test('rejects a bulk percentage discount that cannot change a one-cent price', async () => {
    const findSpy = jest.spyOn(Product, 'find').mockResolvedValue([{
      _id: '64b000000000000000000002',
      name: 'One cent product',
      price: 0.01,
      discountedPrice: 0,
      currency: 'USD',
    }]);
    const bulkSpy = jest.spyOn(Product, 'bulkWrite');
    const req = {
      user: { id: '64b000000000000000000001', role: 'admin' },
      body: {
        productIds: ['64b000000000000000000002'],
        discountType: 'percentage',
        discountValue: 1,
      },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await bulkDiscount(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PRODUCT_DISCOUNT_UNREPRESENTABLE',
    }));
    expect(bulkSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
    bulkSpy.mockRestore();
  });

  test.each([
    [['64B000000000000000000002'], 'uppercase'],
    [[' 64b000000000000000000002'], 'leading whitespace'],
    [['64b000000000000000000002 '], 'trailing whitespace'],
    [[{ toString: () => '64b000000000000000000002' }], 'object coercion'],
    [['64b000000000000000000002', '64b000000000000000000002'], 'duplicate'],
    [Array(1), 'sparse selection'],
  ])('rejects a non-canonical bulk mutation selection (%s: %s)', (productIds) => {
    expect(() => __private.parseBulkMutationProductIds(productIds)).toThrow(
      expect.objectContaining({
        status: 400,
        code: 'PRODUCT_BULK_SELECTION_INVALID',
      })
    );
  });

  test('enforces the 250-product mutation limit before parsing or querying IDs', () => {
    const productIds = Array.from(
      { length: __private.MAX_BULK_PRODUCT_MUTATIONS + 1 },
      (_, index) => index
    );
    expect(() => __private.parseBulkMutationProductIds(productIds)).toThrow(
      expect.objectContaining({
        status: 400,
        code: 'PRODUCT_BULK_SELECTION_LIMIT',
      })
    );
  });

  test('fails seller price changes closed when selected product money is outside the active store currency', () => {
    expect(() => __private.assertSellerBulkPricingCurrency([{
      _id: '64b000000000000000000002',
      name: 'Legacy USD product',
      price: 10,
      discountedPrice: 0,
      currency: 'USD',
      priceCurrency: 'USD',
    }], {
      hasStore: true,
      status: 'active',
      activeCurrency: 'PKR',
    })).toThrow(expect.objectContaining({
      status: 409,
      code: 'PRODUCT_STORE_CURRENCY_CONFLICT',
    }));

    expect(() => __private.assertSellerBulkPricingCurrency([{
      _id: '64b000000000000000000002',
      price: 1000,
      discountedPrice: 0,
      currency: 'PKR',
      priceCurrency: 'PKR',
    }], {
      hasStore: true,
      status: 'active',
      activeCurrency: 'PKR',
    })).not.toThrow();
  });

  test.each([
    ['discount', bulkDiscount, {
      discountType: 'percentage',
      discountValue: 10,
    }],
    ['price update', bulkPriceUpdate, {
      updateType: 'percentage',
      value: 10,
    }],
    ['discount removal', removeDiscount, {}],
  ])('does not partially apply a seller bulk %s when one selected product is missing or foreign', async (_label, handler, body) => {
    const productIds = ['64b000000000000000000002', '64b000000000000000000003'];
    const findSpy = jest.spyOn(Product, 'find').mockResolvedValue([{
      _id: productIds[0],
      price: 10,
      discountedPrice: 0,
      currency: 'USD',
    }]);
    const bulkSpy = jest.spyOn(Product, 'bulkWrite');
    const req = {
      user: { id: '64b000000000000000000001', role: 'seller' },
      body: { productIds, ...body },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await handler(req, res);

    expect(findSpy).toHaveBeenCalledWith(expect.objectContaining({
      _id: { $in: productIds },
      seller: req.user.id,
    }));
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PRODUCT_BULK_SELECTION_INCOMPLETE',
      msg: expect.stringContaining('No products were changed'),
    }));
    expect(bulkSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
    bulkSpy.mockRestore();
  });

  test.each([
    [bulkDiscount, { discountType: 'fixed', discountValue: 5 }],
    [bulkPriceUpdate, { updateType: 'fixed', value: 5 }],
    [bulkPriceUpdate, { updateType: 'set', value: 5 }],
  ])('requires an explicit currency for denomination-dependent bulk money', async (handler, body) => {
    const findSpy = jest.spyOn(Product, 'find');
    const req = {
      user: { id: '64b000000000000000000001', role: 'admin' },
      body: { productIds: ['64b000000000000000000002'], ...body },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PRODUCT_BULK_CURRENCY_INVALID',
    }));
    expect(findSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
  });

  test('sets an explicitly free product to exact zero and clears its discount without requiring FX', async () => {
    const productId = '64b000000000000000000002';
    const product = {
      _id: productId,
      seller: '64b000000000000000000009',
      name: 'PKR paid product',
      price: 1000,
      discountedPrice: 900,
      currency: 'PKR',
      priceCurrency: 'PKR',
      priceInputAmount: 1000,
      discountedPriceCurrency: 'PKR',
      discountedPriceInputAmount: 900,
      priceVersion: 2,
      updatedAt: new Date('2026-08-25T00:00:00.000Z'),
    };
    const findSpy = jest.spyOn(Product, 'find').mockResolvedValue([product]);
    const bulkSpy = jest.spyOn(Product, 'bulkWrite').mockResolvedValue({ matchedCount: 1 });
    const req = {
      user: { id: '64b000000000000000000001', role: 'admin' },
      body: {
        productIds: [productId],
        updateType: 'set',
        value: 0,
        currency: 'USD',
      },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await bulkPriceUpdate(req, res);

    expect(getExchangeRateSnapshot).not.toHaveBeenCalled();
    expect(convertAmountUsingTrustedRates).not.toHaveBeenCalled();
    expect(bulkSpy).toHaveBeenCalledWith([
      expect.objectContaining({
        updateOne: expect.objectContaining({
          update: { $set: expect.objectContaining({
            price: 0,
            priceInputAmount: 0,
            discountedPrice: 0,
            discountedPriceInputAmount: 0,
            currency: 'PKR',
            priceCurrency: 'PKR',
            discountedPriceCurrency: 'PKR',
          }) },
        }),
      }),
    ], { session: { id: 'session-1' } });
    expect(res.status).toHaveBeenCalledWith(200);
    findSpy.mockRestore();
    bulkSpy.mockRestore();
  });

  test('keeps a free product at exact zero for a percentage update while still writing atomically', async () => {
    const productId = '64b000000000000000000002';
    const product = {
      _id: productId,
      seller: null,
      name: 'Free product',
      price: 0,
      discountedPrice: 0,
      currency: 'USD',
      priceCurrency: 'USD',
      priceInputAmount: 0,
      discountedPriceCurrency: 'USD',
      discountedPriceInputAmount: 0,
      priceVersion: 2,
      updatedAt: new Date('2026-08-25T00:00:00.000Z'),
    };
    const findSpy = jest.spyOn(Product, 'find').mockResolvedValue([product]);
    const bulkSpy = jest.spyOn(Product, 'bulkWrite').mockResolvedValue({ matchedCount: 1 });
    const req = {
      user: { id: '64b000000000000000000001', role: 'admin' },
      body: { productIds: [productId], updateType: 'percentage', value: 10 },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await bulkPriceUpdate(req, res);

    expect(bulkSpy).toHaveBeenCalledWith([
      expect.objectContaining({
        updateOne: expect.objectContaining({
          update: { $set: expect.objectContaining({ price: 0, discountedPrice: 0 }) },
        }),
      }),
    ], { session: { id: 'session-1' } });
    expect(res.status).toHaveBeenCalledWith(200);
    findSpy.mockRestore();
    bulkSpy.mockRestore();
  });

  test('rejects a sale discount on a free product without writing any selected product', async () => {
    const productId = '64b000000000000000000002';
    const findSpy = jest.spyOn(Product, 'find').mockResolvedValue([{
      _id: productId,
      seller: null,
      name: 'Free product',
      price: 0,
      discountedPrice: 0,
      currency: 'USD',
    }]);
    const bulkSpy = jest.spyOn(Product, 'bulkWrite');
    const req = {
      user: { id: '64b000000000000000000001', role: 'admin' },
      body: {
        productIds: [productId],
        discountType: 'percentage',
        discountValue: 10,
      },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await bulkDiscount(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PRODUCT_DISCOUNT_UNREPRESENTABLE',
    }));
    expect(bulkSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
    bulkSpy.mockRestore();
  });

  test('does not relabel a positive stored discount whose currency conflicts with its base price', async () => {
    const productId = '64b000000000000000000002';
    const findSpy = jest.spyOn(Product, 'find').mockResolvedValue([{
      _id: productId,
      seller: null,
      name: 'Corrupt discount currency',
      price: 1000,
      discountedPrice: 900,
      currency: 'PKR',
      priceCurrency: 'PKR',
      discountedPriceCurrency: 'USD',
    }]);
    const bulkSpy = jest.spyOn(Product, 'bulkWrite');
    const req = {
      user: { id: '64b000000000000000000001', role: 'admin' },
      body: { productIds: [productId], updateType: 'percentage', value: 10 },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await bulkPriceUpdate(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PRODUCT_CURRENCY_METADATA_INVALID',
    }));
    expect(bulkSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
    bulkSpy.mockRestore();
  });

  test('returns a client error when a converted fixed change exceeds safe target money bounds', async () => {
    const productId = '64b000000000000000000002';
    const findSpy = jest.spyOn(Product, 'find').mockResolvedValue([{
      _id: productId,
      seller: null,
      name: 'Target overflow product',
      price: 10,
      discountedPrice: 0,
      currency: 'USD',
      priceCurrency: 'USD',
    }]);
    convertAmountUsingTrustedRates.mockRejectedValueOnce(Object.assign(
      new RangeError('Money amount is too large to preserve target cents.'),
      { code: 'MONEY_AMOUNT_OUT_OF_RANGE' }
    ));
    const bulkSpy = jest.spyOn(Product, 'bulkWrite');
    const req = {
      user: { id: '64b000000000000000000001', role: 'admin' },
      body: {
        productIds: [productId],
        updateType: 'fixed',
        value: 5,
        currency: 'PKR',
      },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await bulkPriceUpdate(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'MONEY_AMOUNT_OUT_OF_RANGE',
    }));
    expect(bulkSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
    bulkSpy.mockRestore();
  });

  test('bulk delete scopes seller ownership and deletes the complete selection in one transaction', async () => {
    const sellerId = '64b000000000000000000001';
    const productIds = ['64b000000000000000000002', '64b000000000000000000003'];
    const query = {
      select: jest.fn().mockReturnThis(),
      session: jest.fn().mockResolvedValue(productIds.map(_id => ({ _id }))),
    };
    const findSpy = jest.spyOn(Product, 'find').mockReturnValue(query);
    const deleteSpy = jest.spyOn(Product, 'deleteMany').mockResolvedValue({ deletedCount: 2 });
    const req = {
      user: { id: sellerId, role: 'seller' },
      body: { productIds },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await bulkDeleteProducts(req, res);

    const scopedQuery = { _id: { $in: productIds }, seller: sellerId };
    expect(findSpy).toHaveBeenCalledWith(scopedQuery);
    expect(query.select).toHaveBeenCalledWith('_id');
    expect(query.session).toHaveBeenCalledWith({ id: 'session-1' });
    expect(deleteSpy).toHaveBeenCalledWith(scopedQuery, { session: { id: 'session-1' } });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      deletedCount: 2,
      skippedCount: 0,
    }));
    findSpy.mockRestore();
    deleteSpy.mockRestore();
  });

  test('bulk delete rejects an incomplete selection before deleting anything', async () => {
    const productIds = ['64b000000000000000000002', '64b000000000000000000003'];
    const query = {
      select: jest.fn().mockReturnThis(),
      session: jest.fn().mockResolvedValue([{ _id: productIds[0] }]),
    };
    const findSpy = jest.spyOn(Product, 'find').mockReturnValue(query);
    const deleteSpy = jest.spyOn(Product, 'deleteMany');
    const req = {
      user: { id: '64b000000000000000000001', role: 'admin' },
      body: { productIds },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await bulkDeleteProducts(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PRODUCT_BULK_SELECTION_INCOMPLETE',
    }));
    expect(deleteSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
    deleteSpy.mockRestore();
  });

  test('bulk delete rolls back on a concurrent deleted-count mismatch', async () => {
    const productIds = ['64b000000000000000000002', '64b000000000000000000003'];
    const query = {
      select: jest.fn().mockReturnThis(),
      session: jest.fn().mockResolvedValue(productIds.map(_id => ({ _id }))),
    };
    const findSpy = jest.spyOn(Product, 'find').mockReturnValue(query);
    const deleteSpy = jest.spyOn(Product, 'deleteMany').mockResolvedValue({ deletedCount: 1 });
    const req = {
      user: { id: '64b000000000000000000001', role: 'admin' },
      body: { productIds },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await bulkDeleteProducts(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PRODUCT_BULK_DELETE_CONFLICT',
      msg: expect.stringContaining('No products were deleted'),
    }));
    findSpy.mockRestore();
    deleteSpy.mockRestore();
  });

  test('does not coerce a malformed bulk-write match count into atomic success', async () => {
    const bulkSpy = jest.spyOn(Product, 'bulkWrite').mockResolvedValue({ matchedCount: '1' });
    await expect(__private.writeProductsAtomically([{
      updateOne: { filter: { _id: 'a' }, update: { $set: { discountedPrice: 0, discountedPriceInputAmount: 0 } } },
    }])).rejects.toMatchObject({
      status: 500,
      code: 'PRODUCT_BULK_WRITE_RESULT_INVALID',
    });
    bulkSpy.mockRestore();
  });
});
