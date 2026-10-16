'use strict';
const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../../models/User');
const Store = require('../../models/Store');
const Product = require('../../models/Product');
const seoRoutes = require('../../routes/seoRoutes');
const sitemapRoutes = require('../../routes/sitemapRoutes');
const approved = require('../helpers/approvedCatalogFixture');
let mongo, app, seller, store, product;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  app = express(); app.use('/api/seo', seoRoutes); app.use(sitemapRoutes);
}, 60000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); }, 60000);
beforeEach(async () => {
  await Promise.all([User, Store, Product].map(Model => Model.deleteMany({})));
  seller = await User.create({ username: 'SEO lifecycle seller', email: 'lifecycle@example.com', role: 'seller', status: 'active' });
  store = await Store.create({ ...approved(), seller: seller._id, storeName: 'Lifecycle Store', storeSlug: 'lifecycle-store', isActive: true, visibility: { mode: 'global' }, logo: 'https://images.example.com/store-logo.png' });
  product = await Product.create({ ...approved(), seller: seller._id, name: 'Lifecycle Travel Mug', description: 'A sturdy insulated travel mug.', brand: 'Lifecycle', category: 'Home', price: 100, currency: 'PKR', priceCurrency: 'PKR', discountedPriceCurrency: 'PKR', stock: 4, image: 'https://images.example.com/product.png' });
});

async function expectHidden({ storeHidden = false } = {}) {
  const response = await request(app).get(`/api/seo/render/product/${product._id}`).expect(404);
  expect(response.headers['x-robots-tag']).toMatch(/noindex/);
  expect(response.headers['cache-control']).toMatch(/no-store/);
  expect(response.text).not.toContain('Lifecycle Travel Mug');
  const products = await request(app).get('/sitemap-products.xml').expect(200);
  expect(products.text).not.toContain(String(product._id));
  expect(products.headers['cache-control']).toMatch(/no-store/);
  if (storeHidden) {
    await request(app).get(`/api/seo/store-status/${store.storeSlug}`).expect(404);
    const html = await request(app).get(`/api/seo/render/store/${store.storeSlug}`).expect(404);
    expect(html.text).not.toContain('Lifecycle Store');
    expect((await request(app).get('/sitemap-stores.xml').expect(200)).text).not.toContain('lifecycle-store.rozare.com');
  }
}

test('a deleted product disappears after a previously positive page and sitemap response', async () => {
  const before = await request(app).get(`/api/seo/render/product/${product._id}`).expect(200);
  expect(before.headers['cache-control']).toMatch(/no-store/);
  expect((await request(app).get('/sitemap-products.xml')).text).toContain(String(product._id));
  await Product.deleteOne({ _id: product._id });
  await expectHidden();
});

test.each([
  ['inactive store', async () => Store.updateOne({ _id: store._id }, { $set: { isActive: false } })],
  ['blocked store', async () => Store.updateOne({ _id: store._id }, { $set: { blockedAt: new Date() } })],
  ['pending store moderation', async () => Store.updateOne({ _id: store._id }, { $set: { moderationStatus: 'pending' } })],
  ['blocked store moderation', async () => Store.updateOne({ _id: store._id }, { $set: { moderationStatus: 'blocked' } })],
  ['blocked account', async () => User.updateOne({ _id: seller._id }, { $set: { status: 'blocked' } })],
  ['seller role removed', async () => User.updateOne({ _id: seller._id }, { $set: { role: 'user' } })],
  ['deleted seller', async () => User.deleteOne({ _id: seller._id })],
  ['deleted store', async () => Store.deleteOne({ _id: store._id })],
])('%s excludes the storefront and all its products from pages and sitemaps', async (_name, hide) => {
  await request(app).get(`/api/seo/render/product/${product._id}`).expect(200);
  await hide();
  await expectHidden({ storeHidden: true });
});

test.each([
  ['blocked product', { isBlocked: true }],
  ['pending product', { moderationStatus: 'pending' }],
  ['blocked product moderation', { moderationStatus: 'blocked' }],
])('%s stays excluded without hiding unrelated store information', async (_name, fields) => {
  await Product.updateOne({ _id: product._id }, { $set: fields });
  await expectHidden();
  await request(app).get(`/api/seo/render/store/${store.storeSlug}`).expect(200);
});

test('temporarily out-of-stock products remain public with truthful availability, not a deleted-page response', async () => {
  await Product.updateOne({ _id: product._id }, { $set: { stock: 0 } });
  const response = await request(app).get(`/api/seo/render/product/${product._id}`).expect(200);
  expect(response.text).toContain('https://schema.org/OutOfStock');
  expect(response.text).toContain('Out of stock');
  expect((await request(app).get('/sitemap-products.xml')).text).toContain(String(product._id));
});

test('restoring an active approved listing restores its index eligibility without a stale negative cache', async () => {
  await Store.updateOne({ _id: store._id }, { $set: { isActive: false } });
  await expectHidden({ storeHidden: true });
  await Store.updateOne({ _id: store._id }, { $set: { isActive: true } });
  await request(app).get(`/api/seo/render/product/${product._id}`).expect(200);
  expect((await request(app).get('/sitemap-stores.xml')).text).toContain('lifecycle-store.rozare.com');
});

test('malformed and missing products give real 404 responses', async () => {
  for (const id of ['invalid-product', '000000000000000000000000']) {
    const response = await request(app).get('/api/seo/render/product/' + id).expect(404);
    expect(response.headers['x-robots-tag']).toMatch(/noindex/);
  }
});

test('store shares prefer the logo and product shares prefer the product photo, never one generic image', async () => {
  const page = await request(app).get(`/api/seo/render/product/${product._id}`).expect(200);
  const storefront = await request(app).get(`/api/seo/render/store/${store.storeSlug}`).expect(200);
  expect(page.text).toContain('<meta property="og:image" content="https://images.example.com/product.png">');
  expect(storefront.text).toContain('<meta property="og:image" content="https://images.example.com/store-logo.png">');
  expect(page.text).toContain('<meta property="og:image:alt" content="Lifecycle Travel Mug">');
  expect(storefront.text).toContain('content="Lifecycle Store logo"');
});
