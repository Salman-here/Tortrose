import { subdomainAnalyticsResponseIsValid } from '../../src/utils/subdomainAnalyticsSafety';

const payload = () => ({
  subdomain: { slug: 'test-store', url: 'test-store.rozare.com', isActive: true, blocked: false, daysUntilRemoval: null, isPurchased: true },
  analytics: {
    currency: 'USD', totalViews: 3, totalOrders: 7, totalRevenue: 238.46,
    productCount: 5, trustCount: 0, monthlyTraffic: [], trafficHistoryAvailable: false,
    conversionRate: null, conversionRateAvailable: false,
    conversionRateReason: 'VISIT_CHECKOUT_ATTRIBUTION_UNAVAILABLE',
  },
});

test('unmeasured conversion is accepted only with an explicit unavailable contract', () => {
  expect(subdomainAnalyticsResponseIsValid(payload(), 'USD')).toBe(true);
  const inconsistent = payload();
  inconsistent.analytics.conversionRateAvailable = true;
  expect(subdomainAnalyticsResponseIsValid(inconsistent, 'USD')).toBe(false);
});

test('nullable conversion does not relax currency, counts or exact-money verification', () => {
  const badMoney = payload();
  badMoney.analytics.totalRevenue = 238.461;
  expect(subdomainAnalyticsResponseIsValid(badMoney, 'USD')).toBe(false);
  expect(subdomainAnalyticsResponseIsValid(payload(), 'PKR')).toBe(false);
});

test('older numeric ratios stay readable during rollout, without deriving a new conversion rate', () => {
  const legacy = payload();
  delete legacy.analytics.conversionRateAvailable;
  delete legacy.analytics.conversionRateReason;
  legacy.analytics.conversionRate = 233.33;
  expect(subdomainAnalyticsResponseIsValid(legacy, 'USD')).toBe(true);
});
