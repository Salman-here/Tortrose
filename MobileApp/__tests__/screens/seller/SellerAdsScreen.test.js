jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('expo-image', () => ({ Image: () => null }));

jest.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }) => children }));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }) => children,
}));

jest.mock('../../../src/config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));

jest.mock('../../../src/utils/feedback', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));

jest.mock('../../../src/components/common/GlassBackground', () => ({ children }) => children);
jest.mock('../../../src/components/common/GlassPanel', () => ({ children }) => children);

jest.mock('../../../src/components/seller/SellerUI', () => ({
  SellerEmptyState: () => null,
  SellerInlineError: () => null,
  SellerScreenHeader: () => null,
  SellerScreenSkeleton: () => null,
  SellerSectionHeader: () => null,
}));

jest.mock('../../../src/contexts/CurrencyContext', () => ({
  useCurrency: () => ({ formatPrice: (value) => String(value) }),
}));

jest.mock('../../../src/contexts/ThemeContext', () => ({
  useTheme: () => ({ palette: {} }),
}));

import {
  buildAdsRequestPayload,
  getAdProductImage,
  getAdsDraftFromOverview,
  validateAdsRequest,
} from '../../../src/screens/seller/SellerAdsScreen';

const PRODUCT_ID_1 = '64b000000000000000000004';
const PRODUCT_ID_2 = '64b000000000000000000005';

const eliteOverview = (overrides = {}) => ({
  isElite: true,
  subscription: { metaAdsIncluded: false },
  activeRequest: null,
  pendingRequests: [],
  featuredProducts: [{ _id: 'product-1' }, { _id: 'product-2' }],
  ...overrides,
});

describe('SellerAdsScreen campaign rules', () => {
  it('builds a draft from the active campaign and excludes products that are no longer eligible', () => {
    const draft = getAdsDraftFromOverview(eliteOverview({
      activeRequest: {
        productIds: ['product-1', 'no-longer-featured'],
        channels: { meta: true },
      },
      pendingRequests: [{ productIds: ['product-2'], channels: { meta: false } }],
    }));

    expect(draft).toEqual({ selectedIds: ['product-1'], includeMeta: true });
  });

  it('falls back to the newest pending request when there is no active campaign', () => {
    const draft = getAdsDraftFromOverview(eliteOverview({
      pendingRequests: [{
        products: [{ _id: 'product-2' }, { _id: 'product-2' }],
        channels: { meta: true },
      }],
    }));

    expect(draft).toEqual({ selectedIds: ['product-2'], includeMeta: true });
  });

  it('preserves canonical IDs, trims the note, and sends no products for stop requests', () => {
    const longNote = `  ${'a'.repeat(500)}  `;

    expect(buildAdsRequestPayload({
      requestType: 'update',
      selectedIds: [PRODUCT_ID_1, PRODUCT_ID_2],
      includeMeta: true,
      sellerNote: longNote,
    })).toEqual({
      requestType: 'update',
      productIds: [PRODUCT_ID_1, PRODUCT_ID_2],
      includeMeta: true,
      sellerNote: 'a'.repeat(500),
    });

    expect(buildAdsRequestPayload({
      requestType: 'stop',
      selectedIds: [PRODUCT_ID_1],
      includeMeta: true,
      sellerNote: ' stop after this week ',
    })).toEqual({
      requestType: 'stop',
      productIds: [],
      includeMeta: false,
      sellerNote: 'stop after this week',
    });
  });

  it('rejects request-state and product-ID coercion at the payload boundary', () => {
    expect(() => buildAdsRequestPayload({
      requestType: 'invalid', selectedIds: [PRODUCT_ID_1], includeMeta: false, sellerNote: '',
    })).toThrow(/request type/i);
    expect(() => buildAdsRequestPayload({
      requestType: 'start', selectedIds: ['product-1'], includeMeta: false, sellerNote: '',
    })).toThrow(/canonical ObjectId/i);
    expect(() => buildAdsRequestPayload({
      requestType: 'start', selectedIds: [{ _id: PRODUCT_ID_1 }], includeMeta: false, sellerNote: '',
    })).toThrow(/canonical ObjectId/i);
    expect(() => buildAdsRequestPayload({
      requestType: 'start', selectedIds: [PRODUCT_ID_1, PRODUCT_ID_1], includeMeta: false, sellerNote: '',
    })).toThrow(/unique/i);
    expect(() => buildAdsRequestPayload({
      requestType: 'start', selectedIds: [PRODUCT_ID_1], includeMeta: 1, sellerNote: '',
    })).toThrow(/boolean/i);
    expect(() => buildAdsRequestPayload({
      requestType: 'start',
      selectedIds: [PRODUCT_ID_1],
      includeMeta: false,
      sellerNote: 'a'.repeat(501),
    })).toThrow(/cannot exceed 500/i);
  });

  it('enforces Elite access before campaign submission', () => {
    expect(validateAdsRequest({
      overview: eliteOverview({ isElite: false }),
      requestType: 'start',
      selectedIds: ['product-1'],
      includeMeta: false,
    })).toEqual({ valid: false, code: 'elite_required' });
  });

  it('prevents duplicate pending requests and empty product requests', () => {
    expect(validateAdsRequest({
      overview: eliteOverview({ pendingRequests: [{ _id: 'request-1' }] }),
      requestType: 'update',
      selectedIds: ['product-1'],
      includeMeta: false,
    })).toEqual({ valid: false, code: 'pending_request' });

    expect(validateAdsRequest({
      overview: eliteOverview(),
      requestType: 'start',
      selectedIds: [],
      includeMeta: false,
    })).toEqual({ valid: false, code: 'products_required' });
  });

  it('requires start and update request types to match active campaign state', () => {
    expect(validateAdsRequest({
      overview: eliteOverview({ activeRequest: { active: true } }),
      requestType: 'start',
      selectedIds: ['product-1'],
      includeMeta: false,
    })).toEqual({ valid: false, code: 'active_campaign' });

    expect(validateAdsRequest({
      overview: eliteOverview(),
      requestType: 'update',
      selectedIds: ['product-1'],
      includeMeta: false,
    })).toEqual({ valid: false, code: 'no_active_campaign' });
  });

  it('requires the Meta add-on and an active campaign before stopping', () => {
    expect(validateAdsRequest({
      overview: eliteOverview(),
      requestType: 'start',
      selectedIds: ['product-1'],
      includeMeta: true,
    })).toEqual({ valid: false, code: 'meta_addon_required' });

    expect(validateAdsRequest({
      overview: eliteOverview(),
      requestType: 'stop',
      selectedIds: [],
      includeMeta: false,
    })).toEqual({ valid: false, code: 'no_active_campaign' });

    expect(validateAdsRequest({
      overview: eliteOverview({ activeRequest: { active: true } }),
      requestType: 'stop',
      selectedIds: [],
      includeMeta: true,
    })).toEqual({ valid: true, code: null });
  });

  it('supports every image shape returned by product APIs', () => {
    expect(getAdProductImage({ image: 'https://cdn.test/main.jpg' })).toBe('https://cdn.test/main.jpg');
    expect(getAdProductImage({ images: ['https://cdn.test/first.jpg'] })).toBe('https://cdn.test/first.jpg');
    expect(getAdProductImage({ images: [{ secure_url: 'https://cdn.test/secure.jpg' }] })).toBe('https://cdn.test/secure.jpg');
    expect(getAdProductImage({ images: [] })).toBe('');
  });
});
