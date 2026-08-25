jest.mock('expo-web-browser', () => ({
  openAuthSessionAsync: jest.fn(),
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(),
}));

jest.mock('expo-image', () => ({
  Image: 'Image',
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('expo-linear-gradient', () => ({
  LinearGradient: 'LinearGradient',
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
}));

jest.mock('../../../src/components/seller/SellerUI', () => ({
  SellerEmptyState: 'SellerEmptyState',
  SellerInlineError: 'SellerInlineError',
  SellerScreenHeader: 'SellerScreenHeader',
  SellerScreenSkeleton: 'SellerScreenSkeleton',
  SellerSectionHeader: 'SellerSectionHeader',
}));

jest.mock('../../../src/components/common/GlassBackground', () => 'GlassBackground');
jest.mock('../../../src/components/common/GlassPanel', () => 'GlassPanel');
jest.mock('../../../src/contexts/StripeContext', () => ({
  useStripeConfig: () => ({ ensureReady: jest.fn() }),
}));
jest.mock('../../../src/contexts/ThemeContext', () => ({ useTheme: jest.fn() }));
jest.mock('../../../src/contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));

const { getSubscriptionViewModel } = require('../../../src/screens/seller/SellerSubscriptionScreen');
const {
  getSubdomainCooldown,
  resolveSubdomainOwnershipTerms,
  sanitizeSubdomain,
  subdomainOwnershipResponseIsValid,
} = require('../../../src/screens/seller/SellerSubdomainManagementScreen');
const { subdomainAnalyticsResponseIsValid } = require('../../../src/utils/subdomainAnalyticsSafety');

describe('seller subscription presentation', () => {
  const pricing = {
    schemaVersion: 1,
    currency: 'USD',
    starter: {
      plan: 'starter',
      planName: 'Rozare Starter',
      listAmountCents: 1200,
      standardAmountCents: 1000,
      founderAmountCents: 600,
      advertisedDiscountPercent: 16,
      freePeriodDays: 31,
    },
    elite: {
      plan: 'elite',
      planName: 'Rozare Elite',
      listAmountCents: 3200,
      standardAmountCents: 2200,
      founderAmountCents: 1300,
      advertisedDiscountPercent: 31,
      freePeriodDays: 46,
    },
    metaAdsAddonCents: 450,
  };

  test('uses backend prices and active founder eligibility for all plan calculations', () => {
    const view = getSubscriptionViewModel({
      status: 'active',
      plan: 'elite',
      pricing,
      metaAdsIncluded: true,
      founderOffer: { active: true },
    }, false);

    expect(view.isElite).toBe(true);
    expect(view.activeElitePrice).toBe(1750);
    expect(view.selectedElitePrice).toBe(1300);
    expect(view.metaSelectionChanged).toBe(true);
    expect(view.pricingAvailable).toBe(true);
    expect(view.pricing.starter.freePeriodDays).toBe(31);
  });

  test('distinguishes a scheduled downgrade from an ordinary cancellation', () => {
    const downgrade = getSubscriptionViewModel({
      status: 'active',
      plan: 'elite',
      cancelledAt: new Date().toISOString(),
      pendingDowngrade: 'starter',
      pricing,
    });
    expect(downgrade.hasPendingDowngrade).toBe(true);
    expect(downgrade.isEnding).toBe(false);

    const ending = getSubscriptionViewModel({
      status: 'active',
      plan: 'starter',
      cancelledAt: new Date().toISOString(),
      pricing,
    });
    expect(ending.hasPendingDowngrade).toBe(false);
    expect(ending.isEnding).toBe(true);
  });

  test('does not offer another introductory period after it has been used', () => {
    expect(getSubscriptionViewModel({ hasUsedFreePeriod: true }).getsIntroductoryFreePeriod).toBe(false);
    expect(getSubscriptionViewModel({ hasUsedFreePeriod: false }).getsIntroductoryFreePeriod).toBe(true);
  });

  test('fails closed instead of inventing remembered prices when the live catalog is absent or malformed', () => {
    expect(getSubscriptionViewModel({}).pricingAvailable).toBe(false);
    expect(getSubscriptionViewModel({ pricing: { ...pricing, currency: 'PKR' } }).pricingAvailable).toBe(false);
    expect(getSubscriptionViewModel({
      pricing: {
        ...pricing,
        starter: { ...pricing.starter, standardAmountCents: true },
      },
    }).pricingAvailable).toBe(false);
  });
});

describe('seller subdomain rules', () => {
  test.each([
    [' My Fancy Store! ', 'myfancystore'],
    ['---hello---', 'hello'],
    ['hello---world', 'hello-world'],
    ['UPPER_case', 'uppercase'],
  ])('sanitizes %s as %s', (input, expected) => {
    expect(sanitizeSubdomain(input)).toBe(expected);
  });

  test('enforces the same 30-day change cooldown as the backend', () => {
    const now = Date.parse('2026-08-08T00:00:00.000Z');
    const recent = getSubdomainCooldown('2026-07-20T00:00:00.000Z', now);
    expect(recent.canChange).toBe(false);
    expect(recent.daysRemaining).toBe(11);
    expect(recent.nextAllowedAt).toBe('2026-08-19T00:00:00.000Z');

    const elapsed = getSubdomainCooldown('2026-07-01T00:00:00.000Z', now);
    expect(elapsed.canChange).toBe(true);
    expect(elapsed.daysRemaining).toBe(0);
  });

  test('does not block sellers when no valid prior change exists', () => {
    expect(getSubdomainCooldown(null).canChange).toBe(true);
    expect(getSubdomainCooldown('invalid').canChange).toBe(true);
  });

  test('renders the exact backend minor-unit USD ownership price', () => {
    expect(resolveSubdomainOwnershipTerms({
      priceMinor: 1500,
      priceCurrency: 'USD',
      ownershipYears: 3,
    })).toEqual({
      amountMinor: 1500,
      currency: 'USD',
      years: 3,
      priceLabel: '$15.00 USD',
    });
  });

  test('supports the previous exact-major contract but fails closed for malformed terms', () => {
    expect(resolveSubdomainOwnershipTerms({ price: 15, ownershipYears: 3 }))
      .toEqual(expect.objectContaining({ amountMinor: 1500, priceLabel: '$15.00 USD' }));
    expect(resolveSubdomainOwnershipTerms({
      priceMinor: 1500,
      priceCurrency: 'PKR',
      ownershipYears: 3,
    })).toBeNull();
    expect(resolveSubdomainOwnershipTerms({ price: 15.001, ownershipYears: 3 })).toBeNull();
    expect(resolveSubdomainOwnershipTerms({ priceMinor: 1500, priceCurrency: 'USD' })).toBeNull();
  });

  test('requires internally consistent current ownership and analytics before enabling actions', () => {
    const ownership = {
      subdomain: 'my-store', url: 'my-store.rozare.com',
      ownership: {
        isPurchased: true, isOwned: true,
        purchasedAt: '2026-08-01T00:00:00.000Z',
        expiresAt: '2029-08-01T00:00:00.000Z', daysRemaining: 1000,
      },
      priceMinor: 1500, priceCurrency: 'USD', ownershipYears: 3,
    };
    expect(subdomainOwnershipResponseIsValid(ownership)).toBe(true);
    expect(subdomainOwnershipResponseIsValid({
      ...ownership,
      ownership: { ...ownership.ownership, isPurchased: false },
    })).toBe(false);

    const analytics = {
      subdomain: {
        slug: 'my-store', url: 'my-store.rozare.com', isActive: true,
        blocked: false, daysUntilRemoval: null, isPurchased: true,
      },
      analytics: {
        currency: 'PKR', totalViews: 10, totalOrders: 2, totalRevenue: 500.25,
        productCount: 3, trustCount: 4, conversionRate: 20,
        monthlyTraffic: [], trafficHistoryAvailable: false,
      },
    };
    expect(subdomainAnalyticsResponseIsValid(analytics, 'PKR')).toBe(true);
    expect(subdomainAnalyticsResponseIsValid(analytics, 'USD')).toBe(false);
    expect(subdomainAnalyticsResponseIsValid({
      ...analytics,
      analytics: { ...analytics.analytics, totalRevenue: 500.251 },
    }, 'PKR')).toBe(false);
  });
});
