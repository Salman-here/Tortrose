'use strict';

const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Product = require('../../models/Product');
const Store = require('../../models/Store');
const User = require('../../models/User');
const seoRoutes = require('../../routes/seoRoutes');

let mongoServer;
let app;

const fixture = async (token, { active = true } = {}) => {
  const seller = await User.create({
    username: `seo-${token}`,
    email: `seo-${token}@example.com`,
    role: 'seller',
    status: 'active',
    isVerified: true,
  });
  const store = await Store.create({
    seller: seller._id,
    storeName: `${token} Goods`,
    storeSlug: `${token}-goods`,
    description: `Public description for ${token} Goods.`,
    isActive: active,
    blockedAt: active ? null : new Date(),
  });
  const product = await Product.create({
    seller: seller._id,
    name: `${token} Bottle`,
    description: `Detailed description for the ${token} Bottle.`,
    price: 25,
    currency: 'USD',
    priceCurrency: 'USD',
    discountedPriceCurrency: 'USD',
    category: 'Home',
    brand: `${token} Brand`,
    stock: 3,
    image: `https://images.example.com/${token}.png`,
  });
  return { seller, store, product };
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  app = express();
  app.use('/api/seo', seoRoutes);
}, 60000);

afterEach(async () => {
  await Promise.all([Product.deleteMany({}), Store.deleteMany({}), User.deleteMany({})]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60000);

test('store status is indexable only for an active store with an active seller', async () => {
  const active = await fixture('visible');
  const blocked = await fixture('blocked', { active: false });

  await request(app)
    .get(`/api/seo/store-status/${active.store.storeSlug}`)
    .expect(200, { indexable: true });
  const blockedResponse = await request(app)
    .get(`/api/seo/store-status/${blocked.store.storeSlug}`)
    .expect(404);
  expect(blockedResponse.body).toEqual({ indexable: false });
  expect(blockedResponse.headers['x-robots-tag']).toMatch(/noindex/);
});

test('blocked stores and their products render true noindex 404 responses', async () => {
  const blocked = await fixture('hidden', { active: false });

  const storeResponse = await request(app)
    .get(`/api/seo/render/store/${blocked.store.storeSlug}`)
    .expect(404);
  const productResponse = await request(app)
    .get(`/api/seo/render/product/${blocked.product._id}`)
    .expect(404);

  for (const response of [storeResponse, productResponse]) {
    expect(response.headers['x-robots-tag']).toMatch(/noindex/);
    expect(response.text).toContain('noindex, nofollow, noarchive, nosnippet');
  }
});

test('legacy protected hostnames and their products are never indexable', async () => {
  const seller = await User.create({
    username: 'seo-protected-owner',
    email: 'seo-protected-owner@example.com',
    role: 'seller',
    status: 'active',
    isVerified: true,
  });
  await Store.collection.insertOne({
    seller: seller._id,
    storeName: 'Legacy Protected Store',
    storeSlug: 'rozare-official-store',
    description: 'This old row predates hostname protection.',
    isActive: true,
    blockedAt: null,
  });
  const product = await Product.create({
    seller: seller._id,
    name: 'Protected Seller Product',
    description: 'This product must not be indexed.',
    price: 15,
    currency: 'USD',
    priceCurrency: 'USD',
    discountedPriceCurrency: 'USD',
    category: 'Home',
    brand: 'Legacy Brand',
    stock: 2,
    image: 'https://images.example.com/protected.png',
  });

  await request(app).get('/api/seo/store-status/rozare-official-store').expect(404);
  const productResponse = await request(app)
    .get(`/api/seo/render/product/${product._id}`)
    .expect(404);
  expect(productResponse.headers['x-robots-tag']).toMatch(/noindex/);
});

test('active product render has one canonical, valid Product data, and visible content', async () => {
  const active = await fixture('active');
  const response = await request(app)
    .get(`/api/seo/render/product/${active.product._id}`)
    .expect(200);

  expect(response.headers['x-robots-tag']).toMatch(/^index, follow/);
  expect(response.text).toContain(`<h1>${active.product.name}</h1>`);
  expect(response.text).toContain(`https://rozare.com/single-product/${active.product._id}`);
  expect((response.text.match(/rel="canonical"/g) || [])).toHaveLength(1);
  expect(response.text).toContain('"@type":"Product"');
  expect(response.text).toContain(`"name":"${active.product.name}"`);
});
