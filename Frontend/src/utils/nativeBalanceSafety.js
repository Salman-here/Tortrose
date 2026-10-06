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
    for (const field of ['safepayDeliveredRevenue', 'safepayPendingRevenue', 'returnWindowHeldAmount', 'pendingOnlineBalance']) {
      if (Object.prototype.hasOwnProperty.call(balance, field) && !isExactNonNegativeJsonMoney(balance[field])) return false;
    }
    if (balance.minimumWithdrawal !== WITHDRAWAL_MINIMUMS[balance.currency]) return false;
    const lookup = summary.balanceByCurrency?.[balance.currency];
    if (!lookup || lookup.currency !== balance.currency || fields.some(field => lookup[field] !== balance[field])) return false;
    if (['returnWindowHeldAmount', 'pendingOnlineBalance'].some(field => balance[field] !== undefined && lookup[field] !== balance[field])) return false;
    const cents = field => BigInt(parseExactMoneyInput(balance[field]).minorUnits);
    const reserved = ['pendingWithdrawalAmount', 'approvedWithdrawalAmount', 'processingWithdrawalAmount', 'manualReviewWithdrawalAmount', 'totalWithdrawn', 'returnRefundDebits', 'paymentReversalDebits'].reduce((sum, field) => sum + cents(field), 0n);
    if (reserved !== cents('totalReservedOrWithdrawn')) return false;
    const returnHold = balance.returnWindowHeldAmount === undefined ? 0n : cents('returnWindowHeldAmount');
    const net = cents('onlineDeliveredRevenue') + cents('balanceAdjustmentCredits') - reserved - returnHold;
    const feeFields = ['onlineFeeDeductions', 'pendingOnlineFeeDeductions', 'onlineGrossEarnings', 'processingFeeAndTax', 'pendingOnlineNetBalance'];
    const hasFees = feeFields.some(field => balance[field] !== undefined) || summary.deductionPolicy?.version === 1;
    if (hasFees && (feeFields.some(field => balance[field] === undefined) || balance.pendingOnlineBalance === undefined)) return false;
    for (const field of feeFields) {
      if (balance[field] !== undefined && (!isExactNonNegativeJsonMoney(balance[field]) || lookup[field] !== balance[field])) return false;
      if (summary.deductionPolicy?.version === 1 && balance[field] === undefined) return false;
    }
    const fee = balance.onlineFeeDeductions === undefined ? 0n : cents('onlineFeeDeductions');
    const afterFees = net - fee;
    if (balance.processingFeeAndTax !== undefined && cents('processingFeeAndTax') !== fee + cents('pendingOnlineFeeDeductions')) return false;
    if (balance.pendingOnlineNetBalance !== undefined && cents('pendingOnlineNetBalance') !== cents('pendingOnlineBalance') - cents('pendingOnlineFeeDeductions')) return false;
    if (balance.onlineGrossEarnings !== undefined && cents('onlineGrossEarnings') !== (cents('onlineDeliveredRevenue') + cents('onlinePendingRevenue') - cents('returnRefundDebits') - cents('paymentReversalDebits') > 0n
      ? cents('onlineDeliveredRevenue') + cents('onlinePendingRevenue') - cents('returnRefundDebits') - cents('paymentReversalDebits') : 0n)) return false;
    if (balance.pendingOnlineBalance !== undefined && cents('pendingOnlineBalance') !== cents('onlinePendingRevenue') + returnHold) return false;
    if (cents('deficit') !== (afterFees < 0n ? -afterFees : 0n)) return false;
    if (cents('withdrawableBalance') + cents('paymentRiskHeldAmount') !== (afterFees > 0n ? afterFees : 0n)) return false;
    if (balance.withdrawableBalance > 0 && balance.paymentRiskHeldAmount > 0) return false;
  }
  const selected = summary.balanceByCurrency?.[summary.displayCurrency];
  return !!selected && summary.withdrawalLimits?.availableDisplayAmount === selected.withdrawableBalance
    && summary.withdrawalLimits?.minimumDisplayAmount === selected.minimumWithdrawal
    && summary.withdrawalLimits?.currency === summary.displayCurrency;
};
