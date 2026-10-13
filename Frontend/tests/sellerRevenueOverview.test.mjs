import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import { inspectSellerRevenueOverview } from '../src/utils/sellerRevenueOverview.js';
import { WITHDRAWAL_MINIMUMS } from '../src/utils/nativeBalanceSafety.js';

const response = () => {
  const fields = ['withdrawableBalance', 'onlineDeliveredRevenue', 'onlinePendingRevenue', 'pendingWithdrawalAmount',
    'approvedWithdrawalAmount', 'processingWithdrawalAmount', 'manualReviewWithdrawalAmount', 'totalWithdrawn',
    'returnRefundDebits', 'paymentReversalDebits', 'balanceAdjustmentCredits', 'totalReservedOrWithdrawn', 'deficit', 'paymentRiskHeldAmount'];
  const balances = Object.keys(WITHDRAWAL_MINIMUMS).map(currency => ({
    ...Object.fromEntries(fields.map(field => [field, 0])), currency, minimumWithdrawal: WITHDRAWAL_MINIMUMS[currency],
  }));
  return { sellerId: 'seller-a', accountingVersion: 2, displayCurrency: 'PKR', baseCurrency: 'PKR',
    balances, balanceByCurrency: Object.fromEntries(balances.map(row => [row.currency, { ...row }])),
    exchangeRateStatus: { fallback: false },
    withdrawalLimits: { currency: 'PKR', availableDisplayAmount: 0, minimumDisplayAmount: 2000 },
    displayRevenue: { codDeliveredRevenue: 4000, onlineDeliveredRevenue: 6000, totalDeliveredRevenue: 10000,
      onlinePendingRevenue: 1500, codPendingRevenue: 500, estimatedRevenue: 12000 } };
};

test('moved cards retain exact all-time reporting totals without mutating the payment authority', () => {
  const summary = response(), before = JSON.stringify(summary);
  assert.deepEqual(inspectSellerRevenueOverview(summary, 'seller-a', 'PKR'), {
    sellerId: 'seller-a', currency: 'PKR', codDeliveredRevenue: 4000, totalDeliveredRevenue: 10000, estimatedRevenue: 12000,
  });
  assert.equal(JSON.stringify(summary), before);
});

test('invalid, relabelled, stale-account and inconsistent revenue never becomes displayed zero money', () => {
  const mutations = [s => s.sellerId = 'seller-b', s => s.displayCurrency = 'USD', s => s.baseCurrency = 'USD',
    s => s.exchangeRateStatus.fallback = true, s => s.accountingVersion = 1,
    s => s.balanceByCurrency.PKR.withdrawableBalance = 1,
    s => delete s.displayRevenue.codDeliveredRevenue, s => s.displayRevenue.totalDeliveredRevenue = 9999,
    s => s.displayRevenue.estimatedRevenue = 10000, s => s.displayRevenue.onlineDeliveredRevenue = '6000',
    s => s.displayRevenue.codPendingRevenue = 0.001, s => s.displayRevenue.onlinePendingRevenue = null];
  for (const mutate of mutations) {
    const summary = response(); mutate(summary);
    assert.equal(inspectSellerRevenueOverview(summary, 'seller-a', 'PKR'), null);
  }
  assert.equal(inspectSellerRevenueOverview(response(), '', 'PKR'), null);
  assert.equal(inspectSellerRevenueOverview(response(), 'seller-a', 'JPY'), null);
});

test('web and mobile use identical revenue validation', () => {
  assert.equal(readFileSync(new URL('../src/utils/sellerRevenueOverview.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../MobileApp/src/utils/sellerRevenueOverview.js', import.meta.url), 'utf8'));
});

const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const [key, child] of Object.entries(node)) if (!['comments', 'loc', 'tokens'].includes(key)) {
    if (Array.isArray(child)) child.forEach(item => walk(item, visit));
    else if (child && typeof child === 'object') walk(child, visit);
  }
};

test('Payments hides only the requested cards and retains reversible fee markup and per-order details', () => {
  const sources = [
    readFileSync(new URL('../src/components/layout/SellerPayments.jsx', import.meta.url), 'utf8'),
    readFileSync(new URL('../../MobileApp/src/screens/seller/SellerPaymentsScreen.js', import.meta.url), 'utf8'),
  ];
  for (const source of sources) {
    const labels = [];
    walk(parse(source, { sourceType: 'module', plugins: ['jsx'] }), node => {
      if (node.type === 'JSXAttribute' && node.name.name === 'label' && node.value?.type === 'StringLiteral') labels.push(node.value.value);
    });
    for (const hidden of ['Processing fee + tax', 'Delivered COD Revenue', 'Total Delivered Revenue', 'Estimated Revenue', 'Delivered COD', 'Delivered Total', 'Estimated']) {
      assert.ok(!labels.includes(hidden), `${hidden} is still an active Payments card`);
    }
    assert.match(source, /Fee summary card temporarily hidden/);
    assert.match(source, /label="Processing fee \+ tax"/);
    assert.match(source, /selectedBalance\?\.onlineGrossEarnings/);
    assert.match(source, /selectedBalance\?\.withdrawableBalance/);
  }
  for (const path of ['../src/components/layout/OrderDetail.jsx', '../../MobileApp/src/screens/shared/OrderDetailManagementScreen.js']) {
    assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /Processing fee \+ tax/);
  }
});

test('Analytics uses a separately labelled all-time source, including when charts are unavailable', () => {
  for (const path of ['../src/components/layout/SellerAnalytics.jsx', '../../MobileApp/src/screens/seller/SellerAnalyticsScreen.js']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.equal((source.match(/<SellerRevenueOverview\s*\/>/g) || []).length, 2);
  }
  for (const path of ['../src/components/seller/SellerRevenueOverview.jsx', '../../MobileApp/src/components/seller/SellerRevenueOverview.js']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /All-time revenue/);
    assert.doesNotMatch(source, /days=|timeRange|api\.post|axios\.post|api\.put|axios\.put/);
    assert.match(source, /overview\?\.sellerId === sellerId/);
    for (const title of ['Delivered COD Revenue', 'Total Delivered Revenue', 'Estimated Revenue']) assert.ok(source.includes(title));
  }
});
