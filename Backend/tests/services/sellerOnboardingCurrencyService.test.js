'use strict';

jest.mock('../../services/storeProductCurrencyService', () => ({
  requireSellerProductCurrency: jest.fn(seller => {
    const supported = ['USD', 'PKR', 'EUR', 'GBP'];
    const value = typeof seller?.currency === 'string'
      ? seller.currency.trim().toUpperCase()
      : '';
    if (!supported.includes(value)) {
      const error = new Error('Stored seller currency metadata is invalid.');
      error.status = 409;
      error.code = 'SELLER_CURRENCY_METADATA_INVALID';
      throw error;
    }
    return value;
  }),
}));

const { requireSellerProductCurrency } = require('../../services/storeProductCurrencyService');
const {
  LEGACY_SELLER_SIGNUP_PRODUCT_CURRENCY,
  normalizeRequestedSellerProductCurrency,
  productCurrencyForBecomeSeller,
  productCurrencyForSellerSignupOtp,
  productCurrencyFromSellerSignupOtp,
} = require('../../services/sellerOnboardingCurrencyService');

describe('sellerOnboardingCurrencyService', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([
    ['USD', 'USD'],
    ['pkr', 'PKR'],
    [' eur ', 'EUR'],
    ['GbP', 'GBP'],
  ])('canonicalizes a supported requested product currency %j', (input, expected) => {
    expect(normalizeRequestedSellerProductCurrency(input)).toBe(expected);
  });

  test.each(['CAD', '', '   ', null, undefined, false, 1, {}])(
    'rejects unsupported or non-string requested product currency %j', value => {
      expect(() => normalizeRequestedSellerProductCurrency(value)).toThrow(expect.objectContaining({
        status: 400,
        code: 'SELLER_PRODUCT_CURRENCY_INVALID',
      }));
    }
  );

  test('become-seller honors only an explicit supported productCurrency', () => {
    expect(productCurrencyForBecomeSeller(
      { currency: 'USD' },
      { productCurrency: 'pkr', currency: 'GBP', country: 'United Kingdom' }
    )).toBe('PKR');
    expect(requireSellerProductCurrency).not.toHaveBeenCalled();
  });

  test('become-seller falls back to the authoritative User.currency when omitted', () => {
    expect(productCurrencyForBecomeSeller(
      { currency: 'PKR' },
      { currency: 'GBP', country: 'United States' }
    )).toBe('PKR');
    expect(requireSellerProductCurrency).toHaveBeenCalledWith({ currency: 'PKR' });
  });

  test('become-seller fails closed when an explicit field or stored User.currency is invalid', () => {
    expect(() => productCurrencyForBecomeSeller(
      { currency: 'PKR' },
      { productCurrency: null }
    )).toThrow(expect.objectContaining({ code: 'SELLER_PRODUCT_CURRENCY_INVALID' }));
    expect(() => productCurrencyForBecomeSeller(
      { currency: 'CAD' },
      {}
    )).toThrow(expect.objectContaining({ code: 'SELLER_CURRENCY_METADATA_INVALID' }));
  });

  test('send-OTP freezes a canonical selection and deliberately defaults old clients to USD', () => {
    expect(productCurrencyForSellerSignupOtp({ productCurrency: 'pkr' })).toBe('PKR');
    expect(productCurrencyForSellerSignupOtp({})).toBe(LEGACY_SELLER_SIGNUP_PRODUCT_CURRENCY);
    expect(productCurrencyForSellerSignupOtp({ currency: 'PKR' })).toBe('USD');
    expect(() => productCurrencyForSellerSignupOtp({ productCurrency: 'CAD' })).toThrow(
      expect.objectContaining({ status: 400, code: 'SELLER_PRODUCT_CURRENCY_INVALID' })
    );
  });

  test('verification reads only the frozen OTP currency and preserves a deliberate legacy fallback', () => {
    expect(productCurrencyFromSellerSignupOtp({ productCurrency: 'PKR' })).toBe('PKR');
    expect(productCurrencyFromSellerSignupOtp({ productCurrency: 'gbp' })).toBe('GBP');
    expect(productCurrencyFromSellerSignupOtp({ currency: 'PKR' })).toBe('USD');
    expect(productCurrencyFromSellerSignupOtp({})).toBe('USD');
  });

  test.each(['CAD', '', null, false, 1])(
    'verification fails closed for corrupt frozen OTP currency %j', productCurrency => {
      expect(() => productCurrencyFromSellerSignupOtp({ productCurrency })).toThrow(expect.objectContaining({
        status: 409,
        code: 'SELLER_SIGNUP_PRODUCT_CURRENCY_INVALID',
      }));
    }
  );
});
