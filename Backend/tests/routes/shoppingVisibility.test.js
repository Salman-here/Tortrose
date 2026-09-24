'use strict';
const mongoose = require('mongoose');
const approvedCatalogFixture = require('../helpers/approvedCatalogFixture');
const express = require('express');
const request = require('supertest');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
jest.mock('../../services/currencyService', () => ({ ...jest.requireActual('../../services/currencyService'), getExchangeRateSnapshot: jest.fn(async () => ({ base: 'USD', rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 }, capturedAt: new Date().toISOString(), source: 'test-rates', fallback: false })) }));
const User = require('../../models/User');
const Store = require('../../models/Store');
const Product = require('../../models/Product');
const ShippingMethod = require('../../models/ShippingMethod');
const stores = require('../../controllers/storeController');
const products = require('../../controllers/productController');
const { normalizeStoreVisibility } = require('../../services/storeVisibilityService');
const { withBuyerCatalogLocation, getActiveSellerIds } = require('../../services/publicCatalogService');
const { executeToolCall } = require('../../services/aiActionExecutor');
const { verifyOrderPricingAtCommit } = require('../../services/orderPricingCommitGuard');
let replica, app, fixture;
const pk = { buyerMode: 'country', buyerCountry: 'Pakistan', buyerCountryCode: 'PK' };
const globalQuery = { buyerMode: 'global' };

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  app = express(); app.use(express.json());
  app.get('/stores', stores.getAllStores);
  app.get('/stores/:slug/products', stores.getStoreProducts);
  app.get('/stores/:slug', stores.getStoreBySlug);
  app.get('/products', products.getProducts);
  app.get('/filters', products.getFilters);
  app.get('/products/:id', products.getSingleProduct);
}, 60000);
afterAll(async () => { await mongoose.disconnect(); await replica?.stop(); }, 60000);
beforeEach(async () => {
  await Promise.all([User, Store, Product, ShippingMethod].map(model => model.deleteMany({})));
  fixture = {};
  for (const [key, mode, country, code] of [
    ['pk', 'country', 'Pakistan', 'PK'], ['us', 'country', 'United States', 'US'],
    ['global', 'global', 'United States', 'US'], ['city', 'city', 'Pakistan', 'PK'],
    ['legacy', null, 'Pakistan', 'PK'], ['unknown', null, '', ''], ['blocked', 'global', 'Pakistan', 'PK'],
  ]) {
    const seller = await User.create({ username: 'Scope ' + key, email: key + '@example.com', role: 'seller', status: key === 'blocked' ? 'blocked' : 'active' });
    const store = await Store.create({ ...approvedCatalogFixture(), seller: seller._id, storeName: 'Scope ' + key, storeSlug: 'scope-' + key, isActive: true, productCurrency: 'USD', productCurrencyStatus: 'active', address: { country, countryCode: code }, ...(mode ? { visibility: normalizeStoreVisibility({ mode, country, countryCode: code, city: 'Lahore' }) } : {}) });
    if (key === 'legacy') await Store.collection.updateOne({ _id: store._id }, { $unset: { visibility: '' } });
    const product = await Product.create({ ...approvedCatalogFixture(), seller: seller._id, name: 'Scope item ' + key, description: 'A visibility test product', price: 10, currency: 'USD', stock: 10, image: 'https://example.com/item.png', category: 'Category ' + key, brand: 'Brand ' + key });
    fixture[key] = { seller, store, product };
  }
  fixture.platform = await Product.create({ ...approvedCatalogFixture(), name: 'Scope platform item', description: 'Platform global catalog product', price: 8, currency: 'USD', stock: 10, image: 'https://example.com/item.png', category: 'Platform', brand: 'Platform' });
}, 30000);

test('Global adds only the buyer country while excluding unknown and blocked sellers', async () => {
  const country = await request(app).get('/stores').query(pk);
  expect(country.status).toBe(200);
  expect(country.body.stores.map(store => store.storeSlug).sort()).toEqual(['scope-legacy', 'scope-pk']);
  const local = await request(app).get('/stores').query({ ...pk, buyerCity: 'Lahore' });
  expect(local.body.stores.map(store => store.storeSlug).sort()).toEqual(['scope-city', 'scope-legacy', 'scope-pk']);
  const worldwide = await request(app).get('/stores').query({ ...globalQuery, buyerCountry: 'Pakistan', buyerCity: 'Lahore' });
  expect(worldwide.status).toBe(200);
  expect(worldwide.body.stores.map(store => store.storeSlug).sort()).toEqual(['scope-global', 'scope-legacy', 'scope-pk']);
  const usGlobal = await request(app).get('/stores').query({ ...globalQuery, buyerCountry: 'United States', buyerCountryCode: 'US' });
  expect(usGlobal.body.stores.map(store => store.storeSlug).sort()).toEqual(['scope-global', 'scope-us']);
});

test('products, filters and counts inherit the selected store visibility; platform products are Global', async () => {
  const country = await request(app).get('/products').query({ ...pk, currency: 'USD', limit: 50 });
  expect(country.status).toBe(200);
  expect(country.body.products.map(product => product.name).sort()).toEqual(['Scope item legacy', 'Scope item pk']);
  const worldwide = await request(app).get('/products').query({ ...globalQuery, currency: 'USD', limit: 50 });
  expect(worldwide.status).toBe(200);
  expect(worldwide.body.products.map(product => product.name).sort()).toEqual(['Scope item global', 'Scope platform item']);
  const filters = await request(app).get('/filters').query(pk);
  expect(filters.status).toBe(200);
  expect(filters.body.categories.sort()).toEqual(['Category legacy', 'Category pk']);
  const localGlobal = { ...pk, ...globalQuery, currency: 'USD', limit: 50 };
  const both = await request(app).get('/products').query(localGlobal);
  expect(both.body.products.map(product => product.name).sort()).toEqual(['Scope item global', 'Scope item legacy', 'Scope item pk', 'Scope platform item']);
  expect(new Set(both.body.products.map(product => product._id)).size).toBe(4);
  const bothFilters = await request(app).get('/filters').query(localGlobal);
  expect(bothFilters.body.categories.sort()).toEqual(['Category global', 'Category legacy', 'Category pk', 'Platform']);
});

test('direct product/store links enforce the same scope and do not modify legacy records', async () => {
  const before = await Store.collection.findOne({ _id: fixture.legacy.store._id });
  for (const [key, query, status] of [['pk', pk, 200], ['global', globalQuery, 200], ['pk', globalQuery, 404], ['pk', { ...pk, ...globalQuery }, 200], ['global', { ...pk, ...globalQuery }, 200], ['us', { ...pk, ...globalQuery }, 404], ['global', pk, 404], ['us', pk, 404], ['unknown', globalQuery, 404], ['legacy', pk, 200]]) {
    expect((await request(app).get('/stores/' + fixture[key].store.storeSlug).query(query)).status).toBe(status);
    expect((await request(app).get('/products/' + fixture[key].product._id).query(query)).status).toBe(status);
    expect((await request(app).get('/stores/' + fixture[key].store.storeSlug + '/products').query(query)).status).toBe(status);
  }
  expect((await request(app).get('/products/' + fixture.platform._id).query(pk)).status).toBe(404);
  expect((await request(app).get('/products/' + fixture.platform._id).query(globalQuery)).status).toBe(200);
  expect(await Store.collection.findOne({ _id: fixture.legacy.store._id })).toEqual(before);
});

test.each(['/stores', '/products', '/filters'])('%s rejects invalid buyer modes/country pairs as client errors', async url => {
  expect((await request(app).get(url).query({ buyerMode: 'everything' })).status).toBe(400);
  expect((await request(app).get(url).query({ ...pk, buyerCountryCode: 'US' })).status).toBe(400);
  expect((await request(app).get(url).query({ ...pk, ...globalQuery, buyerCountryCode: 'US' })).status).toBe(400);
});

test('parallel AI discovery scopes stay isolated and cannot be overridden by model arguments', async () => {
  const [local, worldwide] = await Promise.all([
    withBuyerCatalogLocation({ mode: 'country', country: 'Pakistan' }, async () => { await Promise.resolve(); return getActiveSellerIds(); }),
    withBuyerCatalogLocation({ mode: 'global' }, async () => { await Promise.resolve(); return getActiveSellerIds(); }),
  ]);
  expect(local.map(String).sort()).toEqual([fixture.pk.seller._id, fixture.legacy.seller._id].map(String).sort());
  expect(worldwide.map(String)).toEqual([String(fixture.global.seller._id)]);
  const buyer = await User.create({ username: 'Scope buyer', email: 'buyer@example.com', role: 'user' });
  const result = await executeToolCall('search_products', { query: 'Scope', buyerMode: 'global', currency: 'USD', limit: 50 }, { _id: buyer._id, role: 'user', currency: 'USD', _buyerLocation: { mode: 'country', country: 'Pakistan' } });
  expect(result.success).toBe(true);
  expect(result.data.products.map(product => product.name).sort()).toEqual(['Scope item legacy', 'Scope item pk']);
  const hidden = await executeToolCall('get_store_details', { slug: 'scope-global' }, { _id: buyer._id, role: 'user', currency: 'USD', _buyerLocation: { mode: 'country', country: 'Pakistan' } });
  expect(hidden.success).toBe(false);
  const both = await executeToolCall('search_products', { query: 'Scope', currency: 'USD', limit: 50 }, { _id: buyer._id, role: 'user', currency: 'USD', _buyerLocation: { mode: 'global', country: 'Pakistan' } });
  expect(both.data.products.map(product => product.name).sort()).toEqual(['Scope item global', 'Scope item legacy', 'Scope item pk', 'Scope platform item']);
  const named = await executeToolCall('add_to_cart', { productName: 'Scope item global', quantity: 1 }, { _id: buyer._id, role: 'user', currency: 'USD', _buyerLocation: { mode: 'country', country: 'Pakistan' } });
  expect(named.success).toBe(false);
  expect(named.needsProductSelection).toBe(true);
  expect(named.data.products.every(product => product.name !== 'Scope item global')).toBe(true);
});

test('order insertion rechecks delivery eligibility if visibility changed after preview', async () => {
  const { seller, store, product } = fixture.pk;
  await ShippingMethod.create({ seller: seller._id, methods: [{ type: 'standard', cost: 1, currency: 'USD', deliveryDays: 5, isActive: true }] });
  const order = { sellerPolicies: [{ seller: seller._id, productCurrency: 'USD' }], shippingInfo: { country: 'Pakistan', countryCode: 'PK', state: 'Punjab', city: 'Lahore' }, orderItems: [{ productId: product._id, seller: seller._id, sourceCurrency: 'USD', sourcePrice: 10 }], sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'standard', sourceCost: 1, sourceCurrency: 'USD', estimatedDays: 5 } }] };
  await mongoose.connection.transaction(session => verifyOrderPricingAtCommit(order, session));
  await Store.updateOne({ _id: store._id }, { $set: { visibility: normalizeStoreVisibility({ mode: 'country', country: 'United States' }) } });
  await expect(mongoose.connection.transaction(session => verifyOrderPricingAtCommit(order, session))).rejects.toMatchObject({ code: 'STORE_DELIVERY_UNAVAILABLE' });
  expect((await Product.findById(product._id)).stock).toBe(10);
  await Store.updateOne({ _id: store._id }, { $set: { visibility: normalizeStoreVisibility({ mode: 'global' }) } });
  await mongoose.connection.transaction(session => verifyOrderPricingAtCommit(order, session));
});
