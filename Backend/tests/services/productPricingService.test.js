const {
  getProductCurrency,
  getProductDiscountCurrency,
  getProductBasePrice,
  getProductEffectivePrice,
  normalizeNativeProductPricing,
  requireStoredProductCurrency,
  requireStoredProductDiscountCurrency,
  requireStoredProductEffectivePrice,
} = require('../../services/productPricingService');

describe('productPricingService', () => {
  test('uses agreeing canonical product currency as source of truth', () => {
    expect(getProductCurrency({ price: 1000, currency: 'PKR', priceCurrency: 'PKR' })).toBe('PKR');
    expect(() => getProductCurrency({ price: 1000, currency: 'PKR', priceCurrency: 'USD' }))
      .toThrow(expect.objectContaining({ code: 'PRODUCT_CURRENCY_METADATA_INVALID' }));
  });

  test('keeps hydrated legacy currency defaults canonical USD', () => {
    const legacyProduct = {
      price: 5000,
      discountedPrice: 4500,
      currency: 'USD',
      priceCurrency: 'USD',
      discountedPriceCurrency: 'USD',
      $isDefault: field => [
        'currency',
        'priceCurrency',
        'discountedPriceCurrency',
      ].includes(field),
    };

    expect(getProductCurrency(legacyProduct, 'PKR')).toBe('USD');
    expect(getProductDiscountCurrency(legacyProduct, 'PKR')).toBe('USD');
  });

  test('requires supported, agreeing stored product currency metadata', () => {
    expect(requireStoredProductCurrency({ price: 10 }, 'USD')).toBe('USD');
    expect(requireStoredProductCurrency({ currency: 'PKR', priceCurrency: 'PKR' }, 'USD')).toBe('PKR');
    expect(() => requireStoredProductCurrency({ currency: 'CAD' }, 'USD')).toThrow(expect.objectContaining({
      code: 'PRODUCT_CURRENCY_METADATA_INVALID',
    }));
    for (const corruptPresentValue of [null, '', '   ', 'usd', ' USD ']) {
      expect(() => requireStoredProductCurrency({ currency: corruptPresentValue }, 'USD')).toThrow(
        expect.objectContaining({ code: 'PRODUCT_CURRENCY_METADATA_INVALID' })
      );
    }
    expect(() => requireStoredProductCurrency({ currency: 'PKR', priceCurrency: 'USD' }, 'USD')).toThrow(expect.objectContaining({
      code: 'PRODUCT_CURRENCY_METADATA_INVALID',
    }));
    expect(() => requireStoredProductDiscountCurrency({
      currency: 'USD',
      discountedPriceCurrency: 'CAD',
    }, 'USD')).toThrow(expect.objectContaining({ code: 'PRODUCT_CURRENCY_METADATA_INVALID' }));
  });

  test.each([
    { price: Number.POSITIVE_INFINITY, discountedPrice: 0 },
    { price: 0.001, discountedPrice: 0 },
    { price: 1.004, discountedPrice: 0 },
    { price: 10.001, discountedPrice: 0 },
    { price: 10, discountedPrice: 0.001 },
    { price: 10, discountedPrice: 10 },
  ])('fails closed for corrupt stored product money: %j', product => {
    expect(() => requireStoredProductEffectivePrice(product)).toThrow(expect.objectContaining({
      code: 'PRODUCT_PRICE_INVALID',
    }));
  });

  test('returns the exact valid stored effective price without relabelling or rounding it', () => {
    expect(requireStoredProductEffectivePrice({ price: 10, discountedPrice: 8.5 })).toBe(8.5);
    expect(requireStoredProductEffectivePrice({ price: 10, discountedPrice: 0 })).toBe(10);
    expect(() => getProductEffectivePrice({
      price: 100,
      discountedPrice: 50,
      currency: 'PKR',
      discountedPriceCurrency: 'USD',
    })).toThrow(expect.objectContaining({ code: 'PRODUCT_CURRENCY_METADATA_INVALID' }));
  });

  test.each([true, '10', Number.POSITIVE_INFINITY, 0.001, 1.004, -1])(
    'public base/effective readers reject corrupt stored price %p',
    price => {
      const product = { price, discountedPrice: 0, currency: 'USD' };
      expect(() => getProductBasePrice(product)).toThrow(expect.objectContaining({
        code: 'PRODUCT_PRICE_INVALID',
      }));
      expect(() => getProductEffectivePrice(product)).toThrow(expect.objectContaining({
        code: 'PRODUCT_PRICE_INVALID',
      }));
    },
  );

  test.each([null, '', '   ', 'usd', ' USD ', 'CAD'])(
    'public currency reader rejects present corrupt metadata %p',
    currency => {
      expect(() => getProductCurrency({ price: 10, currency })).toThrow(expect.objectContaining({
        code: 'PRODUCT_CURRENCY_METADATA_INVALID',
      }));
    },
  );

  test('keeps native product amounts without normalizing to USD', () => {
    const product = normalizeNativeProductPricing({
      price: 1000,
      discountedPrice: 900,
      currency: 'PKR',
    });

    expect(product).toMatchObject({
      price: 1000,
      discountedPrice: 900,
      currency: 'PKR',
      priceCurrency: 'PKR',
      priceInputAmount: 1000,
      discountedPriceCurrency: 'PKR',
      discountedPriceInputAmount: 900,
      priceVersion: 2,
    });
  });

  test('fails closed instead of erasing an invalid stored discount', () => {
    expect(() => normalizeNativeProductPricing({
      price: 100,
      discountedPrice: 120,
      currency: 'USD',
    })).toThrow(expect.objectContaining({
      code: 'PRODUCT_CURRENCY_PRICE_UNREPRESENTABLE',
    }));
  });

  test.each([
    { price: 1.004, currency: 'USD' },
    { price: Number.POSITIVE_INFINITY, currency: 'USD' },
    { price: 10, discountedPrice: 0.001, currency: 'USD' },
    { price: 10, currency: '' },
    { price: 10, currency: 'CAD' },
    { price: 10, currency: 'usd' },
    { price: 10, currency: 'PKR', priceCurrency: 'USD' },
  ])('native pricing normalization rejects corrupt persisted data: %j', product => {
    expect(() => normalizeNativeProductPricing(product)).toThrow();
  });

  test('converts explicit discount currency into the native product currency', () => {
    const product = normalizeNativeProductPricing({
      price: 2846,
      discountedPrice: 5,
      currency: 'PKR',
      discountedPriceCurrency: 'USD',
    });

    expect(product).toMatchObject({
      price: 2846,
      discountedPrice: 1423,
      currency: 'PKR',
      discountedPriceCurrency: 'PKR',
      discountedPriceInputAmount: 1423,
    });
  });
});
