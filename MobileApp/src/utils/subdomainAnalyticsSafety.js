import { currencyCodeIsSupported, roundCurrencyAmount } from './currencySafety';

const count = value => Number.isSafeInteger(value) && value >= 0;
const exactMoney = value => (
  typeof value === 'number'
  && Number.isFinite(value)
  && value >= 0
  && roundCurrencyAmount(value) === value
);

export const subdomainAnalyticsResponseIsValid = (payload, requestedCurrency) => {
  const requested = typeof requestedCurrency === 'string' ? requestedCurrency.trim().toUpperCase() : '';
  const subdomain = payload?.subdomain;
  const analytics = payload?.analytics;
  if (
    !subdomain
    || typeof subdomain.slug !== 'string'
    || !/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/.test(subdomain.slug)
    || subdomain.url !== `${subdomain.slug}.rozare.com`
    || typeof subdomain.isActive !== 'boolean'
    || typeof subdomain.blocked !== 'boolean'
    || typeof subdomain.isPurchased !== 'boolean'
    || !(subdomain.daysUntilRemoval === null || count(subdomain.daysUntilRemoval))
    || !analytics
    || !currencyCodeIsSupported(requested)
    || analytics.currency !== requested
    || !count(analytics.totalViews)
    || !count(analytics.totalOrders)
    || !count(analytics.productCount)
    || !count(analytics.trustCount)
    || !exactMoney(analytics.totalRevenue)
    || (analytics.totalOrders === 0 && analytics.totalRevenue !== 0)
    || typeof analytics.conversionRate !== 'number'
    || !Number.isFinite(analytics.conversionRate)
    || analytics.conversionRate < 0
    || roundCurrencyAmount(analytics.conversionRate) !== analytics.conversionRate
    || typeof analytics.trafficHistoryAvailable !== 'boolean'
    || !Array.isArray(analytics.monthlyTraffic)
    || analytics.monthlyTraffic.some(row => (
      typeof row?.month !== 'string'
      || !row.month.trim()
      || !count(row?.views)
    ))
    || (!analytics.trafficHistoryAvailable && analytics.monthlyTraffic.length > 0)
  ) return false;
  return true;
};
