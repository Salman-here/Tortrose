import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { inspectSellerOrderListMoney } from '../src/utils/orderItems.js';
import { selectAuthoritativeSellerRevenue } from '../src/utils/currencySafety.js';

const source = readFileSync(new URL('../src/components/layout/SellerHome.jsx', import.meta.url), 'utf8');
const compiled = transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
const summary = total => ({ subtotal: total, shippingCost: 0, tax: 0, couponDiscount: 0, reconciliationAdjustment: 0, totalAmount: total });

function order(nativeCurrency, nativeTotal, buyerCurrency, buyerTotal, key = 'qa-order') {
  return { _id: key, orderId: key, currency: buyerCurrency, orderStatus: 'delivered', isPaid: true,
    createdAt: '2026-10-07T00:00:00.000Z', shippingInfo: { fullName: 'QA Buyer' },
    orderItems: [{ _id: 'line-1', seller: 'qa-seller', quantity: 1, price: buyerTotal, lineSubtotal: buyerTotal,
      sourcePrice: nativeTotal, sourceLineSubtotal: nativeTotal, sourceCurrency: nativeCurrency }],
    orderSummary: summary(buyerTotal),
    sellerCurrencyMoney: { version: 1, persisted: true, currency: nativeCurrency, buyerCurrency,
      summary: summary(nativeTotal), buyerSummary: summary(buyerTotal),
      exchangeRate: { from: nativeCurrency, to: buyerCurrency, rate: buyerTotal / nativeTotal, frozen: true },
      itemMoney: [{ sellerItemIndex: 0, orderItemKey: 'line-1', currency: nativeCurrency, lineSubtotal: nativeTotal,
        buyerCurrency, buyerLineSubtotal: buyerTotal, originalCurrency: nativeCurrency,
        originalLineSubtotal: nativeTotal, originalUnitPrice: nativeTotal }] } };
}

function renderOrders(orders, overrides = {}) {
  const outlet = { dashboardRole: 'seller', overviewLoaded: true, overviewCurrency: 'PKR',
    overviewProducts: [], overviewOrders: orders, products: [], orders: [],
    overviewMetrics: { currency: 'PKR', totalSales: 15600, totalOrders: orders?.length || 0, productCount: 0,
      inventory: { totalProducts: 0, outOfStock: 0, lowStock: 0 } }, ...overrides };
  const motion = new Proxy({}, { get: (_target, tag) => ({ children, className, style }) => React.createElement(tag, { className, style }, children) });
  const icons = new Proxy({}, { get: () => () => null });
  const formatPrice = (amount, { sourceCurrency, targetCurrency } = {}) => {
    assert.equal(sourceCurrency, targetCurrency, 'Recent order money must never use live currency conversion');
    return `${targetCurrency} ${amount.toFixed(2)}`;
  };
  const imports = {
    react: React, 'framer-motion': { motion }, 'lucide-react': icons,
    'react-router-dom': { useOutletContext: () => outlet, Link: ({ to, children, ...props }) => React.createElement('a', { ...props, href: to }, children) },
    '../../contexts/CurrencyContext': { useCurrency: () => ({ currency: 'GBP', formatPrice }) },
    '../../contexts/AuthContext': { useAuth: () => ({ currentUser: { _id: 'qa-seller', username: 'QA Seller', role: 'seller' } }) },
    '../../utils/orderItems': { inspectSellerOrderListMoney },
    '../../utils/whatsapp': { isOrderDecidedByBuyer: () => false, getConfirmationSourceLabel: () => '' },
    '../common/Loader': () => React.createElement('div', null, 'Loading verified store totals...'),
    '../../utils/currencySafety': { selectAuthoritativeSellerRevenue },
    '../../utils/productCardSafety': { inspectSellerProductPresentation: () => ({ stockValid: true, stock: 1 }), sellerInventoryOverviewIsValid: () => true },
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: path => {
    assert.ok(Object.hasOwn(imports, path), `Unexpected dependency: ${path}`); return imports[path];
  } });
  const html = renderToStaticMarkup(React.createElement(module.exports.default));
  const recent = html.slice(html.indexOf('Recent Orders'));
  return { html, recent };
}

test('recent web orders show frozen PKR seller money first and the original USD buyer amount as a hint', () => {
  const input = order('PKR', 999.99, 'USD', 3.61);
  const original = structuredClone(input);
  const { recent } = renderOrders([input]);
  assert.match(recent, /PKR 999\.99/);
  assert.match(recent, /Buyer ordered in USD: USD 3\.61/);
  assert.ok(recent.indexOf('PKR 999.99') < recent.indexOf('Buyer ordered in USD'));
  assert.match(recent, /href="\/seller-dashboard\/order\/qa-order"/);
  assert.deepEqual(input, original);
});

test('a PKR store retains older USD-native orders and mixed native currencies without repricing', () => {
  const { recent } = renderOrders([order('USD', 5, 'PKR', 1400, 'old-usd'), order('PKR', 999.99, 'USD', 3.61, 'native-pkr')]);
  assert.match(recent, /USD 5\.00/); assert.match(recent, /Buyer ordered in PKR: PKR 1400\.00/);
  assert.match(recent, /PKR 999\.99/); assert.match(recent, /Buyer ordered in USD: USD 3\.61/);
});

test('same-currency native orders show one authoritative amount without a redundant buyer hint', () => {
  const { recent } = renderOrders([order('PKR', 1000, 'PKR', 1000)]);
  assert.match(recent, /PKR 1000\.00/); assert.doesNotMatch(recent, /Buyer ordered in/);
});

test('missing or corrupted seller-native money never silently falls back to the buyer total', () => {
  const cases = [input => { delete input.sellerCurrencyMoney; }, input => { input.sellerCurrencyMoney = null; },
    input => { input.sellerCurrencyMoney.summary.totalAmount = 999.98; },
    input => { input.sellerCurrencyMoney.exchangeRate.frozen = false; },
    input => { input.sellerCurrencyMoney.currency = 'GBP'; }];
  for (const corrupt of cases) {
    const input = order('PKR', 999.99, 'USD', 3.61); corrupt(input);
    const { recent } = renderOrders([input]);
    assert.match(recent, /Money unavailable/);
    assert.doesNotMatch(recent, /USD 3\.61|PKR 999\.99|Buyer ordered in/);
  }
});

test('seller canonical overview never mixes its recent orders with fallback orders from another scope', () => {
  const foreign = order('USD', 88, 'USD', 88, 'foreign-account-order');
  const { recent } = renderOrders([order('PKR', 999.99, 'USD', 3.61)], { orders: [foreign] });
  assert.doesNotMatch(recent, /foreign-account-order|USD 88\.00/);
  const loading = renderOrders(null, { overviewLoaded: false, orders: [foreign] });
  assert.match(loading.html, /Loading verified store totals/);
  assert.doesNotMatch(loading.html, /foreign-account-order|USD 88\.00/);
});
