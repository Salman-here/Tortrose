import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  formatUsdCents,
  inspectSellerAdMutationResponse,
  inspectSellerAdsOverview,
  sellerAdsOverviewConfirmsRequest,
} from '../src/utils/sellerAdsSafety.js';

const IDS = Object.freeze({
  seller: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  store: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  freeProduct: 'cccccccccccccccccccccccc',
  paidProduct: 'dddddddddddddddddddddddd',
  pendingRequest: 'eeeeeeeeeeeeeeeeeeeeeeee',
  activeRequest: 'ffffffffffffffffffffffff',
  reviewer: '111111111111111111111111',
});

const makeProduct = (overrides = {}) => ({
  _id: IDS.freeProduct,
  seller: IDS.seller,
  name: 'Free launch item',
  category: 'Launch',
  image: '',
  images: [],
  price: 0,
  discountedPrice: 0,
  currency: 'PKR',
  priceCurrency: 'PKR',
  isFeatured: true,
  ...overrides,
});

const makeRequest = (overrides = {}) => ({
  _id: IDS.pendingRequest,
  seller: IDS.seller,
  store: IDS.store,
  products: [makeProduct()],
  productIds: [IDS.freeProduct],
  requestType: 'start',
  status: 'pending',
  active: false,
  channels: { tiktok: true, meta: false },
  sellerNote: '',
  adminNote: '',
  reviewedBy: null,
  reviewedAt: null,
  createdAt: '2026-08-25T08:00:00.000Z',
  updatedAt: '2026-08-25T08:00:00.000Z',
  ...overrides,
});

const makeOverview = (overrides = {}) => {
  const pendingRequest = makeRequest();
  return {
    subscription: {
      plan: 'elite',
      status: 'active',
      planName: 'Rozare Elite',
      metaAdsIncluded: false,
    },
    isElite: true,
    metaAdsAddonCents: 400,
    store: {
      _id: IDS.store,
      seller: IDS.seller,
      storeName: 'Exact Store',
      storeSlug: 'exact-store',
      logo: '',
    },
    featuredProducts: [
      makeProduct(),
      makeProduct({
        _id: IDS.paidProduct,
        name: 'Paid product',
        price: 6,
        discountedPrice: 5.5,
        currency: 'USD',
        priceCurrency: 'USD',
      }),
    ],
    activeRequest: null,
    pendingRequests: [pendingRequest],
    recentRequests: [structuredClone(pendingRequest)],
    ...overrides,
  };
};

const clone = value => structuredClone(value);

test('seller ads overview accepts one coherent snapshot and preserves genuine free native products', () => {
  const inspection = inspectSellerAdsOverview(makeOverview());

  assert.ok(inspection);
  assert.equal(inspection.sellerId, IDS.seller);
  assert.equal(inspection.storeId, IDS.store);
  assert.deepEqual(inspection.initialSelectedIds, [IDS.freeProduct]);
  assert.equal(inspection.initialIncludeMeta, false);
  assert.deepEqual(inspection.featuredProductMoney.get(IDS.freeProduct), {
    id: IDS.freeProduct,
    sellerId: IDS.seller,
    isFeatured: true,
    currency: 'PKR',
    price: 0,
    discountedPrice: 0,
    displayAmount: 0,
  });
  assert.equal(inspection.featuredProductMoney.get(IDS.paidProduct).displayAmount, 5.5);
  assert.equal(formatUsdCents(400), '$4.00');
  assert.equal(formatUsdCents(Number.MAX_SAFE_INTEGER), '$90071992547409.91');
});

test('seller ads overview rejects non-positive, coerced, non-cent, non-finite, unsafe, or missing USD minor units', () => {
  for (const value of ['400', null, undefined, true, 0, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    const overview = makeOverview();
    overview.metaAdsAddonCents = value;
    assert.equal(inspectSellerAdsOverview(overview), null, `expected ${String(value)} to fail`);
  }
  assert.equal(formatUsdCents('400'), null);
  assert.equal(formatUsdCents(Number.NaN), null);
});

test('seller ads overview rejects malformed native product money and currency instead of defaulting it', () => {
  const invalidProducts = [
    makeProduct({ price: '0' }),
    makeProduct({ price: true }),
    makeProduct({ price: -1 }),
    makeProduct({ price: 1.001 }),
    makeProduct({ price: Number.NaN }),
    makeProduct({ price: Number.MAX_SAFE_INTEGER }),
    makeProduct({ discountedPrice: 7, price: 6 }),
    makeProduct({ discountedPrice: 1, price: 0 }),
    makeProduct({ currency: 'pkr' }),
    makeProduct({ currency: 'USD', priceCurrency: 'PKR' }),
    makeProduct({ currency: undefined }),
  ];

  for (const product of invalidProducts) {
    const overview = makeOverview({ featuredProducts: [product] });
    overview.pendingRequests = [];
    overview.recentRequests = [];
    assert.equal(inspectSellerAdsOverview(overview), null);
  }
});

test('seller ads overview accepts exact native money in every supported product currency', () => {
  const products = [
    ['PKR', '333333333333333333333333', 200, 0],
    ['USD', '444444444444444444444444', 6, 5.5],
    ['EUR', '555555555555555555555555', 12.34, 0],
    ['GBP', '666666666666666666666666', 9.99, 8.75],
  ].map(([currency, id, price, discountedPrice]) => makeProduct({
    _id: id,
    name: `${currency} product`,
    currency,
    priceCurrency: currency,
    price,
    discountedPrice,
  }));
  const overview = makeOverview({
    featuredProducts: products,
    pendingRequests: [],
    recentRequests: [],
  });

  const inspection = inspectSellerAdsOverview(overview);
  assert.ok(inspection);
  for (const product of products) {
    assert.equal(inspection.featuredProductMoney.get(product._id).currency, product.currency);
  }
});

test('seller ads overview keeps a complete no-store seller snapshot valid without inventing IDs', () => {
  const overview = makeOverview({
    subscription: {
      plan: 'free_trial',
      status: 'trial',
      planName: 'Free Trial',
      metaAdsIncluded: false,
    },
    isElite: false,
    store: null,
    featuredProducts: [],
    pendingRequests: [],
    recentRequests: [],
  });

  const inspection = inspectSellerAdsOverview(overview);
  assert.ok(inspection);
  assert.equal(inspection.sellerId, null);
  assert.equal(inspection.storeId, null);
  assert.deepEqual(inspection.initialSelectedIds, []);
});

test('seller ads overview rejects incomplete ownership, subscription, and request state', () => {
  const mutations = [
    overview => { overview.isElite = false; },
    overview => { overview.subscription.status = 'ACTIVE'; },
    overview => { overview.subscription.metaAdsIncluded = 'false'; },
    overview => { overview.store.seller = IDS.reviewer; },
    overview => { overview.featuredProducts[0].seller = IDS.reviewer; },
    overview => { overview.featuredProducts[0]._id = IDS.paidProduct; },
    overview => { overview.pendingRequests[0].status = 'approved'; },
    overview => { overview.pendingRequests[0].active = true; },
    overview => { overview.pendingRequests[0].channels.tiktok = false; },
    overview => { overview.pendingRequests[0].productIds = ['CCCCCCCCCCCCCCCCCCCCCCCC']; },
    overview => { overview.pendingRequests[0].products = []; },
    overview => { overview.pendingRequests[0].reviewedBy = IDS.reviewer; },
    overview => { overview.pendingRequests[0].adminNote = 'Premature review note'; },
    overview => { overview.pendingRequests[0].createdAt = 'not-a-date'; },
    overview => { overview.pendingRequests[0].updatedAt = '2026-08-25T07:59:59.000Z'; },
    overview => { overview.recentRequests = []; },
    overview => { overview.pendingRequests.push(clone(overview.pendingRequests[0])); },
    overview => { overview.pendingRequests[0].requestType = 'update'; },
  ];

  for (const mutate of mutations) {
    const overview = makeOverview();
    mutate(overview);
    assert.equal(inspectSellerAdsOverview(overview), null);
  }
});

test('seller ads overview reconciles active, pending, and recent copies exactly', () => {
  const activeProduct = makeProduct({
    _id: IDS.paidProduct,
    name: 'Active USD product',
    price: 6,
    discountedPrice: 5.5,
    currency: 'USD',
    priceCurrency: 'USD',
  });
  const activeRequest = makeRequest({
    _id: IDS.activeRequest,
    products: [activeProduct],
    productIds: [IDS.paidProduct],
    requestType: 'start',
    status: 'approved',
    active: true,
    reviewedBy: IDS.reviewer,
    reviewedAt: '2026-08-25T08:05:00.000Z',
    updatedAt: '2026-08-25T08:05:00.000Z',
  });
  const pending = makeRequest({ requestType: 'update' });
  const overview = makeOverview({
    activeRequest,
    pendingRequests: [pending],
    recentRequests: [clone(pending), clone(activeRequest)],
  });

  const inspection = inspectSellerAdsOverview(overview);
  assert.ok(inspection);
  assert.deepEqual(inspection.initialSelectedIds, [IDS.paidProduct]);

  const conflicting = clone(overview);
  conflicting.recentRequests[0].channels.meta = true;
  assert.equal(inspectSellerAdsOverview(conflicting), null);

  const conflictingProductMoney = clone(overview);
  conflictingProductMoney.recentRequests[1].products[0].discountedPrice = 5;
  assert.equal(inspectSellerAdsOverview(conflictingProductMoney), null);

  const secondActive = clone(overview);
  secondActive.recentRequests.push(makeRequest({
    _id: '222222222222222222222222',
    requestType: 'update',
    status: 'approved',
    active: true,
    reviewedBy: IDS.reviewer,
    reviewedAt: '2026-08-25T08:06:00.000Z',
  }));
  assert.equal(inspectSellerAdsOverview(secondActive), null);
});

test('seller ads mutation must match the exact request and then appear in a verified overview', () => {
  const overview = makeOverview();
  const expected = {
    requestType: 'start',
    productIds: [IDS.freeProduct],
    includeMeta: false,
    sellerNote: '',
    sellerId: IDS.seller,
    storeId: IDS.store,
  };
  const response = {
    msg: 'Ads request sent for admin approval.',
    request: makeRequest({
      store: {
        _id: IDS.store,
        storeName: 'Exact Store',
        storeSlug: 'exact-store',
        logo: '',
      },
    }),
  };

  const mutation = inspectSellerAdMutationResponse(response, expected);
  const inspection = inspectSellerAdsOverview(overview);
  assert.ok(mutation);
  assert.equal(sellerAdsOverviewConfirmsRequest(inspection, mutation.request), true);

  for (const mutate of [
    value => { value.request.channels.meta = true; },
    value => { value.request.productIds = []; value.request.products = []; },
    value => { value.request.status = 'approved'; },
    value => { value.request.store._id = IDS.reviewer; },
    value => { value.request.sellerNote = 'Different note'; },
    value => { value.msg = ''; },
  ]) {
    const invalid = clone(response);
    mutate(invalid);
    assert.equal(inspectSellerAdMutationResponse(invalid, expected), null);
  }

  const missingConfirmation = makeOverview({ pendingRequests: [], recentRequests: [] });
  assert.equal(
    sellerAdsOverviewConfirmsRequest(inspectSellerAdsOverview(missingConfirmation), mutation.request),
    false
  );

  const stopExpected = {
    ...expected,
    requestType: 'stop',
    productIds: [],
    includeMeta: false,
  };
  const stopResponse = {
    msg: 'Ads stop request sent for admin approval.',
    request: makeRequest({
      requestType: 'stop',
      products: [],
      productIds: [],
      channels: { tiktok: true, meta: false },
    }),
  };
  assert.ok(inspectSellerAdMutationResponse(stopResponse, stopExpected));
  stopResponse.request.channels.meta = true;
  assert.equal(inspectSellerAdMutationResponse(stopResponse, stopExpected), null);
});

test('seller ads web screen uses verified snapshots without money or currency defaults', () => {
  const source = readFileSync(new URL('../src/components/layout/SellerAds.jsx', import.meta.url), 'utf8');

  assert.match(source, /inspectSellerAdsOverview\(res\.data\)/u);
  assert.match(source, /inspectSellerAdMutationResponse\(res\.data, expected\)/u);
  assert.match(source, /sellerAdsOverviewConfirmsRequest/u);
  assert.match(source, /new AbortController\(\)/u);
  assert.match(source, /clearVerifiedOverview\(\)/u);
  assert.match(source, /if \(mutationAbortRef\.current\) return;/u);
  assert.match(source, /includeMeta: type === 'stop' \? false : includeMeta/u);
  assert.match(source, /if \(!metaAddonIncluded && !includeMeta\)/u);
  assert.match(source, /toast\.success\(mutation\.message\)/u);
  assert.doesNotMatch(source, /Number\([^\n]*metaAdsAddonCents/u);
  assert.doesNotMatch(source, /metaAdsAddonCents\s*\|\|/u);
  assert.doesNotMatch(source, /discountedPrice\s*\|\|\s*product\.price/u);
  assert.doesNotMatch(source, /priceCurrency\s*\|\|\s*['"]USD['"]/u);
  assert.doesNotMatch(source, /toast\.success\(res\.data/u);
});
