import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  canTopUpWalletCurrency,
  findWalletTransaction,
  getTopUpCompletionBreakdown,
  getWalletCreditCompletionBreakdown,
  getWalletCurrencyRisk,
  inspectWalletSummaryResponse,
  inspectWalletTopUpCreateResponse,
  inspectWalletTopUpStatusResponse,
  requireWalletSummaryResponse,
} from '../src/utils/walletPaymentRisk.js';

const transaction = (overrides = {}) => ({
  _id: '507f1f77bcf86cd799439012',
  type: 'top_up',
  direction: 'credit',
  status: 'completed',
  amount: 12.34,
  currency: 'PKR',
  balanceAfter: 2.34,
  description: 'Rozare Wallet top-up of PKR 12.34',
  referenceType: 'stripe_checkout',
  failureReason: '',
  completedAt: '2026-08-25T10:00:00.000Z',
  createdAt: '2026-08-25T09:59:00.000Z',
  updatedAt: '2026-08-25T10:00:00.000Z',
  creditedAmount: 2.34,
  appliedToLiability: 10,
  remainingLiability: 0,
  ...overrides,
});

const summary = (overrides = {}) => ({
  success: true,
  wallet: {
    _id: '507f1f77bcf86cd799439011',
    balances: { USD: 1.01, PKR: 2.34, EUR: 3.21, GBP: 4.56 },
    status: 'active',
    lockedReason: '',
    lockSource: null,
    updatedAt: '2026-08-25T10:00:00.000Z',
    paymentRisk: {
      restricted: false,
      provisionalCount: 0,
      byCurrency: {},
      canTopUpForSettlement: false,
    },
  },
  transactions: [transaction()],
  ...overrides,
});

const clone = value => structuredClone(value);

test('web wallet risk presentation accepts only exact canonical currencies and compatible minor units', () => {
  const exact = {
    status: 'locked',
    paymentRisk: {
      canTopUpForSettlement: true,
      byCurrency: { PKR: { outstandingMinor: 1234, outstanding: 12.34 } },
    },
  };
  assert.deepEqual(getWalletCurrencyRisk(exact, 'PKR'), { held: null, outstanding: 12.34 });
  assert.equal(canTopUpWalletCurrency(exact, 'PKR'), true);
  assert.deepEqual(getWalletCurrencyRisk(exact, 'pkr'), { held: null, outstanding: null });
  assert.equal(canTopUpWalletCurrency(exact, 'pkr'), false);

  const collided = clone(exact);
  collided.paymentRisk.byCurrency.PKR.outstandingMinor = 7036874417766401;
  assert.equal(getWalletCurrencyRisk(collided, 'PKR').outstanding, null);
  assert.equal(canTopUpWalletCurrency(collided, 'PKR'), false);
});

test('web wallet credit breakdown conserves exact minor units and supports intercepted refunds', () => {
  const topUp = transaction();
  assert.deepEqual(getTopUpCompletionBreakdown(topUp), {
    creditedAmount: 2.34,
    appliedToLiability: 10,
    remainingLiability: 0,
    currency: 'PKR',
  });
  assert.deepEqual(getWalletCreditCompletionBreakdown(transaction({
    type: 'return_refund',
    referenceType: 'return_request',
  })), {
    creditedAmount: 2.34,
    appliedToLiability: 10,
    remainingLiability: 0,
    currency: 'PKR',
  });
  assert.equal(getTopUpCompletionBreakdown(transaction({ currency: 'pkr' })), null);
  assert.equal(getTopUpCompletionBreakdown(transaction({
    amount: 70368744177664.02,
    creditedAmount: 70368744177664.02,
    appliedToLiability: 0,
  })), null);
  assert.equal(getTopUpCompletionBreakdown(transaction({
    creditedAmount: 0,
    appliedToLiability: 0,
    remainingLiability: 0,
  })), null, 'a legacy missing breakdown is unavailable rather than fabricated');
});

test('wallet summary accepts complete exact multi-currency balances and transaction allocations', () => {
  const inspected = inspectWalletSummaryResponse(summary());
  assert.equal(inspected.valid, true, inspected.errors.join(', '));
  assert.deepEqual(inspected.wallet.balances, { USD: 1.01, PKR: 2.34, EUR: 3.21, GBP: 4.56 });
  assert.equal(inspected.transactions[0].currency, 'PKR');
  assert.equal(requireWalletSummaryResponse(summary()).transactions.length, 1);
  assert.equal(findWalletTransaction(summary(), '507f1f77bcf86cd799439012')?.amount, 12.34);
});

test('wallet summary rejects missing, coerced, sub-cent, unsafe, and relabelled financial data', () => {
  const corruptions = [
    value => { delete value.wallet.balances.USD; },
    value => { value.wallet.balances.PKR = '2.34'; },
    value => { value.wallet.balances.EUR = 3.211; },
    value => { value.wallet.balances.GBP = -0; },
    value => { value.wallet.balances.CAD = 1; },
    value => { value.transactions[0].amount = '12.34'; },
    value => { value.transactions[0].amount = 12.341; },
    value => { value.transactions[0].currency = 'pkr'; },
    value => { value.transactions[0].balanceAfter = undefined; },
    value => { value.transactions[0].creditedAmount = 2.33; },
    value => { value.transactions[0].createdAt = 'not-a-date'; },
    value => { value.transactions.push(clone(value.transactions[0])); },
  ];
  for (const mutate of corruptions) {
    const value = clone(summary());
    mutate(value);
    const inspected = inspectWalletSummaryResponse(value);
    assert.equal(inspected.valid, false, JSON.stringify(value));
    assert.equal(inspected.wallet, null);
    assert.deepEqual(inspected.transactions, []);
    assert.throws(() => requireWalletSummaryResponse(value), /could not be verified/i);
  }
});

test('wallet summary rejects collided or internally conflicting payment-risk money', () => {
  const locked = summary();
  locked.wallet.status = 'locked';
  locked.wallet.lockedReason = 'Stripe payment-risk liability is outstanding.';
  locked.wallet.lockSource = 'payment_risk';
  locked.wallet.paymentRisk = {
    restricted: true,
    provisionalCount: 0,
    canTopUpForSettlement: true,
    byCurrency: {
      PKR: { heldMinor: 0, outstandingMinor: 1234, held: 0, outstanding: 12.34 },
    },
  };
  assert.equal(inspectWalletSummaryResponse(locked).valid, true);

  const corruptions = [
    value => { value.wallet.paymentRisk.byCurrency.PKR.outstanding = 12.35; },
    value => { value.wallet.paymentRisk.byCurrency.PKR.outstandingMinor = 7036874417766401; },
    value => { value.wallet.paymentRisk.byCurrency.pkr = value.wallet.paymentRisk.byCurrency.PKR; delete value.wallet.paymentRisk.byCurrency.PKR; },
    value => { value.wallet.paymentRisk.canTopUpForSettlement = 'true'; },
    value => { value.wallet.status = 'active'; },
    value => { value.wallet.paymentRisk.restricted = false; },
  ];
  for (const mutate of corruptions) {
    const value = clone(locked);
    mutate(value);
    assert.equal(inspectWalletSummaryResponse(value).valid, false);
  }
});

test('wallet top-up creation response must match the exact request and a safe authoritative state', () => {
  const redirect = {
    success: true,
    url: 'https://checkout.stripe.com/c/pay/test',
    transactionId: '507f1f77bcf86cd799439012',
    topUpId: '507f1f77bcf86cd799439012',
    transaction: transaction({
      status: 'pending',
      balanceAfter: null,
      completedAt: null,
      creditedAmount: 0,
      appliedToLiability: 0,
      remainingLiability: 0,
    }),
  };
  const inspected = inspectWalletTopUpCreateResponse(redirect, { amount: 12.34, currency: 'PKR' });
  assert.equal(inspected.valid, true, inspected.errors.join(', '));
  assert.equal(inspected.kind, 'redirect');
  assert.match(inspected.redirectUrl, /^https:\/\/checkout\.stripe\.com/);

  for (const mutate of [
    value => { value.topUpId = '507f1f77bcf86cd799439013'; },
    value => { value.transaction.amount = '12.34'; },
    value => { value.transaction.currency = 'USD'; },
    value => { value.url = 'http://checkout.stripe.com/c/pay/test'; },
    value => { value.completed = true; },
  ]) {
    const value = clone(redirect);
    mutate(value);
    assert.equal(
      inspectWalletTopUpCreateResponse(value, { amount: 12.34, currency: 'PKR' }).valid,
      false,
    );
  }
});

test('wallet top-up status validates the included wallet snapshot and exact transaction money', () => {
  const payload = {
    ...summary(),
    transactionId: '507f1f77bcf86cd799439012',
    status: 'completed',
    amount: 12.34,
    currency: 'PKR',
    webhookProcessed: true,
    stripePaymentReceived: true,
    walletBalanceAfter: 2.34,
    failureReason: '',
  };
  const inspected = inspectWalletTopUpStatusResponse(payload, payload.transactionId);
  assert.equal(inspected.valid, true, inspected.errors.join(', '));
  assert.equal(inspected.transaction.amount, 12.34);

  for (const mutate of [
    value => { value.amount = 12.35; },
    value => { value.currency = 'USD'; },
    value => { value.walletBalanceAfter = 2.35; },
    value => { value.webhookProcessed = 'true'; },
    value => { value.wallet.balances.PKR = '2.34'; },
    value => { value.transactionId = '507f1f77bcf86cd799439013'; },
  ]) {
    const value = clone(payload);
    mutate(value);
    assert.equal(inspectWalletTopUpStatusResponse(value, payload.transactionId).valid, false);
  }
});

test('wallet top-up status preserves a partial liability settlement without inventing available balance', () => {
  const partialTransaction = transaction({
    amount: 10,
    balanceAfter: 0,
    creditedAmount: 0,
    appliedToLiability: 10,
    remainingLiability: 5,
  });
  const partial = summary({ transactions: [partialTransaction] });
  partial.wallet.status = 'locked';
  partial.wallet.lockedReason = 'Stripe payment-risk liability is outstanding.';
  partial.wallet.lockSource = 'payment_risk';
  partial.wallet.balances.PKR = 0;
  partial.wallet.paymentRisk = {
    restricted: true,
    provisionalCount: 0,
    canTopUpForSettlement: true,
    byCurrency: {
      PKR: { heldMinor: 0, outstandingMinor: 500, held: 0, outstanding: 5 },
    },
  };
  Object.assign(partial, {
    transactionId: partialTransaction._id,
    status: 'completed',
    amount: 10,
    currency: 'PKR',
    webhookProcessed: true,
    stripePaymentReceived: true,
    walletBalanceAfter: 0,
    failureReason: '',
  });

  const inspected = inspectWalletTopUpStatusResponse(partial, partialTransaction._id);
  assert.equal(inspected.valid, true, inspected.errors.join(', '));
  assert.deepEqual(getTopUpCompletionBreakdown(inspected.transaction), {
    creditedAmount: 0,
    appliedToLiability: 10,
    remainingLiability: 5,
    currency: 'PKR',
  });
});

test('Wallet component routes all fetched money through validation and contains no zero-success fallback', () => {
  const source = readFileSync(new URL('../src/components/layout/Wallet.jsx', import.meta.url), 'utf8');
  assert.match(source, /requireWalletSummaryResponse\(response\.data\)/);
  assert.match(source, /inspectWalletTopUpStatusResponse\(response\.data, transactionId\)/);
  assert.match(source, /setWallet\(null\);[\s\S]*?setTransactions\(\[\]\);/);
  assert.match(source, /Wallet financial data is unavailable/);
  assert.doesNotMatch(source, /wallet\?\.balances\?\.\[code\]\s*\?\?\s*0/);
  assert.doesNotMatch(source, /setWallet\(response\.data\?\.wallet\s*\|\|\s*null\)/);
  assert.doesNotMatch(source, /setTransactions\(response\.data\?\.transactions\s*\|\|\s*\[\]\)/);
});
