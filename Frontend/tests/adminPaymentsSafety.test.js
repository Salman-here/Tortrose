import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adminPaymentsOverviewIsValid,
  REVENUE_COUNT_FIELDS,
  REVENUE_MONEY_FIELDS,
  selectAdminWithdrawalPresentationMoney,
} from '../src/utils/adminPaymentsSafety.js';

const revenue = () => ({
  ...Object.fromEntries(REVENUE_MONEY_FIELDS.map(field => [field, 0])),
  ...Object.fromEntries(REVENUE_COUNT_FIELDS.map(field => [field, 0])),
  stripeDeliveredRevenue: 10,
  onlineDeliveredRevenue: 10,
  totalDeliveredRevenue: 10,
  estimatedRevenue: 10,
  withdrawableBalance: 10,
  deliveredStripeOrders: 1,
  totalRelevantOrders: 1,
});

const withdrawal = () => ({
  _id: 'withdrawal-1',
  status: 'pending',
  amount: 5,
  currency: 'USD',
  requestedAmount: 1400,
  requestedCurrency: 'PKR',
  payoutAmount: 1400,
  payoutCurrency: 'PKR',
  payoutWorkflowVersion: 1,
  payoutWorkflow: { version: 1, attemptCount: 0 },
  payoutAttempts: [],
  paymentAccountSnapshotVersion: 1,
  paymentAccountSnapshot: {
    currency: 'PKR',
    snapshotStatus: 'complete',
    payoutBlocked: false,
  },
});

const overview = () => ({
  success: true,
  summary: revenue(),
  sellers: [{
    seller: { _id: 'seller-1', currency: 'PKR' },
    revenue: revenue(),
    paymentRiskPending: false,
    paymentRiskHoldCount: 0,
  }],
  withdrawals: [withdrawal()],
  errors: [],
});

test('admin payments accept exact reconciled ledger and frozen payout money', () => {
  assert.equal(adminPaymentsOverviewIsValid(overview()), true);
  assert.deepEqual(selectAdminWithdrawalPresentationMoney(withdrawal()), {
    ledger: { amount: 5, currency: 'USD' },
    requested: { amount: 1400, currency: 'PKR' },
    payout: { amount: 1400, currency: 'PKR' },
    showPayout: false,
    legacy: false,
    payoutBlocked: false,
  });
});

test('admin payments reject corrupt, sub-cent, relabelled, or unreconciled money', () => {
  for (const mutate of [
    value => { value.summary.withdrawableBalance = 9.999; },
    value => { value.summary.totalDeliveredRevenue = 9; },
    value => { value.sellers[0].revenue.withdrawableBalance = 9; },
    value => { value.withdrawals[0].amount = ''; },
    value => { value.withdrawals[0].payoutCurrency = 'USD'; },
    value => { value.withdrawals[0].payoutWorkflow.version = '1'; },
    value => { value.withdrawals[0].paymentAccountSnapshot.payoutBlocked = true; },
  ]) {
    const value = overview();
    mutate(value);
    assert.equal(adminPaymentsOverviewIsValid(value), false);
  }
});

test('legacy withdrawals never invent a bank payout amount', () => {
  const request = withdrawal();
  Object.assign(request, {
    requestedAmount: 0,
    payoutAmount: 0,
    payoutWorkflowVersion: 0,
    payoutWorkflow: { version: 0, attemptCount: 0 },
    paymentAccountSnapshotVersion: 0,
    paymentAccountSnapshot: { snapshotStatus: 'missing', payoutBlocked: true },
  });
  assert.deepEqual(selectAdminWithdrawalPresentationMoney(request), {
    ledger: { amount: 5, currency: 'USD' },
    requested: { amount: 5, currency: 'USD' },
    payout: null,
    showPayout: false,
    legacy: true,
    payoutBlocked: true,
  });
});
