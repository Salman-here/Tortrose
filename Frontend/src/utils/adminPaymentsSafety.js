import {
  exactCurrencyCode,
  isExactNonNegativeJsonMoney,
  isExactPositiveJsonMoney,
  parseExactMoneyInput,
  selectWithdrawalHistoryMoney,
} from './sellerMoneySafety.js';

const REVENUE_MONEY_FIELDS = [
  'stripeDeliveredRevenue', 'stripePendingRevenue',
  'walletDeliveredRevenue', 'walletPendingRevenue',
  'codDeliveredRevenue', 'codPendingRevenue',
  'onlineDeliveredRevenue', 'onlinePendingRevenue',
  'totalDeliveredRevenue', 'estimatedRevenue',
  'withdrawableBalance', 'paymentRiskHeldAmount',
  'pendingWithdrawalAmount', 'approvedWithdrawalAmount',
  'processingWithdrawalAmount', 'manualReviewWithdrawalAmount',
  'totalWithdrawn', 'totalReservedOrWithdrawn',
  'returnRefundDebits', 'paymentReversalDebits',
];
const REVENUE_COUNT_FIELDS = [
  'deliveredStripeOrders', 'pendingStripeOrders',
  'deliveredWalletOrders', 'pendingWalletOrders',
  'deliveredCodOrders', 'pendingCodOrders', 'totalRelevantOrders',
];
const WITHDRAWAL_STATUSES = new Set([
  'pending', 'approved', 'processing', 'manual_review',
  'paid', 'failed', 'rejected', 'cancelled',
]);

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const idString = value => typeof value === 'string' && value.trim() === value && value.length > 0;
const minorUnits = value => parseExactMoneyInput(value)?.minorUnits ?? null;
const sumMinor = values => {
  let total = 0n;
  for (const value of values) {
    const minor = minorUnits(value);
    if (minor === null) return null;
    total += BigInt(minor);
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  }
  return Number(total);
};
const sameMoney = (value, fields) => {
  const expected = minorUnits(value);
  const actual = sumMinor(fields);
  return expected !== null && actual !== null && expected === actual;
};

const revenueSummaryIsValid = summary => {
  if (!isObject(summary)) return false;
  if (REVENUE_MONEY_FIELDS.some(field => !isExactNonNegativeJsonMoney(summary[field]))) return false;
  if (REVENUE_COUNT_FIELDS.some(field => !isCount(summary[field]))) return false;
  return sameMoney(summary.onlineDeliveredRevenue, [
    summary.stripeDeliveredRevenue,
    summary.walletDeliveredRevenue,
  ]) && sameMoney(summary.onlinePendingRevenue, [
    summary.stripePendingRevenue,
    summary.walletPendingRevenue,
  ]) && sameMoney(summary.totalDeliveredRevenue, [
    summary.onlineDeliveredRevenue,
    summary.codDeliveredRevenue,
  ]) && sameMoney(summary.estimatedRevenue, [
    summary.totalDeliveredRevenue,
    summary.onlinePendingRevenue,
    summary.codPendingRevenue,
  ]);
};

export const selectAdminWithdrawalPresentationMoney = request => {
  if (!isObject(request)) return null;
  const workflowVersion = request.payoutWorkflowVersion;
  if (
    ![0, 1].includes(workflowVersion)
    || request.payoutWorkflow?.version !== workflowVersion
    || request.currency !== 'USD'
    || !isExactPositiveJsonMoney(request.amount)
    || request.amount < 5
    || !WITHDRAWAL_STATUSES.has(request.status)
  ) return null;

  const money = selectWithdrawalHistoryMoney(request);
  if (money.status === 'unavailable' || !money.requested) return null;
  if (workflowVersion === 1 && (money.status !== 'complete' || !money.payout)) return null;

  const snapshotVersion = request.paymentAccountSnapshotVersion;
  const snapshot = request.paymentAccountSnapshot;
  if (![0, 1].includes(snapshotVersion) || !isObject(snapshot)) return null;
  if (!['complete', 'missing', 'unreadable'].includes(snapshot.snapshotStatus)) return null;
  if (snapshot.payoutBlocked !== (snapshot.snapshotStatus !== 'complete')) return null;
  if (snapshot.snapshotStatus === 'complete') {
    if (
      snapshotVersion !== 1
      || exactCurrencyCode(snapshot.currency) !== money.payout?.currency
    ) return null;
  }

  const attempts = request.payoutAttempts;
  if (!Array.isArray(attempts) || !isCount(request.payoutWorkflow?.attemptCount)) return null;
  if (request.payoutWorkflow.attemptCount !== attempts.length) return null;
  const attemptIds = attempts.map(attempt => attempt?.attemptId);
  if (attemptIds.some(id => !idString(id)) || new Set(attemptIds).size !== attemptIds.length) return null;
  if (request.activePayoutAttemptId && !attemptIds.includes(request.activePayoutAttemptId)) return null;

  return {
    ledger: { amount: request.amount, currency: 'USD' },
    requested: money.requested,
    payout: money.payout,
    showPayout: money.showPayout,
    legacy: workflowVersion === 0,
    payoutBlocked: snapshot.payoutBlocked,
  };
};

export const adminPaymentsOverviewIsValid = overview => {
  if (
    !isObject(overview)
    || overview.success !== true
    || !Array.isArray(overview.sellers)
    || !Array.isArray(overview.withdrawals)
    || !Array.isArray(overview.errors)
    || overview.errors.length !== 0
    || !revenueSummaryIsValid(overview.summary)
  ) return false;

  const sellerIds = new Set();
  for (const row of overview.sellers) {
    const sellerId = String(row?.seller?._id || '');
    if (!sellerId || sellerIds.has(sellerId) || !revenueSummaryIsValid(row?.revenue)) return false;
    sellerIds.add(sellerId);
    if (
      exactCurrencyCode(row.seller.currency) === null
      || typeof row.paymentRiskPending !== 'boolean'
      || !isCount(row.paymentRiskHoldCount)
      || row.paymentRiskPending !== (row.paymentRiskHoldCount > 0)
    ) return false;
  }

  for (const field of REVENUE_MONEY_FIELDS) {
    if (minorUnits(overview.summary[field]) !== sumMinor(overview.sellers.map(row => row.revenue[field]))) return false;
  }
  for (const field of REVENUE_COUNT_FIELDS) {
    const total = overview.sellers.reduce((sum, row) => sum + row.revenue[field], 0);
    if (!Number.isSafeInteger(total) || overview.summary[field] !== total) return false;
  }

  const withdrawalIds = new Set();
  for (const request of overview.withdrawals) {
    const id = String(request?._id || '');
    if (!id || withdrawalIds.has(id) || selectAdminWithdrawalPresentationMoney(request) === null) return false;
    withdrawalIds.add(id);
  }
  return true;
};

export { REVENUE_COUNT_FIELDS, REVENUE_MONEY_FIELDS };
