import { isExactNonNegativeJsonMoney, exactCurrencyCode, parseExactMoneyInput } from './sellerMoneySafety.js';
export const WITHDRAWAL_MINIMUMS = Object.freeze({ USD: 5, PKR: 2000, EUR: 5, GBP: 5 });
export const nativeBalancesAreValid = summary => {
  if (summary?.accountingVersion !== 2 || !Array.isArray(summary.balances) || summary.balances.length !== 4) return false;
  const fields = ['withdrawableBalance', 'onlineDeliveredRevenue', 'onlinePendingRevenue', 'pendingWithdrawalAmount',
    'approvedWithdrawalAmount', 'processingWithdrawalAmount', 'manualReviewWithdrawalAmount', 'totalWithdrawn',
    'returnRefundDebits', 'paymentReversalDebits', 'balanceAdjustmentCredits', 'totalReservedOrWithdrawn', 'deficit', 'paymentRiskHeldAmount', 'minimumWithdrawal'];
  const codes = summary.balances.map(balance => balance.currency);
  if (new Set(codes).size !== 4 || codes.some(code => !exactCurrencyCode(code))) return false;
  for (const balance of summary.balances) {
    if (fields.some(field => !isExactNonNegativeJsonMoney(balance[field]))) return false;
    if (balance.minimumWithdrawal !== WITHDRAWAL_MINIMUMS[balance.currency]) return false;
    const lookup = summary.balanceByCurrency?.[balance.currency];
    if (!lookup || lookup.currency !== balance.currency || fields.some(field => lookup[field] !== balance[field])) return false;
    const cents = field => BigInt(parseExactMoneyInput(balance[field]).minorUnits);
    const reserved = ['pendingWithdrawalAmount', 'approvedWithdrawalAmount', 'processingWithdrawalAmount', 'manualReviewWithdrawalAmount', 'totalWithdrawn', 'returnRefundDebits', 'paymentReversalDebits'].reduce((sum, field) => sum + cents(field), 0n);
    if (reserved !== cents('totalReservedOrWithdrawn')) return false;
    const net = cents('onlineDeliveredRevenue') + cents('balanceAdjustmentCredits') - reserved;
    if (cents('deficit') !== (net < 0n ? -net : 0n)) return false;
    if (cents('withdrawableBalance') + cents('paymentRiskHeldAmount') !== (net > 0n ? net : 0n)) return false;
    if (balance.withdrawableBalance > 0 && balance.paymentRiskHeldAmount > 0) return false;
  }
  const selected = summary.balanceByCurrency?.[summary.displayCurrency];
  return !!selected && summary.withdrawalLimits?.availableDisplayAmount === selected.withdrawableBalance
    && summary.withdrawalLimits?.minimumDisplayAmount === selected.minimumWithdrawal
    && summary.withdrawalLimits?.currency === summary.displayCurrency;
};
