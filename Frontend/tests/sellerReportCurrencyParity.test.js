import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readLayout = (name) => readFileSync(
  new URL(`../src/components/layout/${name}`, import.meta.url),
  'utf8',
);

test('web seller reports request and retain the store product currency', () => {
  const analytics = readLayout('SellerAnalytics.jsx');
  const dashboard = readLayout('SellerDashboard.jsx');
  const settings = readLayout('StoreSettings.jsx');
  const subdomain = readLayout('SellerSubdomainManagement.jsx');
  const payments = readLayout('SellerPayments.jsx');

  for (const source of [analytics, dashboard, settings, subdomain, payments]) {
    assert.match(source, /api\/stores\/product-currency/);
    assert.match(source, /inspectSellerProductCurrencyState/);
  }

  assert.match(analytics, /api\/analytics\/seller\?days=\$\{timeRange\}&currency=\$\{encodeURIComponent\(sellerCurrency\)\}/);
  assert.match(analytics, /sellerAnalyticsMoneyIsValid\(nextAnalytics, sellerCurrency\)/);

  assert.match(dashboard, /api\/stores\/analytics\?currency=\$\{encodeURIComponent\(activeCurrency\)\}/);
  assert.match(dashboard, /selectAuthoritativeSellerMetrics\(nextMetrics, activeCurrency\)/);
  assert.match(dashboard, /overviewCurrency/);

  assert.match(settings, /api\/stores\/analytics\?currency=\$\{encodeURIComponent\(sellerCurrency\)\}/);
  assert.match(settings, /selectAuthoritativeStoreAnalytics\(res\.data\?\.analytics, sellerCurrency\)/);

  assert.match(subdomain, /api\/subdomain\/analytics\/seller\?currency=\$\{encodeURIComponent\(sellerCurrency\)\}/);
  assert.match(subdomain, /subdomainAnalyticsResponseIsValid\(analyticsRes\.data, sellerCurrency\)/);

  assert.match(payments, /seller\/summary\?currency=\$\{encodeURIComponent\(requestCurrency\)\}/);
  assert.match(payments, /setSellerCurrency\(requestCurrency\)/);
  assert.match(payments, /currency: sellerCurrency/);
  assert.doesNotMatch(payments, /const \{ formatAmount, currency,/);
});

test('web seller money is formatted without converting back to account display currency', () => {
  const home = readLayout('SellerHome.jsx');
  const overview = readLayout('StoreOverview.jsx');
  const settings = readLayout('StoreSettings.jsx');
  const subdomain = readLayout('SellerSubdomainManagement.jsx');
  const payments = readLayout('SellerPayments.jsx');

  for (const source of [home, overview]) {
    assert.match(source, /reportCurrency/);
    assert.match(source, /sourceCurrency: reportCurrency, targetCurrency: reportCurrency/);
  }
  assert.match(settings, /sourceCurrency: analyticsCurrency, targetCurrency: analyticsCurrency/);
  assert.match(subdomain, /sourceCurrency: analytics\.currency, targetCurrency: analytics\.currency/);
  assert.match(payments, /formatAmount\(amount, \{ targetCurrency: sellerCurrency \}\)/);
});

test('seller order action exposes the actual confirmation source to assistive UI', () => {
  const orders = readLayout('orders.jsx');
  assert.match(orders, /const confirmationSourceLabel = getConfirmationSourceLabel\(order\)/);
  assert.match(orders, /confirmationSourceLabel \|\| 'Confirmed by buyer'/);
  assert.doesNotMatch(orders, /confirmed \? 'Confirmed via email'/);
});
