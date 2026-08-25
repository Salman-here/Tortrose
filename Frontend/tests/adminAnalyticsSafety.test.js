import test from 'node:test';
import assert from 'node:assert/strict';
import { adminAnalyticsResponseIsValid } from '../src/utils/adminAnalyticsSafety.js';

const validAnalytics = () => ({
  currency: 'PKR',
  revenueByDay: [
    { date: '2026-08-24', revenue: 100.01, orders: 1, newUsers: 1 },
    { date: '2026-08-25', revenue: 200.02, orders: 2, newUsers: 0 },
  ],
  summary: {
    totalRevenue: 300.03,
    revenueChange: 25,
    totalOrders: 3,
    ordersChange: 50,
    avgOrderValue: 100.01,
    avgChange: -5,
    totalUnitsSold: 4,
    totalStores: 2,
    verifiedStores: 1,
    pendingVerification: 1,
    newStoresInPeriod: 1,
    storesChange: 100,
    brandCount: 1,
    storeCount: 1,
    newBrandsInPeriod: 1,
    newStoresOnlyInPeriod: 0,
    totalUsers: 4,
    totalSellers: 2,
    totalProducts: 3,
    outOfStock: 1,
  },
  topStores: [{ name: 'Store', revenue: 300.03, orders: 3, productCount: 2, trustCount: 1 }],
  topProducts: [{ name: 'Product', revenue: 300.03, sold: 4 }],
  roleBreakdown: [
    { name: 'user', value: 1 },
    { name: 'seller', value: 2 },
    { name: 'admin', value: 1 },
  ],
  statusBreakdown: [{ name: 'delivered', value: 3 }],
  categoryBreakdown: [{ name: 'General', count: 3 }],
});

test('admin analytics accepts an exact, requested-currency, internally consistent snapshot', () => {
  assert.equal(adminAnalyticsResponseIsValid(validAnalytics(), 'PKR'), true);
});

test('admin analytics rejects currency, sub-cent, count, and reconciliation corruption', () => {
  for (const mutate of [
    value => { value.currency = 'USD'; },
    value => { value.summary.totalRevenue = 300.031; },
    value => { value.summary.totalOrders = 2.5; },
    value => { value.summary.brandCount = 2; },
    value => { value.revenueByDay[0].revenue = 100; },
    value => { value.statusBreakdown[0].value = 2; },
    value => { value.roleBreakdown[0].value = 0; },
    value => { value.topProducts[0].revenue = 300.04; },
  ]) {
    const value = validAnalytics();
    mutate(value);
    assert.equal(adminAnalyticsResponseIsValid(value, 'PKR'), false);
  }
});
