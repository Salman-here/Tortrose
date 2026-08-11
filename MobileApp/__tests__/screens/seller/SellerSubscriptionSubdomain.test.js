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
jest.mock('../../../src/contexts/ThemeContext', () => ({ useTheme: jest.fn() }));
jest.mock('../../../src/contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));

const { getSubscriptionViewModel } = require('../../../src/screens/seller/SellerSubscriptionScreen');
const {
  getSubdomainCooldown,
  sanitizeSubdomain,
} = require('../../../src/screens/seller/SellerSubdomainManagementScreen');

describe('seller subscription presentation', () => {
  const pricing = {
    starter: { listAmountCents: 1200, standardAmountCents: 1000, founderAmountCents: 600 },
    elite: { listAmountCents: 3200, standardAmountCents: 2200, founderAmountCents: 1300 },
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
});
