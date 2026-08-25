jest.mock('react-native-keyboard-controller', () => ({
  KeyboardAvoidingView: ({ children }) => children,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }) => children }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }) => children }));
jest.mock('../../../src/config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
  API_ENDPOINTS: { STORES: { PRODUCT_CURRENCY: '/api/stores/product-currency' } },
}));
jest.mock('../../../src/components/common/GlassBackground', () => ({ children }) => children);
jest.mock('../../../src/components/common/GlassPanel', () => ({ children }) => children);
jest.mock('../../../src/components/common/CouponBarChart', () => ({
  __esModule: true,
  default: () => null,
  MetricRow: () => null,
}));
jest.mock('../../../src/components/seller/SellerUI', () => ({
  SellerEmptyState: () => null,
  SellerInlineError: () => null,
  SellerScreenHeader: () => null,
  SellerScreenSkeleton: () => null,
  SellerSectionHeader: () => null,
}));
jest.mock('../../../src/contexts/CurrencyContext', () => ({
  useCurrency: () => ({ currency: 'USD', formatPrice: (value) => String(value) }),
}));
jest.mock('../../../src/contexts/ThemeContext', () => ({
  useTheme: () => ({ palette: {} }),
}));
jest.mock('../../../src/utils/feedback', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));

import {
  buildCouponPayload,
  createCouponForm,
  getCouponStatus,
  loadVerifiedCouponProductState,
  normalizeCouponCurrency,
  normalizeCouponProductIds,
  validateCouponForm,
} from '../../../src/screens/seller/SellerCouponManagementScreen';
import {
  couponAnalyticsResponseIsValid,
  fetchCompleteSellerCoupons,
  inspectCouponPresentation,
  inspectCouponProductCurrencyState,
} from '../../../src/utils/couponSafety';

const objectId = index => index.toString(16).padStart(24, '0');

const persistedCoupon = (index = 1, overrides = {}) => ({
  _id: objectId(index),
  code: `SAVE${index}`,
  discountType: 'fixed',
  discountValue: 20,
  currency: 'PKR',
  applicableTo: 'all',
  applicableProducts: [],
  maxUses: 10,
  usedCount: 2,
  maxUsesPerUser: 1,
  minOrderAmount: 100,
  maxDiscountAmount: null,
  startDate: '2026-08-01T00:00:00.000Z',
  expiryDate: '2026-09-01T00:00:00.000Z',
  isActive: true,
  description: '',
  ...overrides,
});

const managedProduct = (index = 101, overrides = {}) => ({
  _id: objectId(index),
  name: `Product ${index}`,
  price: 0,
  discountedPrice: 0,
  currency: 'PKR',
  priceCurrency: 'PKR',
  discountedPriceCurrency: 'PKR',
  stock: 0,
  ...overrides,
});

const validForm = (overrides = {}) => ({
  code: 'SAVE20',
  discountType: 'percentage',
  discountValue: '20',
  currency: 'USD',
  applicableTo: 'all',
  applicableProducts: [],
  maxUses: '',
  maxUsesPerUser: '1',
  minOrderAmount: '',
  maxDiscountAmount: '',
  startDate: '2026-08-10',
  expiryDate: '2026-09-10',
  description: 'Launch offer',
  ...overrides,
});

describe('seller coupon production helpers', () => {
  test('creates new coupon money fields in the explicit store product currency', () => {
    expect(createCouponForm('PKR').currency).toBe('PKR');
    expect(createCouponForm().currency).toBeNull();
    expect(normalizeCouponCurrency(' pkr ')).toBe('PKR');
    expect(normalizeCouponCurrency('JPY')).toBeNull();
  });

  test('normalizes populated product objects to unique API ids when editing', () => {
    const firstId = objectId(101);
    const secondId = objectId(102);
    expect(normalizeCouponProductIds([
      { _id: firstId, name: 'First' },
      secondId,
      { _id: firstId },
      null,
    ])).toEqual([firstId, secondId]);
  });

  test('keeps the coupon native currency instead of reinterpreting values in the display currency', () => {
    const payload = buildCouponPayload(validForm({
      discountType: 'fixed',
      discountValue: '1500',
      currency: 'PKR',
      minOrderAmount: '5000',
      maxDiscountAmount: '1500',
      applicableTo: 'selected',
      applicableProducts: [{ _id: objectId(101) }],
    }));

    expect(payload).toMatchObject({
      discountValue: 1500,
      currency: 'PKR',
      minOrderAmount: 5000,
      maxDiscountAmount: 1500,
      maxUses: null,
      applicableProducts: [objectId(101)],
    });
  });

  test('validates scheduling, percentage limits, and selected products before saving', () => {
    const errors = validateCouponForm(validForm({
      discountValue: '120',
      applicableTo: 'selected',
      applicableProducts: [],
      startDate: '2026-09-10',
      expiryDate: '2026-09-09',
    }), new Date('2026-08-08T00:00:00.000Z'));

    expect(errors.discountValue).toMatch(/100%/);
    expect(errors.applicableProducts).toBeTruthy();
    expect(errors.expiryDate).toMatch(/after the start/i);
  });

  test('rejects percentage coupons below the persistence minimum', () => {
    const errors = validateCouponForm(validForm({ discountValue: '0.005' }), new Date('2026-08-08T00:00:00.000Z'));

    expect(errors.discountValue).toMatch(/at least 0.01%/i);
  });

  test('rejects sub-cent coupon money and fractional usage limits before sending', () => {
    expect(validateCouponForm(validForm({
      discountType: 'fixed',
      discountValue: '1.001',
      minOrderAmount: '0.001',
      maxDiscountAmount: '2.999',
      maxUses: '1.5',
    }), new Date('2026-08-08T00:00:00.000Z'))).toMatchObject({
      discountValue: expect.any(String),
      minOrderAmount: expect.any(String),
      maxDiscountAmount: expect.any(String),
      maxUses: expect.any(String),
    });
    expect(validateCouponForm(validForm({
      discountType: 'fixed',
      discountValue: '1e2',
      maxUses: '1e2',
    }), new Date('2026-08-08T00:00:00.000Z'))).toMatchObject({
      discountValue: expect.any(String),
      maxUses: expect.any(String),
    });
  });

  test('accepts only exact, internally consistent analytics in the requested currency', () => {
    const payload = {
      summary: {
        currency: 'PKR', totalCoupons: 1, activeCoupons: 1, totalUses: 1,
        totalRevenueFromCoupons: 500.25, totalDiscountGiven: 50.25,
        topCouponCode: 'SAVE20',
      },
      analytics: [{
        _id: objectId(1), code: 'SAVE20', applicableTo: 'all', applicableProducts: [],
        isActive: true, startDate: '2020-08-01T00:00:00.000Z', expiryDate: '2099-09-01T00:00:00.000Z',
        description: '',
        discountType: 'fixed', discountValue: 50.25, currency: 'PKR',
        usedCount: 1, maxUses: 10, ordersGenerated: 1, uniqueUsers: 1,
        totalRevenue: 500.25, totalDiscount: 50.25, avgOrderValue: 500.25,
        conversionRate: 10,
      }],
      moneyBasis: {
        attributedSales: 'recognized_eligible_product_subtotal_before_coupon_discount',
        discount: 'allocated_frozen_coupon_discount',
        excludes: ['shipping', 'tax'],
      },
    };
    expect(couponAnalyticsResponseIsValid(payload, 'PKR')).toBe(true);
    expect(couponAnalyticsResponseIsValid(payload, 'USD')).toBe(false);
    expect(couponAnalyticsResponseIsValid({
      ...payload,
      summary: { ...payload.summary, totalDiscountGiven: 50.251 },
    }, 'PKR')).toBe(false);
  });

  test('distinguishes scheduled, active, paused, and expired campaigns', () => {
    const now = new Date('2026-08-08T12:00:00.000Z');
    expect(getCouponStatus({ isActive: true, startDate: '2026-08-09', expiryDate: '2026-08-20' }, now)).toBe('scheduled');
    expect(getCouponStatus({ isActive: true, startDate: '2026-08-01', expiryDate: '2026-08-20' }, now)).toBe('active');
    expect(getCouponStatus({ isActive: false, startDate: '2026-08-01', expiryDate: '2026-08-20' }, now)).toBe('paused');
    expect(getCouponStatus({ isActive: true, startDate: '2026-07-01', expiryDate: '2026-08-01' }, now)).toBe('expired');
  });

  test('fails closed for corrupt coupon-card money, currency, counts, and scope', () => {
    const coupon = persistedCoupon(1, {
      code: 'SAVE20',
      applicableTo: 'selected',
      applicableProducts: [{ _id: objectId(2) }],
    });
    expect(inspectCouponPresentation(coupon).valid).toBe(true);
    [
      { ...coupon, discountValue: '20' },
      { ...coupon, currency: 'CAD' },
      { ...coupon, usedCount: 11 },
      { ...coupon, applicableProducts: [{ _id: 'product-1' }] },
    ].forEach((invalid) => expect(inspectCouponPresentation(invalid).valid).toBe(false));
  });

  test('cross-checks the exact store currency aggregate against the complete catalog and allows free products', () => {
    const product = managedProduct();
    const state = {
      hasStore: true,
      canAddProduct: true,
      status: 'active',
      activeCurrency: 'PKR',
      pendingCurrency: null,
      previousCurrency: null,
      productCount: 1,
      productCurrencies: ['PKR'],
      productCurrencyCounts: { PKR: 1 },
    };
    expect(inspectCouponProductCurrencyState(state, [product])).toMatchObject({
      valid: true,
      activeCurrency: 'PKR',
      productCount: 1,
    });
    expect(inspectCouponProductCurrencyState({ ...state, productCount: '1' }, [product]).valid).toBe(false);
    expect(inspectCouponProductCurrencyState(state, [managedProduct(101, {
      currency: 'USD', priceCurrency: 'USD', discountedPriceCurrency: 'USD',
    })]).valid).toBe(false);
    expect(inspectCouponProductCurrencyState(state, [managedProduct(101, { price: '0' })]).valid).toBe(false);
  });

  test('loads every exact coupon page and rejects incomplete or duplicate snapshots', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => persistedCoupon(index + 1, {
      code: `SAVE${index + 1}`,
      usedCount: 0,
    }));
    const finalCoupon = persistedCoupon(101, { code: 'SAVE101', usedCount: 0 });
    const apiClient = {
      get: jest.fn()
        .mockResolvedValueOnce({
          data: {
            coupons: firstPage,
            pagination: { page: 1, limit: 100, totalCoupons: 101, totalPages: 2, hasMore: true },
          },
        })
        .mockResolvedValueOnce({
          data: {
            coupons: [finalCoupon],
            pagination: { page: 2, limit: 100, totalCoupons: 101, totalPages: 2, hasMore: false },
          },
        }),
    };
    await expect(fetchCompleteSellerCoupons(apiClient)).resolves.toHaveLength(101);
    expect(apiClient.get).toHaveBeenNthCalledWith(1, '/api/coupons/seller', {
      params: { page: 1, limit: 100 },
    });

    const duplicate = persistedCoupon(1);
    await expect(fetchCompleteSellerCoupons({
      get: jest.fn().mockResolvedValue({ data: { coupons: [duplicate, duplicate] } }),
    })).rejects.toThrow(/duplicate identities/i);
  });

  test('re-verifies the complete product catalog and currency response together', async () => {
    const product = managedProduct();
    const apiClient = {
      get: jest.fn((url) => {
        if (url === '/api/products/get-seller-products') return Promise.resolve({ data: [product] });
        if (url === '/api/stores/product-currency') {
          return Promise.resolve({
            data: {
              productCurrency: {
                hasStore: true,
                canAddProduct: true,
                status: 'active',
                activeCurrency: 'PKR',
                pendingCurrency: null,
                previousCurrency: null,
                productCount: 1,
                productCurrencies: ['PKR'],
                productCurrencyCounts: { PKR: 1 },
              },
            },
          });
        }
        return Promise.reject(new Error('unexpected endpoint'));
      }),
    };
    await expect(loadVerifiedCouponProductState(apiClient)).resolves.toMatchObject({
      valid: true,
      activeCurrency: 'PKR',
      productCount: 1,
    });
  });
});
