jest.mock('react-native-keyboard-controller', () => ({
  KeyboardAvoidingView: ({ children }) => children,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }) => children }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }) => children }));
jest.mock('../../../src/config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
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
  getCouponStatus,
  normalizeCouponProductIds,
  validateCouponForm,
} from '../../../src/screens/seller/SellerCouponManagementScreen';

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
  test('normalizes populated product objects to unique API ids when editing', () => {
    expect(normalizeCouponProductIds([
      { _id: 'product-1', name: 'First' },
      'product-2',
      { _id: 'product-1' },
      null,
    ])).toEqual(['product-1', 'product-2']);
  });

  test('keeps the coupon native currency instead of reinterpreting values in the display currency', () => {
    const payload = buildCouponPayload(validForm({
      discountType: 'fixed',
      discountValue: '1500',
      currency: 'PKR',
      minOrderAmount: '5000',
      maxDiscountAmount: '1500',
      applicableTo: 'selected',
      applicableProducts: [{ _id: 'product-1' }],
    }));

    expect(payload).toMatchObject({
      discountValue: 1500,
      currency: 'PKR',
      minOrderAmount: 5000,
      maxDiscountAmount: 1500,
      maxUses: null,
      applicableProducts: ['product-1'],
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

  test('distinguishes scheduled, active, paused, and expired campaigns', () => {
    const now = new Date('2026-08-08T12:00:00.000Z');
    expect(getCouponStatus({ isActive: true, startDate: '2026-08-09', expiryDate: '2026-08-20' }, now)).toBe('scheduled');
    expect(getCouponStatus({ isActive: true, startDate: '2026-08-01', expiryDate: '2026-08-20' }, now)).toBe('active');
    expect(getCouponStatus({ isActive: false, startDate: '2026-08-01', expiryDate: '2026-08-20' }, now)).toBe('paused');
    expect(getCouponStatus({ isActive: true, startDate: '2026-07-01', expiryDate: '2026-08-01' }, now)).toBe('expired');
  });
});
