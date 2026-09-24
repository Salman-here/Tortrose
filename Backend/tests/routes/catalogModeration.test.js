'use strict';
jest.mock('../../utils/hfClient', () => ({ callHF: jest.fn() }));
// Exercise real controllers, models, ownership, transactions, public routes and
// outbox records. Only external media/AI delivery is replaced in this suite.
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const express = require('express');
const request = require('supertest');
const Product = require('../../models/Product');
const Store = require('../../models/Store');
const User = require('../../models/User');
const NotificationOutbox = require('../../models/NotificationOutbox');
const products = require('../../controllers/productController');
const stores = require('../../controllers/storeController');
const { getProductModerationStatus } = require('../../controllers/catalogModerationController');
const { stageStoreModeration } = require('../../services/catalogModerationService');
const { processNextCatalogItem } = require('../../services/catalogModerationWorker');
const { ensureCatalogModerationNotification, recoverCatalogModerationNotifications } = require('../../services/catalogModerationNotificationService');
const { verifySellerOperationalNotificationAuthority } = require('../../services/notificationOutboxDeliveryService');
const { enqueueUnreviewedCatalog } = require('../../services/catalogModerationIntake');
const { contentSnapshot, POLICY_VERSION } = require('../../services/catalogContentPolicy');
const { activeStoreQuery } = require('../../services/publicCatalogService');
const { executeToolCall } = require('../../services/aiActionExecutor');
const { callHF } = require('../../utils/hfClient');
const { generateProductTags } = require('../../controllers/smartTagController');
let mongo, app, seller, other, store;
const source = { name: 'Cotton Travel Shirt', description: 'A breathable cotton shirt for everyday travel.', brand: 'Acme', category: 'Fashion', image: 'https://example.com/shirt.jpg', price: 20, currency: 'USD', stock: 10 };
const approve = { review: async () => ({ status: 'approved', violations: [] }), prepareMedia: async (kind, entity) => ({ snapshot: contentSnapshot(kind, entity), fields: {} }) };
const as = user => ({ 'x-user-id': String(user._id), 'x-user-role': user.role });
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(mongo.getUri());
  app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (req.headers['x-user-id']) req.user = { id: req.headers['x-user-id'], role: req.headers['x-user-role'] }; next(); });
  app.post('/products', products.addProduct); app.put('/products/:id', products.editProduct);
  app.get('/products', products.getProducts); app.get('/products/status', getProductModerationStatus);
  app.put('/store', stores.updateStore);
  app.post('/tags/:productId', generateProductTags);
}, 60000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); }, 60000);
beforeEach(async () => {
  await Promise.all([Product, Store, User, NotificationOutbox].map(Model => Model.deleteMany({})));
  seller = await User.create({ username: 'safety-seller', email: 'safety@example.com', role: 'seller', currency: 'USD', status: 'active' });
  other = await User.create({ username: 'other-seller', email: 'other@example.com', role: 'seller', currency: 'USD', status: 'active' });
  store = await Store.create({ seller: seller._id, storeName: 'Travel Corner', storeSlug: 'travel-corner', description: 'Everyday travel accessories.', productCurrency: 'USD', visibility: { mode: 'global' } });
});

test('seller create, automatic approval, blocked edit and correction enforce public visibility and immutable ownership', async () => {
  const created = await request(app).post('/products').set(as(seller)).send({ product: { ...source, seller: other._id, moderationStatus: 'approved', isBlocked: false, rating: 5, catalogModeration: { revision: 'fake' } } });
  expect(created.status).toBe(200); expect(created.body.pending).toBe(true);
  expect(created.body.product.seller).toBe(String(seller._id)); expect(created.body.product.rating).toBe(0);
  expect(created.body.product.catalogModeration).toBeUndefined();
  const id = created.body.product._id;
  expect((await request(app).get('/products')).body.products).toHaveLength(0);
  expect((await processNextCatalogItem('product', approve)).status).toBe('approved');
  expect((await request(app).get('/products')).body.products).toHaveLength(1);
  const forbidden = await request(app).put(`/products/${id}`).set(as(other)).send({ product: { name: 'Other name' } });
  expect(forbidden.status).toBe(403);
  const blocked = await request(app).put(`/products/${id}`).set(as(seller)).send({ product: { description: 'fuck this', isBlocked: false, moderationStatus: 'approved' } });
  expect(blocked.status).toBe(200); expect(blocked.body.moderationStatus).toBe('blocked');
  expect(blocked.body.moderationReason).toMatch(/description:.*offensive/);
  expect((await request(app).get('/products')).body.products).toHaveLength(0);
  const repaired = await request(app).put(`/products/${id}`).set(as(seller)).send({ product: { description: source.description } });
  expect(repaired.body.pending).toBe(true);
  await processNextCatalogItem('product', approve);
  const priced = await request(app).put(`/products/${id}`).set(as(seller)).send({ product: { price: 25, stock: 9 } });
  expect(priced.body.moderationStatus).toBe('approved'); expect(priced.body.product.price).toBe(25);
});

test('status polling never exposes other sellers records or private queue metadata', async () => {
  const created = await request(app).post('/products').set(as(seller)).send({ product: source });
  const id = created.body.product._id;
  expect((await request(app).get('/products/status').set(as(other)).query({ ids: id })).body.products).toEqual([]);
  const own = await request(app).get('/products/status').set(as(seller)).query({ ids: id });
  expect(own.body.products[0].moderationStatus).toBe('pending'); expect(own.body.products[0].catalogModeration).toBeUndefined();
  expect((await request(app).get('/products/status').set(as(seller)).query({ ids: 'not-an-id' })).status).toBe(400);
  expect((await request(app).get('/products/status').set({ ...as(seller), 'x-user-role': 'user' }).query({ ids: id })).status).toBe(403);
});

test('store violations hide its catalog; corrective edits pass automatically without reactivating subscriptions', async () => {
  const blocked = await request(app).put('/store').set(as(seller)).send({ description: 'We sell sex toys', moderationStatus: 'approved' });
  expect(blocked.status).toBe(200); expect(blocked.body.store.moderationStatus).toBe('blocked');
  expect(blocked.body.store.catalogModeration).toBeUndefined(); expect(await Store.countDocuments(activeStoreQuery())).toBe(0);
  const fixed = await request(app).put('/store').set(as(seller)).send({ description: 'Useful travel accessories for everyday journeys.' });
  expect(fixed.status).toBe(200); expect(fixed.body.store.moderationStatus).toBe('pending');
  await processNextCatalogItem('store', approve);
  expect(await Store.countDocuments(activeStoreQuery())).toBe(1);
  expect((await Store.findById(store._id)).isActive).toBe(true);
});

test('durable seller notices dedupe, survive enqueue gaps and skip superseded decisions', async () => {
  const created = await request(app).post('/products').set(as(seller)).send({ product: { ...source, name: 'fuck' } });
  expect(created.body.moderationStatus).toBe('blocked');
  const product = await Product.findById(created.body.product._id).select('+catalogModeration').lean();
  await Promise.all([ensureCatalogModerationNotification('product', product), ensureCatalogModerationNotification('product', product)]);
  const records = await NotificationOutbox.find({ eventType: 'catalog.moderation' }).lean();
  expect(records).toHaveLength(4); expect(new Set(records.map(row => row.channel)).size).toBe(4);
  for (const row of records) {
    expect(JSON.stringify(row.payload)).not.toContain('fuck');
    expect(await verifySellerOperationalNotificationAuthority(row)).toBeNull();
  }
  await request(app).put(`/products/${product._id}`).set(as(seller)).send({ product: { name: source.name } });
  for (const row of records) expect((await verifySellerOperationalNotificationAuthority(row)).outcome).toBe('skipped');
  const badStore = { ...store.toObject(), description: 'fuck' };
  await Store.updateOne({ _id: store._id }, { $set: { description: badStore.description, ...stageStoreModeration(badStore, { previous: store }).fields } });
  await recoverCatalogModerationNotifications();
  expect(await NotificationOutbox.countDocuments({ aggregateType: 'Store' })).toBe(4);
});

test('existing-content intake is opt-in and never lifts independent store/account blocks', async () => {
  const saved = process.env.CATALOG_REVIEW_EXISTING;
  try {
    delete process.env.CATALOG_REVIEW_EXISTING;
    await Product.create({ ...source, seller: seller._id });
    expect(await enqueueUnreviewedCatalog()).toEqual({ queuedStores: 0, queuedProducts: 0 });
    process.env.CATALOG_REVIEW_EXISTING = 'true';
    expect(await enqueueUnreviewedCatalog()).toEqual({ queuedStores: 1, queuedProducts: 1 });
    expect((await Store.findById(store._id)).moderationPolicyVersion).toBe(POLICY_VERSION);
    expect(await enqueueUnreviewedCatalog()).toEqual({ queuedStores: 0, queuedProducts: 0 });
    await Store.create({ seller: other._id, storeName: 'Inactive Corner', storeSlug: 'inactive-corner', isActive: false });
    await Product.create({ ...source, seller: other._id });
    expect(await enqueueUnreviewedCatalog()).toEqual({ queuedStores: 0, queuedProducts: 0 });
  } finally { if (saved === undefined) delete process.env.CATALOG_REVIEW_EXISTING; else process.env.CATALOG_REVIEW_EXISTING = saved; }
});

test('web/mobile/WhatsApp AI tool writes use the same hold, reason and correction gate', async () => {
  const actor = seller.toObject();
  const added = await executeToolCall('add_product', source, actor);
  expect(added).toMatchObject({ success: true, pending: true });
  expect(added.requiredDisclosure).toMatch(/not public|public after approval/);
  const edited = await executeToolCall('edit_product', { productId: String(added.data.productId), updates: { description: 'fuck' } }, actor);
  expect(edited).toMatchObject({ success: true, blocked: true, moderationStatus: 'blocked' });
  expect(edited.requiredDisclosure).toMatch(/description:.*offensive/);
  const blockedStore = await executeToolCall('update_store', { updates: { description: 'We sell sex toys' } }, actor);
  expect(blockedStore).toMatchObject({ success: true, data: { moderationStatus: 'blocked' } });
  const storeInfo = await executeToolCall('get_my_store', {}, actor);
  expect(storeInfo.data.moderationStatus).toBe('blocked'); expect(storeInfo.requiredDisclosure).toMatch(/not published/);
  const repaired = await executeToolCall('update_store', { updates: { description: 'Travel accessories for everyday journeys.' } }, actor);
  expect(repaired).toMatchObject({ success: true, data: { moderationStatus: 'pending' } });
});

test('generated tags cannot bypass moderation or change another seller product', async () => {
  const created = await request(app).post('/products').set(as(seller)).send({ product: source });
  await processNextCatalogItem('product', approve);
  const id = created.body.product._id;
  callHF.mockClear(); callHF.mockResolvedValue('casual, everyday, all-season, fuck, relaxed, value, comfortable, daily');
  expect((await request(app).post(`/tags/${id}`).set(as(other))).status).toBe(403);
  expect(callHF).not.toHaveBeenCalled();
  const tagged = await request(app).post(`/tags/${id}`).set(as(seller));
  expect(tagged.status).toBe(200); expect(tagged.body.moderationStatus).toBe('blocked');
  expect((await Product.findById(id)).isBlocked).toBe(true);
});

test('a moderation-rejected name can be corrected even while its previous rename cooldown is active', async () => {
  const previous = store.toObject();
  await Store.updateOne({ _id: store._id }, { $set: { storeName: 'fuck', lastNameChangeAt: new Date(), ...stageStoreModeration({ ...previous, storeName: 'fuck' }, { previous }).fields } });
  // Simulate a legacy active cooldown retained from the previously approved name.
  await Store.updateOne({ _id: store._id }, { $set: { lastNameChangeAt: new Date() } });
  const corrected = await request(app).put('/store').set(as(seller)).send({ storeName: 'Travel Corner Goods' });
  expect(corrected.status).toBe(200); expect(corrected.body.store.moderationStatus).toBe('pending');
  await processNextCatalogItem('store', approve);
  expect((await Store.findById(store._id)).moderationStatus).toBe('approved');
});

test('new-store welcome notices never repeat an unreviewed or rejected name', async () => {
  const { enqueueStoreCreatedNotification } = require('../../services/sellerOperationalNotificationService');
  const pendingStore = { ...store.toObject(), storeName: 'fuck', storeSlug: 'offensive-name', moderationStatus: 'blocked' };
  await enqueueStoreCreatedNotification(pendingStore);
  const records = await NotificationOutbox.find({ eventType: 'store.created' }).lean();
  expect(records.length).toBeGreaterThan(0);
  for (const row of records) { expect(JSON.stringify(row.payload)).not.toContain('fuck'); expect(JSON.stringify(row.payload)).not.toContain('/store/offensive-name'); }
});
