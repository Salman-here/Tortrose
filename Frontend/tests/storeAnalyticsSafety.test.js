import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAuthoritativeStoreAnalytics } from '../src/utils/storeAnalyticsSafety.js';

test('store analytics stay bound to the requested currency and exact cents', () => {
  const analytics = {
    currency: 'PKR', views: 12, productCount: 3, trustCount: 4,
    totalOrders: 2, totalSales: 1250.75,
  };
  assert.deepEqual(selectAuthoritativeStoreAnalytics(analytics, 'PKR'), analytics);
  assert.equal(selectAuthoritativeStoreAnalytics(analytics, 'USD'), null);
  assert.equal(selectAuthoritativeStoreAnalytics({ ...analytics, totalSales: 1250.751 }, 'PKR'), null);
  assert.equal(selectAuthoritativeStoreAnalytics({ ...analytics, views: '12' }, 'PKR'), null);
});
