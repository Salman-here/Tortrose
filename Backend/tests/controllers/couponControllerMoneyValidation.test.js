'use strict';

const mockCouponCreate = jest.fn();
const mockCouponFindOne = jest.fn();
const mockProductCountDocuments = jest.fn();
const mockStoreFindOne = jest.fn();
const mockGetExchangeRateSnapshot = jest.fn();
const mockAssertProductCreationAllowed = jest.fn();

jest.mock('../../models/Coupon', () => ({
  create: mockCouponCreate,
  findOne: mockCouponFindOne,
}));
jest.mock('../../models/Product', () => ({
  countDocuments: mockProductCountDocuments,
}));
jest.mock('../../models/User', () => ({}));
jest.mock('../../models/Store', () => ({
  findOne: mockStoreFindOne,
}));
jest.mock('../../services/currencyService', () => {
  const actual = jest.requireActual('../../services/currencyService');
  return {
    ...actual,
    getExchangeRateSnapshot: mockGetExchangeRateSnapshot,
  };
});
jest.mock('../../services/storeProductCurrencyService', () => ({
  assertProductCreationAllowed: mockAssertProductCreationAllowed,
}));

const { createCoupon, updateCoupon } = require('../../controllers/couponController');

const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

const validBody = overrides => ({
  code: 'SAVE10',
  discountType: 'fixed',
  discountValue: 10,
  currency: 'PKR',
  applicableTo: 'all',
  expiryDate: new Date(Date.now() + 86_400_000).toISOString(),
  ...overrides,
});

describe('coupon money input boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertProductCreationAllowed.mockResolvedValue({
      hasStore: true,
      activeCurrency: 'PKR',
      status: 'active',
      canAddProduct: true,
    });
    mockGetExchangeRateSnapshot.mockResolvedValue({
      base: 'USD',
      rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
      capturedAt: '2026-08-24T00:00:00.000Z',
      source: 'test-live',
      fallback: false,
    });
    mockStoreFindOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(null),
    });
  });

  test.each([
    ['boolean discount', { discountValue: true }],
    ['boolean minimum', { minOrderAmount: true }],
    ['array discount', { discountValue: [10] }],
    ['array usage limit', { maxUses: [2] }],
    ['unsafe usage limit', { maxUses: Number.MAX_VALUE }],
  ])('rejects %s before coupon persistence', async (_label, override) => {
    const res = response();
    await createCoupon({
      body: validBody(override),
      user: { id: 'seller-1', currency: 'PKR' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockCouponCreate).not.toHaveBeenCalled();
  });

  test('maps an unsafe fixed discount to a client error', async () => {
    const res = response();
    await createCoupon({
      body: validBody({ discountValue: Number.MAX_VALUE }),
      user: { id: 'seller-1', currency: 'PKR' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      msg: 'Discount value is too large.',
      code: 'COUPON_MONEY_AMOUNT_OUT_OF_RANGE',
    });
    expect(mockCouponCreate).not.toHaveBeenCalled();
  });

  test('rejects a percentage discount below the persistence minimum before create', async () => {
    const res = response();
    await createCoupon({
      body: validBody({ discountType: 'percentage', discountValue: '0.005' }),
      user: { id: 'seller-1', currency: 'PKR' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ msg: 'Percentage discount must be between 0.01 and 100.' });
    expect(mockCouponCreate).not.toHaveBeenCalled();
  });

  test('rejects a percentage discount below the persistence minimum before update', async () => {
    const save = jest.fn();
    mockCouponFindOne.mockResolvedValue({
      currency: 'PKR',
      discountType: 'percentage',
      discountValue: 10,
      minOrderAmount: 0,
      maxDiscountAmount: null,
      startDate: new Date(Date.now() - 86_400_000),
      expiryDate: new Date(Date.now() + 86_400_000),
      save,
    });
    const res = response();

    await updateCoupon({
      params: { id: '64b000000000000000000001' },
      body: { discountValue: '0.005' },
      user: { id: 'seller-1', currency: 'PKR' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ msg: 'Percentage discount must be between 0.01 and 100.' });
    expect(save).not.toHaveBeenCalled();
  });

  test('persists the same cent-rounded fixed discount used at checkout', async () => {
    mockCouponCreate.mockImplementation(async input => input);
    const res = response();

    await createCoupon({
      body: validBody({ discountValue: '1.005' }),
      user: { id: 'seller-1', currency: 'PKR' },
    }, res);

    expect(mockCouponCreate).toHaveBeenCalledWith(expect.objectContaining({
      discountValue: 1.01,
      currency: 'PKR',
      minOrderAmount: 0,
    }));
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('rejects a positive create minimum that would silently round to zero', async () => {
    const res = response();

    await createCoupon({
      body: validBody({ minOrderAmount: '0.004' }),
      user: { id: 'seller-1', currency: 'PKR' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      msg: expect.stringContaining('at least 0.01'),
    });
    expect(mockCouponCreate).not.toHaveBeenCalled();
  });

  test('rejects a positive update minimum that would silently round to zero', async () => {
    const save = jest.fn();
    mockCouponFindOne.mockResolvedValue({
      currency: 'PKR',
      discountType: 'fixed',
      discountValue: 10,
      minOrderAmount: 1,
      maxDiscountAmount: null,
      startDate: new Date(Date.now() - 86_400_000),
      expiryDate: new Date(Date.now() + 86_400_000),
      save,
    });
    const res = response();

    await updateCoupon({
      params: { id: '64b000000000000000000001' },
      body: { minOrderAmount: '0.004' },
      user: { id: 'seller-1', currency: 'PKR' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      msg: expect.stringContaining('at least 0.01'),
    });
    expect(save).not.toHaveBeenCalled();
  });

  test('defaults an omitted fixed-coupon currency to the authoritative active store currency', async () => {
    mockCouponCreate.mockImplementation(async input => input);
    const res = response();
    const body = validBody({ discountValue: 500 });
    delete body.currency;

    await createCoupon({
      body,
      user: { id: 'seller-1', currency: 'USD' },
    }, res);

    expect(mockCouponCreate).toHaveBeenCalledWith(expect.objectContaining({
      discountValue: 500,
      currency: 'PKR',
    }));
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('converts an explicitly foreign new coupon into the active store currency from one trusted snapshot', async () => {
    mockCouponCreate.mockImplementation(async input => input);
    const res = response();

    await createCoupon({
      body: validBody({
        currency: 'USD',
        discountValue: 10,
        minOrderAmount: 20,
        maxDiscountAmount: 5,
      }),
      user: { id: 'seller-1', currency: 'PKR' },
    }, res);

    expect(mockCouponCreate).toHaveBeenCalledWith(expect.objectContaining({
      discountValue: 2800,
      minOrderAmount: 5600,
      maxDiscountAmount: 1400,
      currency: 'PKR',
    }));
    expect(mockGetExchangeRateSnapshot).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('blocks new coupons while the store product-currency transition is pending', async () => {
    mockAssertProductCreationAllowed.mockRejectedValue(Object.assign(
      new Error('Finish or cancel the pending product currency change before creating coupons.'),
      { status: 409, code: 'PRODUCT_CURRENCY_CHANGE_PENDING' },
    ));
    const res = response();

    await createCoupon({
      body: validBody({ discountValue: 500 }),
      user: { id: 'seller-1', currency: 'PKR' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PRODUCT_CURRENCY_CHANGE_PENDING',
    }));
    expect(mockCouponCreate).not.toHaveBeenCalled();
  });

  test('converts every retained fixed-coupon amount from USD to PKR with one trusted snapshot', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const coupon = {
      currency: 'USD',
      discountType: 'fixed',
      discountValue: 10,
      minOrderAmount: 20,
      maxDiscountAmount: 5,
      startDate: new Date(Date.now() - 86_400_000),
      expiryDate: new Date(Date.now() + 86_400_000),
      save,
    };
    mockCouponFindOne.mockResolvedValue(coupon);
    const res = response();

    await updateCoupon({
      params: { id: '64b000000000000000000001' },
      body: { currency: 'PKR' },
      user: { id: 'seller-1', currency: 'USD' },
    }, res);

    expect(mockGetExchangeRateSnapshot).toHaveBeenCalledTimes(1);
    expect(coupon).toMatchObject({
      currency: 'PKR',
      discountValue: 2800,
      minOrderAmount: 5600,
      maxDiscountAmount: 1400,
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      msg: 'Coupon updated successfully!',
    }));
  });

  test('treats an explicit replacement as PKR while converting only retained USD terms', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const coupon = {
      currency: 'USD',
      discountType: 'fixed',
      discountValue: 10,
      minOrderAmount: 20,
      maxDiscountAmount: 5,
      startDate: new Date(Date.now() - 86_400_000),
      expiryDate: new Date(Date.now() + 86_400_000),
      save,
    };
    mockCouponFindOne.mockResolvedValue(coupon);
    const res = response();

    await updateCoupon({
      params: { id: '64b000000000000000000001' },
      body: { currency: 'PKR', discountValue: 500 },
      user: { id: 'seller-1', currency: 'USD' },
    }, res);

    expect(mockGetExchangeRateSnapshot).toHaveBeenCalledTimes(1);
    expect(coupon).toMatchObject({
      currency: 'PKR',
      discountValue: 500,
      minOrderAmount: 5600,
      maxDiscountAmount: 1400,
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  test('fails closed without saving when retained terms need an untrusted FX snapshot', async () => {
    mockGetExchangeRateSnapshot.mockResolvedValue({
      base: 'USD',
      rates: { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 },
      capturedAt: '2026-08-24T00:00:00.000Z',
      source: 'fallback',
      fallback: true,
    });
    const save = jest.fn();
    mockCouponFindOne.mockResolvedValue({
      currency: 'USD',
      discountType: 'fixed',
      discountValue: 10,
      minOrderAmount: 20,
      maxDiscountAmount: null,
      startDate: new Date(Date.now() - 86_400_000),
      expiryDate: new Date(Date.now() + 86_400_000),
      save,
    });
    const res = response();

    await updateCoupon({
      params: { id: '64b000000000000000000001' },
      body: { currency: 'PKR' },
      user: { id: 'seller-1', currency: 'USD' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'EXCHANGE_RATES_UNAVAILABLE',
    }));
    expect(save).not.toHaveBeenCalled();
  });

  test('rejects conversion to a currency other than the active store currency', async () => {
    const save = jest.fn();
    const coupon = {
      currency: 'USD',
      discountType: 'fixed',
      discountValue: 10,
      minOrderAmount: 20,
      maxDiscountAmount: 5,
      startDate: new Date(Date.now() - 86_400_000),
      expiryDate: new Date(Date.now() + 86_400_000),
      save,
    };
    mockCouponFindOne.mockResolvedValue(coupon);
    const res = response();

    await updateCoupon({
      params: { id: '64b000000000000000000001' },
      body: { currency: 'EUR' },
      user: { id: 'seller-1', currency: 'USD' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'COUPON_CURRENCY_STORE_MISMATCH',
    }));
    expect(mockGetExchangeRateSnapshot).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  test('returns a retryable conflict when an optimistic coupon save loses a race', async () => {
    const save = jest.fn().mockRejectedValue(Object.assign(new Error('stale version'), {
      name: 'VersionError',
    }));
    mockCouponFindOne.mockResolvedValue({
      currency: 'PKR',
      discountType: 'fixed',
      discountValue: 500,
      minOrderAmount: 0,
      maxDiscountAmount: null,
      startDate: new Date(Date.now() - 86_400_000),
      expiryDate: new Date(Date.now() + 86_400_000),
      save,
    });
    const res = response();

    await updateCoupon({
      params: { id: '64b000000000000000000001' },
      body: { description: 'Updated' },
      user: { id: 'seller-1', currency: 'USD' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'COUPON_UPDATE_CONFLICT',
    }));
  });
});
