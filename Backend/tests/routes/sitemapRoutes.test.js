'use strict';

const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Product = require('../../models/Product');
const Store = require('../../models/Store');
const User = require('../../models/User');
const sitemapRoutes = require('../../routes/sitemapRoutes');

let mongoServer;
let app;

const createSellerStore = async ({ token, userStatus = 'active', storeActive = true, blockedAt = null }) => {
  const seller = await User.create({
    username: `sitemap-${token}`,
    email: `sitemap-${token}@example.com`,
    role: 'seller',
    status: userStatus,
    isVerified: true,
  });
  const store = await Store.create({
    seller: seller._id,
    storeName: `${token} Store`,
    storeSlug: `${token}-goods`,
    isActive: storeActive,
    blockedAt,
  });
  return { seller, store };
};

const createProduct = (seller, token) => Product.create({
  seller: seller?._id || seller || null,
  name: `${token} Product`,
  description: `A complete description for the ${token} product.`,
  price: 10,
  discountedPrice: 0,
  currency: 'USD',
  priceCurrency: 'USD',
  discountedPriceCurrency: 'USD',
  category: 'Home',
  brand: `${token} Brand`,
  stock: 4,
  image: `https://images.example.com/${token}.jpg`,
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  app = express();
  app.use('/', sitemapRoutes);
}, 60000);

afterEach(async () => {
  await Promise.all([Product.deleteMany({}), Store.deleteMany({}), User.deleteMany({})]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60000);

test('product sitemap includes only products owned by public active sellers', async () => {
  const active = await createSellerStore({ token: 'active' });
  const inactive = await createSellerStore({
    token: 'inactive',
    storeActive: false,
    blockedAt: new Date(),
  });
  const blockedOwner = await createSellerStore({ token: 'blocked-owner', userStatus: 'blocked' });
  const protectedSeller = await User.create({
    username: 'sitemap-protected-owner',
    email: 'sitemap-protected-owner@example.com',
    role: 'seller',
    status: 'active',
    isVerified: true,
  });
  await Store.collection.insertOne({
    seller: protectedSeller._id,
    storeName: 'Legacy Rozare Store',
    storeSlug: 'rozare-legacy-store',
    isActive: true,
    blockedAt: null,
  });
  const [activeProduct, inactiveProduct, blockedOwnerProduct, protectedProduct, platformProduct] = await Promise.all([
    createProduct(active.seller, 'active'),
    createProduct(inactive.seller, 'inactive'),
    createProduct(blockedOwner.seller, 'blocked-owner'),
    createProduct(protectedSeller, 'protected-owner'),
    createProduct(null, 'platform'),
  ]);

  const response = await request(app).get('/sitemap-products.xml').expect(200);

  expect(response.headers['content-type']).toMatch(/application\/xml/);
  expect(response.headers['x-robots-tag']).toBe('noindex');
  expect(response.text).toContain(`https://rozare.com/single-product/${activeProduct._id}`);
  expect(response.text).toContain(`https://rozare.com/single-product/${platformProduct._id}`);
  expect(response.text).not.toContain(String(inactiveProduct._id));
  expect(response.text).not.toContain(String(blockedOwnerProduct._id));
  expect(response.text).not.toContain(String(protectedProduct._id));
  expect(response.text).not.toContain('https://www.rozare.com');
});

test('store sitemap publishes direct canonical subdomains and excludes inactive or blocked owners', async () => {
  const active = await createSellerStore({ token: 'active' });
  const inactive = await createSellerStore({
    token: 'inactive',
    storeActive: false,
    blockedAt: new Date(),
  });
  const blockedOwner = await createSellerStore({ token: 'blocked-owner', userStatus: 'blocked' });
  const protectedSeller = await User.create({
    username: 'sitemap-protected-store-owner',
    email: 'sitemap-protected-store-owner@example.com',
    role: 'seller',
    status: 'active',
    isVerified: true,
  });
  await Store.collection.insertOne({
    seller: protectedSeller._id,
    storeName: 'Legacy Admin Store',
    storeSlug: 'admin-legacy-store',
    isActive: true,
    blockedAt: null,
  });

  const response = await request(app).get('/sitemap-stores.xml').expect(200);

  expect(response.text).toContain(`https://${active.store.storeSlug}.rozare.com/`);
  expect(response.text).not.toContain(`https://${inactive.store.storeSlug}.rozare.com/`);
  expect(response.text).not.toContain(`https://${blockedOwner.store.storeSlug}.rozare.com/`);
  expect(response.text).not.toContain('admin-legacy-store.rozare.com');
  expect(response.text).not.toContain('/store/');
  expect(response.text).not.toContain('https://www.rozare.com');
});
