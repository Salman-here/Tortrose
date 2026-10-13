import { exactCurrencyCode, isExactNonNegativeJsonMoney, parseExactMoneyInput } from './sellerMoneySafety.js';

// Both scopes are read-only revenue, never a withdrawal balance. Reject a late
// response for a different account, currency or selected calendar-day window.
export const inspectSellerRevenueOverview = (revenue, sellerId, currency, days = 'all') => {
  const expectedDays = days === 'all' ? null : Number(days);
  if (!sellerId || !exactCurrencyCode(currency) || revenue?.version !== 1 || revenue.sellerId !== sellerId
      || revenue.currency !== currency || revenue.scope !== (expectedDays === null ? 'all_time' : 'period')
      || revenue.onlineEarningsBasis !== 'native_balance_currency'
      || revenue.exchangeRateStatus?.fallback !== false || revenue.exchangeRateStatus?.frozen !== true
      || revenue.period?.days !== expectedDays || revenue.period.timezone !== 'UTC'
      || revenue.period.basis !== 'order_created_at') return null;
  if (expectedDays === null) {
    if (revenue.period.startDate !== null || revenue.period.endDateExclusive !== null) return null;
  } else {
    if (!Number.isSafeInteger(expectedDays) || expectedDays < 1 || expectedDays > 365) return null;
    const start = Date.parse(revenue.period.startDate), end = Date.parse(revenue.period.endDateExclusive);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start !== expectedDays * 86400000
        || new Date(start).toISOString() !== revenue.period.startDate || new Date(end).toISOString() !== revenue.period.endDateExclusive
        || !revenue.period.startDate.endsWith('T00:00:00.000Z') || !revenue.period.endDateExclusive.endsWith('T00:00:00.000Z')) return null;
  }
  const fields = ['codDeliveredRevenue', 'onlineDeliveredRevenue', 'totalDeliveredRevenue',
    'onlinePendingRevenue', 'codPendingRevenue', 'estimatedRevenue', 'onlineGrossEarnings'];
  if (fields.some(field => !isExactNonNegativeJsonMoney(revenue?.[field]))) return null;
  const cents = field => BigInt(parseExactMoneyInput(revenue[field]).minorUnits);
  if (cents('totalDeliveredRevenue') !== cents('onlineDeliveredRevenue') + cents('codDeliveredRevenue')
      || cents('estimatedRevenue') !== cents('totalDeliveredRevenue') + cents('onlinePendingRevenue') + cents('codPendingRevenue')) return null;
  return { sellerId, currency, days: expectedDays, period: revenue.period, onlineGrossEarnings: revenue.onlineGrossEarnings,
    codDeliveredRevenue: revenue.codDeliveredRevenue, totalDeliveredRevenue: revenue.totalDeliveredRevenue, estimatedRevenue: revenue.estimatedRevenue };
};
