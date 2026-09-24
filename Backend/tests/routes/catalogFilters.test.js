'use strict';
const mongoose = require('mongoose');
const approvedCatalogFixture = require('../helpers/approvedCatalogFixture');
const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
jest.mock('../../services/currencyService', () => ({
  ...jest.requireActual('../../services/currencyService'),
  convertAmount: jest.fn(async (amount, from, to) => {
    const rates = { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 };
    return Math.round(amount / rates[from] * rates[to] * 100) / 100;
  }),
}));
const Product = require('../../models/Product');
const Store = require('../../models/Store');
const User = require('../../models/User');
const StoreReview = require('../../models/StoreReview');
const products = require('../../controllers/productController');
const stores = require('../../controllers/storeController');
const subdomains = require('../../controllers/subdomainController');
const { normalizeStoreVisibility } = require('../../services/storeVisibilityService');
const { parsePriceRange, productFieldComparator } = require('../../services/catalogFilterService');
let mongo, app, primary, secondary, items;
const area = { buyerMode: 'country', buyerCountry: 'Pakistan', buyerCountryCode: 'PK', currency: 'USD' };
const names = response => response.body.products.map(item => item.name);
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  app = express(); app.use(express.json());
  app.get('/products', products.getProducts); app.get('/filters', products.getFilters);
  app.get('/stores', stores.getAllStores); app.get('/stores/:slug/products', stores.getStoreProducts);
  app.get('/subdomain/:slug/products', async (req, res) => { req.subdomainStore = await Store.findOne({ storeSlug: req.params.slug }); return subdomains.getSubdomainProducts(req, res); });
}, 60000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); }, 60000);
const makeStore = async (suffix, extra = {}) => {
  const seller = await User.create({ username: suffix, email: suffix + '@example.com', role: 'seller', status: 'active' });
  return Store.create({ ...approvedCatalogFixture(), seller: seller._id, storeName: suffix, storeSlug: suffix, isActive: true, visibility: normalizeStoreVisibility({ mode: 'country', country: 'Pakistan' }), ...extra });
};
beforeEach(async () => {
  await Promise.all([Product, Store, User, StoreReview].map(Model => Model.deleteMany({})));
  primary = await makeStore('catalog-primary'); secondary = await makeStore('catalog-secondary');
  items = [];
  for (const [name, price, currency, brand, category, rating, views, sales, day, discount] of [
    ['Zed Mug', 10, 'USD', 'Atlas', 'Home & Kitchen', 4, 50, 2, 1, 8],
    ['Steel Cup', 1400, 'PKR', 'atlas', 'home & kitchen', 5, 10, 9, 2, null],
    ['Travel Stand', 8, 'GBP', 'Atlas', 'Electronics', 2, 20, 3, 3, null],
    ['Euro Mat', 18, 'EUR', 'Beta', 'Sports', 3, 30, 4, 4, null],
    ['Bracket [A]', 2, 'USD', 'A+B', 'Books', 1, 40, 5, 5, null],
    ['Free Card', 0, 'USD', 'Beta', 'Books', 0, 0, 0, 6, null],
  ]) {
    items.push(await Product.create({ ...approvedCatalogFixture(), seller: primary.seller, name, description: 'Catalog fixture', price, currency, priceCurrency: currency,
      brand, category, rating, numReviews: 1, views, totalSales: sales, createdAt: new Date(`2026-09-0${day}T00:00:00Z`), stock: 20,
      image: 'https://example.com/item.png', ...(discount == null ? {} : { discountedPrice: discount, discountedPriceCurrency: currency }) }));
  }
  await Product.create({ ...approvedCatalogFixture(), seller: secondary.seller, name: 'Other seller only', description: 'Catalog fixture', price: 100, currency: 'USD', stock: 1, category: 'Other', brand: 'Separate', image: 'https://example.com/other.png' });
});

test.each([
  ['newest', 'desc', ['Free Card', 'Bracket [A]', 'Euro Mat', 'Travel Stand', 'Steel Cup', 'Zed Mug']],
  ['rating', 'desc', ['Steel Cup', 'Zed Mug', 'Euro Mat', 'Travel Stand', 'Bracket [A]', 'Free Card']],
  ['popular', 'desc', ['Zed Mug', 'Bracket [A]', 'Euro Mat', 'Travel Stand', 'Steel Cup', 'Free Card']],
  ['sales', 'desc', ['Steel Cup', 'Bracket [A]', 'Euro Mat', 'Travel Stand', 'Zed Mug', 'Free Card']],
  ['price', 'asc', ['Free Card', 'Bracket [A]', 'Steel Cup', 'Zed Mug', 'Travel Stand', 'Euro Mat']],
])('%s %s is correct before pagination on Home and storefront', async (sortBy, sortOrder, expected) => {
  const home = await request(app).get('/products').query({ ...area, sortBy, sortOrder, limit: 50 });
  expect(home.status).toBe(200);
  expect(names(home).filter(name => name !== 'Other seller only')).toEqual(expected);
  const store = await request(app).get('/stores/catalog-primary/products').query({ ...area, sortBy, sortOrder, limit: 50 });
  expect(store.status).toBe(200); expect(names(store)).toEqual(expected);
  const reverse = await request(app).get('/stores/catalog-primary/products').query({ ...area, sortBy, sortOrder: sortOrder === 'asc' ? 'desc' : 'asc', limit: 50 });
  expect(names(reverse)).toEqual([...expected].reverse());
});

test('mixed-currency boundaries use the buyer unit and discounted price, including zero and no upper bound', async () => {
  for (const endpoint of ['/products', '/stores/catalog-primary/products', '/subdomain/catalog-primary/products']) {
    expect(names(await request(app).get(endpoint).query({ ...area, currency: 'PKR', priceRange: '1400,2240' })).sort()).toEqual(['Steel Cup', 'Zed Mug']);
    expect(names(await request(app).get(endpoint).query({ ...area, priceRange: '0,0' }))).toEqual(['Free Card']);
    const minOnly = await request(app).get(endpoint).query({ ...area, priceRange: '10,Infinity', sortBy: 'price', sortOrder: 'asc' });
    expect(names(minOnly).filter(name => name !== 'Other seller only')).toEqual(['Travel Stand', 'Euro Mat']);
    expect((await request(app).get(endpoint).query({ ...area, priceRange: '10,2' })).status).toBe(400);
    expect((await request(app).get(endpoint).query({ ...area, priceRange: 'nope,2' })).status).toBe(400);
  }
});

test('combined category/brand filters handle case and literal punctuation without crossing sellers', async () => {
  for (const endpoint of ['/products', '/stores/catalog-primary/products', '/subdomain/catalog-primary/products']) {
    expect(names(await request(app).get(endpoint).query({ ...area, categories: 'HOME & KITCHEN', brands: 'ATLAS' })).sort()).toEqual(['Steel Cup', 'Zed Mug']);
    expect(names(await request(app).get(endpoint).query({ ...area, categories: 'Books', brands: 'A+B' }))).toEqual(['Bracket [A]']);
    expect(names(await request(app).get(endpoint).query({ ...area, categories: 'Sports', brands: 'Atlas' }))).toEqual([]);
  }
  const otherBrands = await request(app).get('/products').query({ ...area, brands: '__other_brands__' });
  expect(names(otherBrands)).not.toContain('Steel Cup');
  expect(names(otherBrands)).not.toContain('Zed Mug');
  const filters = await request(app).get('/filters').query(area);
  expect(filters.body.categories.filter(name => name.toLowerCase() === 'home & kitchen')).toHaveLength(1);
});

test('store search is literal and tenant-scoped, and a one-letter Home search does not match everything', async () => {
  for (const endpoint of ['/stores/catalog-primary/products', '/subdomain/catalog-primary/products']) {
    expect(names(await request(app).get(endpoint).query({ ...area, search: '[' }))).toEqual(['Bracket [A]']);
    expect(names(await request(app).get(endpoint).query({ ...area, search: 'Other seller only' }))).toEqual([]);
  }
  expect(names(await request(app).get('/products').query({ ...area, search: 'z' }))).toEqual(['Zed Mug']);
});

test('equal sort values have a deterministic id tie-break across pages', async () => {
  await Product.updateMany({ seller: primary.seller }, { $set: { rating: 4, numReviews: 3 } });
  const one = await request(app).get('/stores/catalog-primary/products').query({ ...area, sortBy: 'rating', limit: 3, page: 1 });
  const two = await request(app).get('/stores/catalog-primary/products').query({ ...area, sortBy: 'rating', limit: 3, page: 2 });
  const ids = [...one.body.products, ...two.body.products].map(p => p._id);
  expect(ids).toEqual(items.map(p => String(p._id)).sort());
  expect(new Set(ids).size).toBe(6); expect(one.body.pagination.total).toBe(6);
});

test('store catalog counts and categories survive empty results and remain tenant-scoped', async () => {
  for (const endpoint of ['/stores/catalog-primary/products', '/subdomain/catalog-primary/products']) {
    const result = await request(app).get(endpoint).query({ ...area, search: 'no-such-fixture' });
    expect(result.status).toBe(200);
    expect(result.body.products).toEqual([]);
    expect(result.body.pagination.total).toBe(0);
    expect(result.body.catalogTotal).toBe(6);
    expect(result.body.categories).toContain('Books');
    expect(result.body.categories).not.toContain('Other');
  }
});

test('brand choices require an active visible verified brand profile with public products, even just one', async () => {
  expect((await request(app).get('/filters').query(area)).body.verifiedBrands).toEqual([]);
  await Store.updateOne({ _id: primary._id }, { $set: { sellerType: 'brand', 'verification.isVerified': true } });
  // A verified ordinary store is not a verified brand business.
  await Store.updateOne({ _id: secondary._id }, { $set: { 'verification.isVerified': true } });
  const first = await request(app).get('/filters').query(area);
  expect(first.body.verifiedBrands.map(b => b.value)).toEqual([String(primary._id)]);
  expect(first.body.verifiedBrands[0]).toMatchObject({ label: 'catalog-primary', verified: true });
  expect(first.body.brands).toEqual([]); expect(first.body.otherBrandsCount).toBe(0);
  await Store.updateOne({ _id: secondary._id }, { $set: { sellerType: 'brand' } });
  const two = await request(app).get('/filters').query(area);
  expect(two.body.verifiedBrands).toHaveLength(2);
  await makeStore('verified-empty', { sellerType: 'brand', verification: { isVerified: true } });
  expect((await request(app).get('/filters').query(area)).body.verifiedBrands).toHaveLength(2);
  await Store.updateOne({ _id: secondary._id }, { $set: { visibility: normalizeStoreVisibility({ mode: 'country', country: 'United States' }) } });
  expect((await request(app).get('/filters').query(area)).body.verifiedBrands.map(b => b.value)).toEqual([String(primary._id)]);
  await Store.updateOne({ _id: primary._id }, { $set: { isActive: false } });
  expect((await request(app).get('/filters').query(area)).body.verifiedBrands).toEqual([]);
});

test('verified brand selection is profile-bound, combines with prices and fails closed after revocation', async () => {
  await Store.updateOne({ _id: primary._id }, { $set: { sellerType: 'brand', 'verification.isVerified': true } });
  await Product.updateOne({ seller: secondary.seller }, { $set: { brand: primary.storeName } });
  const selected = { ...area, brandStores: String(primary._id) };
  expect(names(await request(app).get('/products').query(selected))).not.toContain('Other seller only');
  expect(names(await request(app).get('/products').query(selected))).toHaveLength(6);
  expect(names(await request(app).get('/products').query({ ...selected, categories: 'Books', priceRange: '0,0' }))).toEqual(['Free Card']);
  expect(names(await request(app).get('/products').query({ ...area, brandStores: String(secondary._id) }))).toEqual([]);
  expect((await request(app).get('/products').query({ ...area, brandStores: 'invalid' })).status).toBe(400);
  await Store.updateOne({ _id: primary._id }, { $set: { 'verification.isVerified': false } });
  expect(names(await request(app).get('/products').query(selected))).toEqual([]);
  expect((await request(app).get('/products').query(area)).body.pagination.totalProducts).toBe(7);
});

test('verification/trust/search/type filter the whole Marketplace before paging and counts', async () => {
  for (let i = 0; i < 13; i++) await makeStore(`ordinary-${i}`);
  const match = await makeStore('z-match-brand', { sellerType: 'brand', trustCount: 100, verification: { isVerified: true } });
  const legacy = await makeStore('z-match-legacy', { trustCount: 55, verification: { isVerified: true } });
  await Store.collection.updateOne({ _id: legacy._id }, { $unset: { sellerType: '' } });
  const query = { ...area, verifiedOnly: 'true', minTrust: 50, sort: 'name', limit: 1 };
  const first = await request(app).get('/stores').query(query);
  expect(first.status).toBe(200); expect(first.body.stores.map(s => s._id)).toEqual([String(match._id)]);
  expect(first.body.counts).toEqual({ all: 2, brand: 1, store: 1 }); expect(first.body.pagination.total).toBe(2);
  const second = await request(app).get('/stores').query({ ...query, page: 2 });
  expect(second.body.stores.map(s => s._id)).toEqual([String(legacy._id)]);
  const type = await request(app).get('/stores').query({ ...query, type: 'store' });
  expect(type.body.stores.map(s => s._id)).toEqual([String(legacy._id)]); expect(type.body.counts.all).toBe(2);
  const search = await request(app).get('/stores').query({ ...query, search: 'legacy' });
  expect(search.body.pagination.total).toBe(1); expect(search.body.counts).toEqual({ all: 1, brand: 0, store: 1 });
  expect((await request(app).get('/stores').query({ ...area, search: '[' })).status).toBe(200);
  expect((await request(app).get('/stores').query({ ...area, minTrust: -1 })).status).toBe(400);
});

test.each(['newest', 'rating', 'popular', 'trusted', 'name'])('Marketplace %s sort runs on all matches before taking a page', async sort => {
  await Store.collection.updateOne({ _id: primary._id }, { $set: { storeName: 'A Store', trustCount: 50, views: 100, createdAt: new Date('2026-09-20') } });
  await Store.collection.updateOne({ _id: secondary._id }, { $set: { storeName: 'Z Store', trustCount: 1, views: 1, createdAt: new Date('2026-09-01') } });
  await StoreReview.create({ store: primary._id, user: new mongoose.Types.ObjectId(), rating: 5, isVerifiedPurchase: true });
  await StoreReview.create({ store: secondary._id, user: new mongoose.Types.ObjectId(), rating: 2, isVerifiedPurchase: true });
  const result = await request(app).get('/stores').query({ ...area, sort, limit: 1 });
  expect(result.status).toBe(200); expect(result.body.stores[0]._id).toBe(String(primary._id));
});

test('range parser treats blank maximum as unbounded and never silently accepts invalid ranges', () => {
  expect(parsePriceRange('5,')).toEqual({ min: 5, max: null });
  for (const raw of ['-1,2', '1,NaN', '3,2', '1,2,3']) expect(() => parsePriceRange(raw)).toThrow();
  expect([{ _id: 'b', rating: 4, numReviews: 999 }, { _id: 'a', rating: 5, numReviews: 1 }].sort(productFieldComparator('rating', 'desc'))[0]._id).toBe('a');
});
