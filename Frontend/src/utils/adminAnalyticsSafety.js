import {
  addCurrencyAmounts,
  responseCurrencyMatchesRequest,
  roundCurrencyAmount,
} from './currencySafety.js';

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isSignedInteger = value => Number.isSafeInteger(value);
const isMoney = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
  try {
    return roundCurrencyAmount(value) === value;
  } catch (_error) {
    return false;
  }
};
const sumCounts = values => {
  let total = 0;
  for (const value of values) {
    if (!isCount(value)) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
};
const sumMoney = values => {
  try {
    return addCurrencyAmounts(...values);
  } catch (_error) {
    return null;
  }
};
const uniqueNamedCounts = (rows, { positive = false } = {}) => (
  Array.isArray(rows)
  && new Set(rows.map(row => row?.name)).size === rows.length
  && rows.every(row => (
    typeof row?.name === 'string'
    && row.name.trim() === row.name
    && row.name.length > 0
    && isCount(row.value ?? row.count)
    && (!positive || (row.value ?? row.count) > 0)
  ))
);

export const adminAnalyticsResponseIsValid = (analytics, requestedCurrency) => {
  if (!isObject(analytics) || !responseCurrencyMatchesRequest(analytics.currency, requestedCurrency)) return false;
  const summary = analytics.summary;
  if (!isObject(summary)) return false;

  const moneyFields = ['totalRevenue', 'avgOrderValue'];
  const countFields = [
    'totalOrders', 'totalUnitsSold', 'totalStores', 'verifiedStores',
    'pendingVerification', 'newStoresInPeriod', 'brandCount', 'storeCount',
    'newBrandsInPeriod', 'newStoresOnlyInPeriod', 'totalUsers', 'totalSellers',
    'totalProducts', 'outOfStock',
  ];
  const changeFields = ['revenueChange', 'ordersChange', 'avgChange', 'storesChange'];
  if (
    moneyFields.some(field => !isMoney(summary[field]))
    || countFields.some(field => !isCount(summary[field]))
    || changeFields.some(field => !isSignedInteger(summary[field]))
  ) return false;

  if (
    summary.brandCount + summary.storeCount !== summary.totalStores
    || summary.newBrandsInPeriod + summary.newStoresOnlyInPeriod !== summary.newStoresInPeriod
    || summary.verifiedStores > summary.totalStores
    || summary.pendingVerification > summary.totalStores
    || summary.totalSellers > summary.totalUsers
    || summary.outOfStock > summary.totalProducts
  ) return false;

  if (!Array.isArray(analytics.revenueByDay) || analytics.revenueByDay.some(row => (
    !isObject(row)
    || typeof row.date !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/u.test(row.date)
    || Number.isNaN(new Date(`${row.date}T00:00:00.000Z`).getTime())
    || !isMoney(row.revenue)
    || !isCount(row.orders)
    || !isCount(row.newUsers)
  ))) return false;
  if (new Set(analytics.revenueByDay.map(row => row.date)).size !== analytics.revenueByDay.length) return false;
  if (sumMoney(analytics.revenueByDay.map(row => row.revenue)) !== summary.totalRevenue) return false;

  if (!Array.isArray(analytics.topStores) || analytics.topStores.some(row => (
    !isObject(row)
    || !isMoney(row.revenue)
    || !isCount(row.orders)
    || !isCount(row.productCount)
    || !isCount(row.trustCount)
  ))) return false;
  if (!Array.isArray(analytics.topProducts) || analytics.topProducts.some(row => (
    !isObject(row) || !isMoney(row.revenue) || !isCount(row.sold)
  ))) return false;
  const topStoreRevenue = sumMoney(analytics.topStores.map(row => row.revenue));
  const topProductRevenue = sumMoney(analytics.topProducts.map(row => row.revenue));
  if (
    topStoreRevenue === null
    || topProductRevenue === null
    || topStoreRevenue > summary.totalRevenue
    || topProductRevenue > summary.totalRevenue
  ) return false;

  if (
    !uniqueNamedCounts(analytics.roleBreakdown)
    || !uniqueNamedCounts(analytics.statusBreakdown, { positive: true })
    || !uniqueNamedCounts(analytics.categoryBreakdown, { positive: true })
  ) return false;
  if (sumCounts(analytics.roleBreakdown.map(row => row.value)) !== summary.totalUsers) return false;
  if (sumCounts(analytics.statusBreakdown.map(row => row.value)) !== summary.totalOrders) return false;
  const categoryTotal = sumCounts(analytics.categoryBreakdown.map(row => row.count));
  if (categoryTotal === null || categoryTotal > summary.totalProducts) return false;

  return true;
};
