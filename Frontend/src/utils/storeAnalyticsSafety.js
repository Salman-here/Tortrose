import {
  roundCurrencyAmount,
  selectAuthoritativeSellerMetrics,
} from './currencySafety.js';

const count = value => Number.isSafeInteger(value) && value >= 0;

export const selectAuthoritativeStoreAnalytics = (analytics, requestedCurrency) => {
  const moneyMetrics = selectAuthoritativeSellerMetrics(analytics, requestedCurrency);
  if (
    moneyMetrics === null
    || !count(analytics?.views)
    || !count(analytics?.productCount)
    || !count(analytics?.trustCount)
    || roundCurrencyAmount(moneyMetrics.totalSales) !== moneyMetrics.totalSales
  ) return null;

  return {
    currency: String(analytics.currency),
    views: analytics.views,
    productCount: analytics.productCount,
    trustCount: analytics.trustCount,
    totalOrders: moneyMetrics.totalOrders,
    totalSales: moneyMetrics.totalSales,
  };
};
