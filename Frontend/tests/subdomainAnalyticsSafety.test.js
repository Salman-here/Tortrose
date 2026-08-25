import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectAdminSubdomainResponse,
  subdomainAnalyticsResponseIsValid,
} from '../src/utils/subdomainAnalyticsSafety.js';

const response = () => ({
  subdomain: {
    slug: 'my-store', url: 'my-store.rozare.com', isActive: true,
    blocked: false, daysUntilRemoval: null, isPurchased: false,
  },
  analytics: {
    currency: 'PKR', totalViews: 10, totalOrders: 2, totalRevenue: 500.25,
    productCount: 3, trustCount: 4, conversionRate: 20,
    monthlyTraffic: [], trafficHistoryAvailable: false,
  },
});

test('subdomain analytics require exact requested-currency money and canonical counts', () => {
  assert.equal(subdomainAnalyticsResponseIsValid(response(), 'PKR'), true);
  assert.equal(subdomainAnalyticsResponseIsValid(response(), 'USD'), false);
  const malformed = response();
  malformed.analytics.totalRevenue = 500.251;
  assert.equal(subdomainAnalyticsResponseIsValid(malformed, 'PKR'), false);
});

const adminResponse = () => ({
  currency: 'PKR',
  stores: [{
    _id: '64b000000000000000000001',
    storeName: 'Native Store',
    storeSlug: 'native-store',
    logo: '',
    seller: {
      _id: '64b000000000000000000002',
      username: 'seller',
      email: 'seller@example.com',
    },
    views: 10,
    trustCount: 2,
    isActive: true,
    verification: { isVerified: true, status: 'approved' },
    createdAt: '2026-08-24T00:00:00.000Z',
    subdomainUrl: 'native-store.rozare.com',
    isSubdomainActive: true,
    productCount: 3,
    totalOrders: 2,
    totalRevenue: 500.25,
  }],
  summary: {
    totalStores: 2,
    activeSubdomains: 1,
    inactiveSubdomains: 1,
    pendingVerifications: 0,
    totalViews: 15,
  },
  pagination: { total: 1, page: 1, pages: 1 },
});

test('admin subdomain data requires exact requested-currency revenue and reconciled counts', () => {
  const inspected = inspectAdminSubdomainResponse(adminResponse(), 'PKR', {
    expectedPage: 1,
    expectedLimit: 15,
  });
  assert.equal(inspected.valid, true);
  assert.equal(inspected.currency, 'PKR');

  const wrongCurrency = adminResponse();
  wrongCurrency.currency = 'USD';
  assert.equal(inspectAdminSubdomainResponse(wrongCurrency, 'PKR', { expectedPage: 1 }).valid, false);

  const subcentRevenue = adminResponse();
  subcentRevenue.stores[0].totalRevenue = 500.251;
  assert.equal(inspectAdminSubdomainResponse(subcentRevenue, 'PKR', { expectedPage: 1 }).valid, false);

  const stringCount = adminResponse();
  stringCount.summary.totalStores = '2';
  assert.equal(inspectAdminSubdomainResponse(stringCount, 'PKR', { expectedPage: 1 }).valid, false);

  const inconsistentTotals = adminResponse();
  inconsistentTotals.summary.activeSubdomains = 2;
  assert.equal(inspectAdminSubdomainResponse(inconsistentTotals, 'PKR', { expectedPage: 1 }).valid, false);
});

test('admin subdomain data rejects identity, pagination, and store-status inconsistencies', () => {
  const duplicate = adminResponse();
  duplicate.stores.push({ ...duplicate.stores[0] });
  duplicate.pagination.total = 2;
  assert.equal(inspectAdminSubdomainResponse(duplicate, 'PKR', { expectedPage: 1 }).valid, false);

  const wrongPage = adminResponse();
  wrongPage.pagination.page = 2;
  assert.equal(inspectAdminSubdomainResponse(wrongPage, 'PKR', { expectedPage: 1 }).valid, false);

  const relabelledStatus = adminResponse();
  relabelledStatus.stores[0].isSubdomainActive = false;
  assert.equal(inspectAdminSubdomainResponse(relabelledStatus, 'PKR', { expectedPage: 1 }).valid, false);

  const impossibleVerification = adminResponse();
  impossibleVerification.stores[0].verification = { isVerified: true, status: 'pending' };
  assert.equal(inspectAdminSubdomainResponse(impossibleVerification, 'PKR', { expectedPage: 1 }).valid, false);
});
