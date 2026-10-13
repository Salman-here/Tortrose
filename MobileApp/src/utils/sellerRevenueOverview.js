import { nativeBalancesAreValid } from './nativeBalanceSafety.js';
import { exactCurrencyCode, isExactNonNegativeJsonMoney, parseExactMoneyInput } from './sellerMoneySafety.js';

// Keep the moved cards on the same all-time, frozen-rate reporting authority
// as Payments. They must not become period-filtered or spendable balances.
export const inspectSellerRevenueOverview = (summary, sellerId, currency) => {
  if (!sellerId || !exactCurrencyCode(currency) || summary?.sellerId !== sellerId
      || summary.displayCurrency !== currency || summary.baseCurrency !== currency
      || summary.exchangeRateStatus?.fallback !== false || !nativeBalancesAreValid(summary)) return null;
  const revenue = summary.displayRevenue;
  const fields = ['codDeliveredRevenue', 'onlineDeliveredRevenue', 'totalDeliveredRevenue',
    'onlinePendingRevenue', 'codPendingRevenue', 'estimatedRevenue'];
  if (fields.some(field => !isExactNonNegativeJsonMoney(revenue?.[field]))) return null;
  const cents = field => BigInt(parseExactMoneyInput(revenue[field]).minorUnits);
  if (cents('totalDeliveredRevenue') !== cents('onlineDeliveredRevenue') + cents('codDeliveredRevenue')
      || cents('estimatedRevenue') !== cents('totalDeliveredRevenue') + cents('onlinePendingRevenue') + cents('codPendingRevenue')) return null;
  return { sellerId, currency, codDeliveredRevenue: revenue.codDeliveredRevenue,
    totalDeliveredRevenue: revenue.totalDeliveredRevenue, estimatedRevenue: revenue.estimatedRevenue };
};
