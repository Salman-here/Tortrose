import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import { inspectSellerRevenueOverview } from '../src/utils/sellerRevenueOverview.js';

const response = () => {
  return { sellerId: 'seller-a', version: 1, currency: 'PKR', scope: 'all_time',
    period: { days: null, startDate: null, endDateExclusive: null, timezone: 'UTC', basis: 'order_created_at' },
    exchangeRateStatus: { fallback: false, frozen: true }, onlineEarningsBasis: 'native_balance_currency', onlineGrossEarnings: 6000,
    codDeliveredRevenue: 4000, onlineDeliveredRevenue: 6000, totalDeliveredRevenue: 10000,
    onlinePendingRevenue: 1500, codPendingRevenue: 500, estimatedRevenue: 12000 };
};

test('moved cards retain exact all-time reporting totals without mutating the payment authority', () => {
  const summary = response(), before = JSON.stringify(summary);
  assert.deepEqual(inspectSellerRevenueOverview(summary, 'seller-a', 'PKR'), {
    sellerId: 'seller-a', currency: 'PKR', days: null, period: summary.period, onlineGrossEarnings: 6000,
    codDeliveredRevenue: 4000, totalDeliveredRevenue: 10000, estimatedRevenue: 12000,
  });
  assert.equal(JSON.stringify(summary), before);
});

test('invalid, relabelled, stale-account and inconsistent revenue never becomes displayed zero money', () => {
  const mutations = [s => s.sellerId = 'seller-b', s => s.currency = 'USD', s => s.version = 2,
    s => s.exchangeRateStatus.fallback = true, s => s.exchangeRateStatus.frozen = false,
    s => s.onlineEarningsBasis = 'converted_balances', s => delete s.onlineGrossEarnings,
    s => delete s.codDeliveredRevenue, s => s.totalDeliveredRevenue = 9999,
    s => s.estimatedRevenue = 10000, s => s.onlineDeliveredRevenue = '6000',
    s => s.codPendingRevenue = 0.001, s => s.onlinePendingRevenue = null];
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
    assert.doesNotMatch(source, /selectedBalance\?\.onlineGrossEarnings/);
    assert.match(source, /selectedBalance\?\.withdrawableBalance/);
  }
  for (const path of ['../src/components/layout/OrderDetail.jsx', '../../MobileApp/src/screens/shared/OrderDetailManagementScreen.js']) {
    assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /Processing fee \+ tax/);
  }
});

test('Analytics uses a separately labelled all-time source, including when charts are unavailable', () => {
  for (const path of ['../src/components/layout/SellerAnalytics.jsx', '../../MobileApp/src/screens/seller/SellerAnalyticsScreen.js']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /<SellerRevenueOverview(?:\s+refreshKey=\{revenueRefreshKey\})?\s*\/>/);
    assert.match(source, /<SellerRevenueOverview days=\{timeRange\}/);
    assert.ok(source.indexOf('<SellerRevenueOverview') < source.indexOf('Analytics date filter'));
  }
  for (const path of ['../src/components/seller/SellerRevenueOverview.jsx', '../../MobileApp/src/components/seller/SellerRevenueOverview.js']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /All-time revenue/);
    assert.doesNotMatch(source, /api\.post|axios\.post|api\.put|axios\.put/);
    assert.match(source, /revenue-overview\?currency=/);
    assert.match(source, /overview\?\.sellerId === sellerId/);
    for (const title of ['Delivered COD Revenue', 'Total Delivered Revenue', 'Estimated Revenue']) assert.ok(source.includes(title));
  }
});

test('Payments no longer renders delivered gateway breakdown rows on either surface', () => {
  for (const path of ['../src/components/layout/SellerPayments.jsx', '../../MobileApp/src/screens/seller/SellerPaymentsScreen.js']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const strings = [];
    walk(parse(source, { sourceType: 'module', plugins: ['jsx'] }), node => {
      if (node.type === 'StringLiteral') strings.push(node.value);
    });
    for (const removed of ['Safepay delivered revenue', 'Wallet delivered revenue']) {
      assert.ok(!strings.includes(removed), `${removed} must not render in Payments`);
    }
    for (const retained of ['Pending withdrawals', 'Held for returns']) {
      assert.ok(strings.includes(retained), `${retained} must remain in Payments`);
    }
    assert.match(source, /selectedBalance\?\.withdrawableBalance/);
  }
  for (const path of ['../src/components/seller/SellerRevenueOverview.jsx', '../../MobileApp/src/components/seller/SellerRevenueOverview.js']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /Total Online Earnings/);
    assert.match(source, /onlineGrossEarnings/);
  }
});

test('Payments hides the requested detail rows reversibly on web and mobile without changing money validation', () => {
  const hidden = ['Pending online estimate', 'Return refunds & holds', 'Processing withdrawals'];
  for (const path of ['../src/components/layout/SellerPayments.jsx', '../../MobileApp/src/screens/seller/SellerPaymentsScreen.js']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const strings = [];
    walk(parse(source, { sourceType: 'module', plugins: ['jsx'] }), node => {
      if (node.type === 'StringLiteral') strings.push(node.value);
    });
    assert.match(source, /Temporarily hidden balance-detail rows/);
    for (const label of hidden) {
      assert.ok(!strings.includes(label), `${label} must not render in Payments`);
      assert.ok(source.split('\n').some(line => line.trimStart().startsWith(`// ['${label}',`)), `${label} must remain commented out for restoration`);
    }
    for (const retained of ['Pending withdrawals', 'Held for returns', 'Pending COD estimate']) {
      assert.ok(strings.includes(retained), `${retained} must remain in Payments`);
    }
    assert.match(source, /nativeBalancesAreValid\((?:next|res\.data)\)/);
    assert.match(source, /selectedBalance\?\.withdrawableBalance/);
  }
  for (const path of ['../src/utils/nativeBalanceSafety.js', '../../MobileApp/src/utils/nativeBalanceSafety.js']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const field of ['onlinePendingRevenue', 'returnRefundDebits', 'processingWithdrawalAmount']) assert.ok(source.includes(`'${field}'`));
  }
});

test('seller revenue screens inherit the theme-aware page background instead of forcing light mode', () => {
  const source = readFileSync(new URL('../src/components/layout/SellerDashboard.jsx', import.meta.url), 'utf8');
  let found = false;
  walk(parse(source, { sourceType: 'module', plugins: ['jsx'] }), node => {
    if (node.type !== 'JSXOpeningElement' || node.name.name !== 'div') return;
    if (!node.attributes.some(attribute => attribute.name?.name === 'className'
      && attribute.value?.value === 'min-h-screen relative flex')) return;
    found = true;
    assert.ok(!node.attributes.some(attribute => attribute.name?.name === 'style'));
  });
  assert.ok(found, 'Seller layout root must retain the shared theme-aware background');
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  assert.match(css, /html\.dark body\s*\{\s*background: linear-gradient/);
});

test('filtered responses are bound to the exact requested window and cannot masquerade as lifetime totals', () => {
  const value = response(); value.scope = 'period';
  value.period = { days: 7, startDate: '2026-10-07T00:00:00.000Z', endDateExclusive: '2026-10-14T00:00:00.000Z', timezone: 'UTC', basis: 'order_created_at' };
  assert.equal(inspectSellerRevenueOverview(value, 'seller-a', 'PKR', '7').onlineGrossEarnings, 6000);
  assert.equal(inspectSellerRevenueOverview(value, 'seller-a', 'PKR', '30'), null);
  assert.equal(inspectSellerRevenueOverview(value, 'seller-a', 'PKR'), null);
  for (const mutate of [s => s.period.days = 30, s => s.period.startDate = '2026-10-08T00:00:00.000Z',
    s => s.period.timezone = 'Asia/Karachi', s => s.period.basis = 'delivery_date', s => s.period.endDateExclusive = '2026-10-14T01:00:00.000Z']) {
    const invalid = structuredClone(value); mutate(invalid);
    assert.equal(inspectSellerRevenueOverview(invalid, 'seller-a', 'PKR', '7'), null);
  }
});
