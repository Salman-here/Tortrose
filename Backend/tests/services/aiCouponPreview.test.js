'use strict';

const mockCartFindOne = jest.fn();
const mockCouponFind = jest.fn();
const mockGetActiveSellerIds = jest.fn();
const mockProductFindOne = jest.fn();
const mockStoreFindOne = jest.fn();

jest.mock('../../models/Cart', () => ({
  findOne: mockCartFindOne,
}));
jest.mock('../../models/Coupon', () => ({
  find: mockCouponFind,
}));
jest.mock('../../models/Product', () => ({
  findOne: mockProductFindOne,
}));
jest.mock('../../models/Store', () => ({
  findOne: mockStoreFindOne,
}));
jest.mock('../../services/publicCatalogService', () => ({
  ...jest.requireActual('../../services/publicCatalogService'),
  getActiveSellerIds: mockGetActiveSellerIds,
}));

const { executeToolCall } = require('../../services/aiActionExecutor');

const BUYER_ID = '64b000000000000000000010';
const SELLER_A = '64b0000000000000000000a1';
const SELLER_B = '64b0000000000000000000b1';
const STORE_A = '64b0000000000000000000a0';
const PRODUCT_A = '64b0000000000000000000a2';
const PRODUCT_B = '64b0000000000000000000b2';
const COUPON_A = '64b0000000000000000000a3';
const COUPON_B = '64b0000000000000000000b3';

const queryResult = value => ({
  limit: jest.fn().mockReturnThis(),
  populate: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(value),
});

const coupon = ({ _id, seller, usedBy = [], ...overrides }) => ({
  _id,
  seller,
  code: 'SAVE10',
  discountType: 'percentage',
  discountValue: 10,
  currency: 'USD',
  applicableTo: 'all',
  applicableProducts: [],
  minOrderAmount: 0,
  maxDiscountAmount: null,
  maxUses: null,
  maxUsesPerUser: 1,
  usedCount: 0,
  usedBy,
  isActive: true,
  startDate: new Date(Date.now() - 86_400_000),
  expiryDate: new Date(Date.now() + 86_400_000),
  ...overrides,
});

const cartItem = ({ _id, productId, seller, price, qty = 1 }) => ({
  _id,
  qty,
  product: {
    _id: productId,
    seller,
    name: `Product ${productId.slice(-2)}`,
    price,
    discountedPrice: 0,
    currency: 'USD',
    priceCurrency: 'USD',
    stock: 10,
    isBlocked: false,
  },
});

const installCart = cartItems => {
  const query = {
    populate: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue({ user: BUYER_ID, cartItems }),
  };
  mockCartFindOne.mockReturnValue(query);
};

const installCoupons = coupons => {
  mockCouponFind.mockImplementation((filter) => {
    let matches = [...coupons];
    if (filter.code) matches = matches.filter(entry => entry.code === filter.code);
    if (filter.seller) {
      const sellerIds = filter.seller.$in || [filter.seller];
      matches = matches.filter(entry => sellerIds.map(String).includes(String(entry.seller)));
    }
    if (filter._id?.$in) {
      matches = matches.filter(entry => filter._id.$in.map(String).includes(String(entry._id)));
    }
    return queryResult(matches);
  });
};

describe('AI coupon preview checkout parity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetActiveSellerIds.mockResolvedValue([SELLER_A, SELLER_B]);
    mockProductFindOne.mockReturnValue(queryResult(null));
    mockStoreFindOne.mockReturnValue(queryResult(null));
  });

  test('requires an authenticated buyer because per-user eligibility is authoritative', async () => {
    await expect(executeToolCall('validate_coupon', {
      code: 'SAVE10',
      cartTotal: 100,
    }, { role: 'guest', currency: 'USD' })).resolves.toMatchObject({
      success: false,
      code: 'COUPON_LOGIN_REQUIRED',
    });

    expect(mockCartFindOne).not.toHaveBeenCalled();
    expect(mockCouponFind).not.toHaveBeenCalled();
  });

  test('ignores a forged caller total and prices the authenticated server cart', async () => {
    installCart([cartItem({ _id: '64b0000000000000000000a4', productId: PRODUCT_A, seller: SELLER_A, price: 100 })]);
    installCoupons([coupon({ _id: COUPON_A, seller: SELLER_A })]);

    const result = await executeToolCall('validate_coupon', {
      code: 'save10',
      cartTotal: 999_999_999,
    }, { _id: BUYER_ID, role: 'user', currency: 'USD' });

    expect(result).toMatchObject({
      success: true,
      data: {
        couponId: COUPON_A,
        discount: 10,
        currency: 'USD',
        applicableProductIds: [PRODUCT_A],
      },
    });
  });

  test('enforces the authenticated buyer per-user usage limit', async () => {
    installCart([cartItem({ _id: '64b0000000000000000000a4', productId: PRODUCT_A, seller: SELLER_A, price: 100 })]);
    installCoupons([coupon({
      _id: COUPON_A,
      seller: SELLER_A,
      usedBy: [{ user: BUYER_ID, count: 1 }],
    })]);

    await expect(executeToolCall('validate_coupon', {
      code: 'SAVE10',
    }, { _id: BUYER_ID, role: 'user', currency: 'USD' })).resolves.toMatchObject({
      success: false,
      code: 'COUPON_USER_LIMIT',
    });
  });

  test('does not choose arbitrarily when two cart sellers use the same code', async () => {
    installCart([
      cartItem({ _id: '64b0000000000000000000a4', productId: PRODUCT_A, seller: SELLER_A, price: 100 }),
      cartItem({ _id: '64b0000000000000000000b4', productId: PRODUCT_B, seller: SELLER_B, price: 50 }),
    ]);
    installCoupons([
      coupon({ _id: COUPON_A, seller: SELLER_A }),
      coupon({ _id: COUPON_B, seller: SELLER_B }),
    ]);

    await expect(executeToolCall('validate_coupon', {
      code: 'SAVE10',
    }, { _id: BUYER_ID, role: 'user', currency: 'USD' })).resolves.toMatchObject({
      success: false,
      code: 'COUPON_AMBIGUOUS',
    });
  });

  test('uses a cart product context to select the correct seller coupon', async () => {
    installCart([
      cartItem({ _id: '64b0000000000000000000a4', productId: PRODUCT_A, seller: SELLER_A, price: 100 }),
      cartItem({ _id: '64b0000000000000000000b4', productId: PRODUCT_B, seller: SELLER_B, price: 50 }),
    ]);
    installCoupons([
      coupon({ _id: COUPON_A, seller: SELLER_A }),
      coupon({ _id: COUPON_B, seller: SELLER_B }),
    ]);

    await expect(executeToolCall('validate_coupon', {
      code: 'SAVE10',
      productId: PRODUCT_B,
    }, { _id: BUYER_ID, role: 'user', currency: 'USD' })).resolves.toMatchObject({
      success: true,
      data: {
        couponId: COUPON_B,
        discount: 5,
        applicableProductIds: [PRODUCT_B],
      },
    });
  });

  test('resolves a public store id supplied as the seller selector', async () => {
    installCart([cartItem({
      _id: '64b0000000000000000000a4',
      productId: PRODUCT_A,
      seller: SELLER_A,
      price: 100,
    })]);
    installCoupons([coupon({ _id: COUPON_A, seller: SELLER_A })]);
    mockStoreFindOne.mockReturnValue(queryResult({ _id: STORE_A, seller: SELLER_A }));

    const result = await executeToolCall('validate_coupon', {
      code: 'SAVE10',
      sellerId: STORE_A,
    }, { _id: BUYER_ID, role: 'user', currency: 'USD' });

    expect(result).toMatchObject({
      success: true,
      data: {
        couponId: COUPON_A,
        discount: 10,
        applicableProductIds: [PRODUCT_A],
      },
    });
    expect(mockStoreFindOne).toHaveBeenCalledWith({ _id: STORE_A });
  });

  test('still rejects an unrelated seller selector that is not a cart store', async () => {
    installCart([cartItem({
      _id: '64b0000000000000000000a4',
      productId: PRODUCT_A,
      seller: SELLER_A,
      price: 100,
    })]);
    installCoupons([coupon({ _id: COUPON_A, seller: SELLER_A })]);
    mockStoreFindOne.mockReturnValue(queryResult(null));

    await expect(executeToolCall('validate_coupon', {
      code: 'SAVE10',
      sellerId: SELLER_B,
    }, { _id: BUYER_ID, role: 'user', currency: 'USD' })).resolves.toMatchObject({
      success: false,
      code: 'COUPON_SELLER_NOT_IN_CART',
    });
  });

  test.each(['1', true, 0, 1.5])(
    'fails closed when the authenticated cart stores a corrupt quantity (%p)',
    async (qty) => {
      installCart([cartItem({
        _id: '64b0000000000000000000a4',
        productId: PRODUCT_A,
        seller: SELLER_A,
        price: 100,
        qty,
      })]);
      installCoupons([coupon({ _id: COUPON_A, seller: SELLER_A })]);

      await expect(executeToolCall('validate_coupon', {
        code: 'SAVE10',
      }, { _id: BUYER_ID, role: 'user', currency: 'USD' })).resolves.toMatchObject({
        success: false,
        code: 'ORDER_QUANTITY_INVALID',
      });
    },
  );
});

describe('AI coupon discovery public and buyer scoping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetActiveSellerIds.mockResolvedValue([SELLER_A, SELLER_B]);
    mockProductFindOne.mockReturnValue(queryResult(null));
    mockStoreFindOne.mockReturnValue(queryResult(null));
  });

  test('resolves an actual store id to its active seller', async () => {
    mockGetActiveSellerIds.mockResolvedValue([SELLER_A]);
    mockStoreFindOne.mockReturnValue(queryResult({ _id: STORE_A, seller: SELLER_A }));
    installCoupons([coupon({ _id: COUPON_A, seller: SELLER_A })]);

    const result = await executeToolCall('get_available_coupons', {
      storeId: STORE_A,
    }, { role: 'guest', currency: 'USD' });

    expect(result).toMatchObject({ success: true, data: { count: 1 } });
    expect(mockCouponFind).toHaveBeenCalledWith(expect.objectContaining({ seller: SELLER_A }));
  });

  test('limits product discovery to the active product owner', async () => {
    mockProductFindOne.mockReturnValue(queryResult({ _id: PRODUCT_B, seller: SELLER_B }));
    installCoupons([
      coupon({ _id: COUPON_A, seller: SELLER_A }),
      coupon({ _id: COUPON_B, seller: SELLER_B }),
    ]);

    const result = await executeToolCall('get_available_coupons', {
      productId: PRODUCT_B,
    }, { role: 'guest', currency: 'USD' });

    expect(result).toMatchObject({
      success: true,
      data: {
        count: 1,
        coupons: [expect.objectContaining({ couponId: COUPON_B, sellerId: SELLER_B })],
      },
    });
    expect(mockCouponFind).toHaveBeenCalledWith(expect.objectContaining({ seller: SELLER_B }));
  });

  test('hides a coupon after this buyer reaches its per-user limit', async () => {
    installCoupons([coupon({
      _id: COUPON_A,
      seller: SELLER_A,
      usedBy: [{ user: BUYER_ID, count: 1 }],
    })]);

    await expect(executeToolCall('get_available_coupons', {}, {
      _id: BUYER_ID,
      role: 'user',
      currency: 'USD',
    })).resolves.toMatchObject({ success: true, data: { count: 0, coupons: [] } });
  });

  test('never lists coupons from sellers outside the active public set', async () => {
    mockGetActiveSellerIds.mockResolvedValue([SELLER_A]);
    installCoupons([
      coupon({ _id: COUPON_A, seller: SELLER_A }),
      coupon({ _id: COUPON_B, seller: SELLER_B }),
    ]);

    const result = await executeToolCall('get_available_coupons', {}, { role: 'guest', currency: 'USD' });

    expect(result).toMatchObject({
      success: true,
      data: { count: 1, coupons: [expect.objectContaining({ couponId: COUPON_A })] },
    });
  });

  test('never presents malformed stored coupon money or currency as a valid offer', async () => {
    installCoupons([
      coupon({ _id: COUPON_A, seller: SELLER_A }),
      coupon({
        _id: COUPON_B,
        seller: SELLER_B,
        currency: 'usd',
        discountValue: '10',
      }),
    ]);

    const result = await executeToolCall('get_available_coupons', {}, { role: 'guest', currency: 'USD' });

    expect(result).toMatchObject({
      success: true,
      data: {
        count: 1,
        coupons: [expect.objectContaining({ couponId: COUPON_A, currency: 'USD' })],
      },
    });
  });
});
