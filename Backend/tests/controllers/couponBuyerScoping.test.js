'use strict';

const mockCouponFind = jest.fn();
const mockProductFind = jest.fn();
const mockGetActiveSellerIds = jest.fn();

jest.mock('../../models/Coupon', () => ({ find: mockCouponFind }));
jest.mock('../../models/Product', () => ({
  find: mockProductFind,
  countDocuments: jest.fn(),
}));
jest.mock('../../models/User', () => ({}));
jest.mock('../../services/publicCatalogService', () => ({
  getActiveSellerIds: mockGetActiveSellerIds,
}));

const { getCheckoutCoupons, validateCoupon } = require('../../controllers/couponController');

const BUYER = '64b000000000000000000010';
const SELLER_A = '64b0000000000000000000a1';
const SELLER_B = '64b0000000000000000000b1';
const PRODUCT_A = '64b0000000000000000000a2';
const PRODUCT_B = '64b0000000000000000000b2';
const COUPON_A = '64b0000000000000000000a3';
const COUPON_B = '64b0000000000000000000b3';

const coupon = ({
  _id,
  seller,
  applicableTo = 'all',
  applicableProducts = [],
  usedBy = [],
}) => ({
  _id,
  seller,
  code: 'SAVE10',
  discountType: 'percentage',
  discountValue: 10,
  currency: 'USD',
  applicableTo,
  applicableProducts,
  minOrderAmount: 0,
  maxDiscountAmount: null,
  maxUses: null,
  maxUsesPerUser: 1,
  usedCount: 0,
  usedBy,
  isActive: true,
  startDate: new Date(Date.now() - 86_400_000),
  expiryDate: new Date(Date.now() + 86_400_000),
  description: '',
});

const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

const productQuery = products => ({
  select: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(products),
});

const installCoupons = coupons => {
  mockCouponFind.mockImplementation((filter) => {
    let matches = [...coupons];
    if (filter.code) matches = matches.filter(entry => entry.code === filter.code);
    if (filter._id) matches = matches.filter(entry => String(entry._id) === String(filter._id));
    if (filter.seller) {
      const sellerIds = filter.seller.$in || [filter.seller];
      matches = matches.filter(entry => sellerIds.map(String).includes(String(entry.seller)));
    }
    return {
      populate: jest.fn().mockResolvedValue(matches),
    };
  });
};

describe('buyer coupon seller and product scoping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetActiveSellerIds.mockResolvedValue([SELLER_A, SELLER_B]);
    mockProductFind.mockReturnValue(productQuery([
      { _id: PRODUCT_A, seller: SELLER_A },
      { _id: PRODUCT_B, seller: SELLER_B },
    ]));
  });

  test('does not choose arbitrarily when cart sellers share a coupon code', async () => {
    installCoupons([
      coupon({ _id: COUPON_A, seller: SELLER_A }),
      coupon({ _id: COUPON_B, seller: SELLER_B }),
    ]);
    const res = response();

    await validateCoupon({
      user: { id: BUYER },
      body: { code: 'SAVE10', productIds: [PRODUCT_A, PRODUCT_B] },
    }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'COUPON_AMBIGUOUS' }));
  });

  test('uses explicit seller context to return the intended same-code coupon', async () => {
    installCoupons([
      coupon({ _id: COUPON_A, seller: SELLER_A }),
      coupon({ _id: COUPON_B, seller: SELLER_B }),
    ]);
    const res = response();

    await validateCoupon({
      user: { id: BUYER },
      body: { code: 'SAVE10', sellerId: SELLER_B, productIds: [PRODUCT_A, PRODUCT_B] },
    }, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      valid: true,
      coupon: expect.objectContaining({ _id: COUPON_B, applicableProductIds: [PRODUCT_B] }),
    }));
  });

  test('uses the exact advertised coupon id on mobile suggestion chips', async () => {
    installCoupons([
      coupon({ _id: COUPON_A, seller: SELLER_A }),
      coupon({ _id: COUPON_B, seller: SELLER_B }),
    ]);
    const res = response();

    await validateCoupon({
      user: { id: BUYER },
      body: { code: 'SAVE10', couponId: COUPON_A, productIds: [PRODUCT_A, PRODUCT_B] },
    }, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      valid: true,
      coupon: expect.objectContaining({ _id: COUPON_A, applicableProductIds: [PRODUCT_A] }),
    }));
  });

  test('checkout discovery hides per-user exhausted and non-applicable coupons', async () => {
    installCoupons([
      coupon({ _id: COUPON_A, seller: SELLER_A, usedBy: [{ user: BUYER, count: 1 }] }),
      coupon({
        _id: COUPON_B,
        seller: SELLER_B,
        applicableTo: 'selected',
        applicableProducts: [PRODUCT_A],
      }),
    ]);
    const res = response();

    await getCheckoutCoupons({
      user: { id: BUYER },
      body: { sellerIds: [SELLER_A, SELLER_B], productIds: [PRODUCT_A, PRODUCT_B] },
    }, res);

    expect(res.json).toHaveBeenCalledWith({ sellerCoupons: {} });
  });
});
