'use strict';

const mockFindUserById = jest.fn();

jest.mock('../../models/User', () => ({
  findById: mockFindUserById,
}));
jest.mock('../../models/Cart', () => ({}));
jest.mock('../../models/Product', () => ({}));
jest.mock('../../services/productModerationService', () => ({
  isProductBlocked: jest.fn(() => false),
  publicProductFilter: jest.fn(value => value),
}));
jest.mock('../../services/currencyService', () => ({
  isSupportedCurrency: value => ['USD', 'PKR', 'EUR', 'GBP'].includes(String(value || '').trim().toUpperCase()),
  normalizeCurrency: value => String(value || 'USD').toUpperCase(),
  getExchangeRateSnapshot: jest.fn().mockResolvedValue({
    rates: { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 },
    fallback: true,
  }),
  convertAmountWithRates: jest.requireActual('../../services/currencyService').convertAmountWithRates,
  exchangeRatesUnavailableError: jest.requireActual('../../services/currencyService').exchangeRatesUnavailableError,
}));
const { __private } = require('../../controllers/cartController');

describe('cart money presentation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindUserById.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ currency: 'USD' }) }),
    });
  });

  test('uses one exact global foreign conversion while preserving native lines', async () => {
    const cart = {
      cartItems: [
        { product: { price: 1, currency: 'PKR' }, qty: 1000 },
        { product: { price: 0.01, currency: 'GBP' }, qty: 1 },
        { product: { price: 0.01, currency: 'USD' }, qty: 1 },
      ],
    };

    const result = await __private.buildCartPayload(cart, 'buyer-1', 'ok');

    // Foreign exact total: PKR1000 / 284.6 + GBP0.01 / .79 = USD3.5263...
    // => USD3.53, plus the untouched native USD0.01 line.
    expect(result.totalCartPrice).toBe(3.54);
    expect(result.totalCartCurrency).toBe('USD');
  });

  test('prices a currency-less legacy product as canonical USD', async () => {
    const cart = {
      cartItems: [{
        product: { price: 280, seller: 'seller-pkr' },
        qty: 1,
      }],
    };

    const result = await __private.buildCartPayload(cart, 'buyer-1', 'ok');

    expect(result.totalCartPrice).toBe(280);
    expect(result.totalCartCurrency).toBe('USD');
  });

  test.each([true, '1', 0, 1.5, Number.POSITIVE_INFINITY])(
    'rejects a present corrupt cart quantity %p instead of defaulting to one',
    async qty => {
      await expect(__private.buildCartPayload({
        cartItems: [{ product: { price: 10, currency: 'USD' }, qty }],
      }, 'buyer-1', 'ok')).rejects.toMatchObject({
        code: 'CART_QUANTITY_INVALID',
        statusCode: 409,
      });
    },
  );

  test.each(['', 'usd', ' USD ', 'CAD', true])(
    'rejects present corrupt stored user currency %p',
    async currency => {
      mockFindUserById.mockReturnValue({
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ currency }) }),
      });

      await expect(__private.buildCartPayload({ cartItems: [] }, 'buyer-1', 'ok'))
        .rejects.toMatchObject({ code: 'USER_CURRENCY_INVALID', statusCode: 409 });
    },
  );

  test.each([
    { price: 1.004, currency: 'USD' },
    { price: true, currency: 'USD' },
    { price: 10, currency: '' },
    { price: 10, currency: 'CAD' },
  ])('rejects corrupt persisted product money/metadata: %j', async product => {
    await expect(__private.buildCartPayload({
      cartItems: [{ product, qty: 1 }],
    }, 'buyer-1', 'ok')).rejects.toMatchObject({ statusCode: 409 });
  });
});
