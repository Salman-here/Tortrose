'use strict';

const Product = require('../../models/Product');

const makeProduct = overrides => new Product({
  name: 'Strict product',
  description: 'Strict product persistence fixture',
  price: 10,
  discountedPrice: 0,
  currency: 'USD',
  priceCurrency: 'USD',
  discountedPriceCurrency: 'USD',
  category: 'Test',
  brand: 'Test',
  stock: 5,
  image: 'https://example.com/product.jpg',
  ...overrides,
});

describe('product native money schema integrity', () => {
  test('validates an atomic price-and-discount update against the final query values', () => {
    const validator = Product.schema.path('discountedPrice').validators.find(
      entry => String(entry.message).startsWith('Discounted price must use exact cents'),
    ).validator;
    const queryContext = {
      get: path => (path === 'price' ? 5000 : undefined),
    };

    expect(validator.call(queryContext, 140)).toBe(true);
    expect(validator.call(queryContext, 5000)).toBe(false);
    expect(validator.call(queryContext, 140.001)).toBe(false);
    expect(validator.call({ get: () => undefined }, 0)).toBe(true);
    expect(validator.call({ get: () => undefined }, 140)).toBe(false);
  });

  test('bulk pricing boundary requires a complete exact final money state', () => {
    const valid = [{
      updateOne: {
        update: { $set: {
          price: 5000,
          discountedPrice: 140,
          currency: 'PKR',
          priceCurrency: 'PKR',
          priceInputAmount: 5000,
          discountedPriceCurrency: 'PKR',
          discountedPriceInputAmount: 140,
          priceVersion: 2,
        } },
      },
    }];
    expect(Product.assertSafeBulkPricingOperations(valid)).toBe(valid);
    expect(() => Product.assertSafeBulkPricingOperations([{
      updateMany: { update: { $set: { discountedPrice: 0, discountedPriceInputAmount: 0 } } },
    }])).not.toThrow();

    const invalidSets = [
      { price: 5000 },
      { discountedPrice: 140 },
      { discountedPrice: 0 },
      { discountedPrice: 0, discountedPriceInputAmount: 0, priceVersion: 2 },
      { price: 5000, discountedPrice: 140 },
      { currency: 'PKR', priceCurrency: 'PKR', discountedPriceCurrency: 'PKR' },
      { priceVersion: 2 },
      { price: 5000, discountedPrice: 5000 },
      { price: 5000.001, discountedPrice: 140 },
      { price: '5000', discountedPrice: 140 },
      { price: 5000, discountedPrice: 140, priceInputAmount: 4999 },
      {
        price: 5000,
        discountedPrice: 140,
        currency: 'PKR',
        priceCurrency: 'USD',
        discountedPriceCurrency: 'PKR',
      },
    ];
    invalidSets.forEach(set => {
      expect(() => Product.assertSafeBulkPricingOperations([{
        updateOne: { update: { $set: set } },
      }])).toThrow(expect.objectContaining({ code: 'PRODUCT_BULK_PRICING_INVALID' }));
    });
    expect(() => Product.assertSafeBulkPricingOperations([{
      updateOne: { update: { $inc: { price: 1 } } },
    }])).toThrow(expect.objectContaining({ code: 'PRODUCT_BULK_PRICING_INVALID' }));
  });

  test('accepts exact native cents, nullable legacy mirrors, and safe counters', () => {
    expect(makeProduct({
      price: 10.01,
      discountedPrice: 9.99,
      priceInputAmount: 10.01,
      discountedPriceInputAmount: 9.99,
      priceOriginal: null,
      discountedPriceOriginal: null,
      stock: 0,
      views: 2,
      totalSales: 3,
      returnPolicy: { returnDuration: 14, warrantyDuration: 30 },
    }).validateSync()).toBeUndefined();
  });

  test.each([
    [{ price: '10.00' }, 'price'],
    [{ price: true }, 'price'],
    [{ price: '' }, 'price'],
    [{ price: Number.POSITIVE_INFINITY }, 'price'],
    [{ price: Number.MAX_SAFE_INTEGER }, 'price'],
    [{ price: 0.001 }, 'price'],
    [{ discountedPrice: '9.00' }, 'discountedPrice'],
    [{ discountedPrice: true }, 'discountedPrice'],
    [{ discountedPrice: 9.001 }, 'discountedPrice'],
    [{ price: 10, discountedPrice: 10 }, 'discountedPrice'],
    [{ priceInputAmount: '10.00' }, 'priceInputAmount'],
    [{ discountedPriceInputAmount: 0.001 }, 'discountedPriceInputAmount'],
    [{ priceOriginal: true }, 'priceOriginal'],
    [{ discountedPriceOriginal: Number.POSITIVE_INFINITY }, 'discountedPriceOriginal'],
    [{ currency: 'usd' }, 'currency'],
    [{ currency: ' USD ' }, 'currency'],
    [{ currency: null }, 'currency'],
    [{ priceCurrency: 'CAD' }, 'priceCurrency'],
    [{ discountedPriceCurrency: null }, 'discountedPriceCurrency'],
    [{ stock: '5' }, 'stock'],
    [{ stock: true }, 'stock'],
    [{ stock: 1.5 }, 'stock'],
    [{ stock: Number.MAX_SAFE_INTEGER + 1 }, 'stock'],
    [{ totalSales: '1' }, 'totalSales'],
    [{ views: Number.POSITIVE_INFINITY }, 'views'],
    [{ returnPolicy: { returnDuration: '14' } }, 'returnPolicy.returnDuration'],
    [{ returnPolicy: { warrantyDuration: 1.5 } }, 'returnPolicy.warrantyDuration'],
  ])('rejects corrupt product persistence input %#', (overrides, expectedPath) => {
    const error = makeProduct(overrides).validateSync();
    expect(error?.errors?.[expectedPath]).toBeDefined();
  });
});
