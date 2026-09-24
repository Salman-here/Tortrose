'use strict';
jest.mock('../../services/catalogModerationNotificationService', () => ({ ensureCatalogModerationNotification: jest.fn(async () => []), recoverCatalogModerationNotifications: jest.fn(async () => []) }));
jest.mock('../../services/catalogModerationAssets', () => ({ pinCatalogImages: jest.fn(async (kind, entity) => ({ snapshot: require('../../services/catalogContentPolicy').contentSnapshot(kind, entity), fields: {} })) }));
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Product = require('../../models/Product');
const Store = require('../../models/Store');
const User = require('../../models/User');
const { stageProductModeration, publicProductFilter } = require('../../services/productModerationService');
const { stageStoreModeration } = require('../../services/catalogModerationService');
const { processNextCatalogItem } = require('../../services/catalogModerationWorker');
const { activeStoreQuery } = require('../../services/publicCatalogService');
let mongo, seller;
const item = { name: 'Cotton Travel Shirt', description: 'A breathable cotton shirt for everyday travel.', brand: 'Acme', category: 'Fashion', image: 'https://example.com/shirt.jpg', price: 20, currency: 'USD', stock: 10 };
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); }, 60000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); }, 60000);
beforeEach(async () => { await Promise.all([Product, Store, User].map(Model => Model.deleteMany({}))); seller = await User.create({ username: 'safety-seller', email: 'safety@example.com', role: 'seller', status: 'active' }); });
const createPending = async () => Product.create({ ...item, seller: seller._id, ...stageProductModeration(item).fields });
const approve = async () => ({ status: 'approved', violations: [] });

test('clean products are absent from the catalog until the automatic worker approves them', async () => {
  const product = await createPending();
  expect(await Product.countDocuments(publicProductFilter())).toBe(0);
  expect((await processNextCatalogItem('product', { review: approve })).status).toBe('approved');
  expect(await Product.countDocuments(publicProductFilter())).toBe(1);
  const saved = await Product.findById(product._id).lean();
  expect(saved.catalogModeration).toBeUndefined(); expect(saved.isBlocked).toBe(false);
});

test('an approval for an older version cannot release a newer violating edit', async () => {
  const product = await createPending();
  const result = await processNextCatalogItem('product', { review: async () => {
    const current = await Product.findById(product._id).select('+catalogModeration').lean();
    const update = { ...current, name: 'Fuck' };
    await Product.updateOne({ _id: product._id }, { $set: { name: update.name, ...stageProductModeration(update, { previous: current }).fields } });
    return approve();
  } });
  expect(result.status).toBe('superseded');
  const current = await Product.findById(product._id).lean();
  expect(current.moderationStatus).toBe('blocked'); expect(current.moderationReason).toMatch(/offensive/);
  expect(await Product.countDocuments(publicProductFilter())).toBe(0);
});

test('provider failure retains the hold and schedules a retry instead of leaking content', async () => {
  const product = await createPending();
  const result = await processNextCatalogItem('product', { review: async () => { throw Object.assign(new Error('private provider details'), { code: 'UPSTREAM_FAILURE' }); } });
  expect(result.status).toBe('pending');
  const current = await Product.findById(product._id).select('+catalogModeration').lean();
  expect(current.isBlocked).toBe(true); expect(current.catalogModeration.attempts).toBe(1);
  expect(current.catalogModeration.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  expect(current.moderationReason).not.toContain('private provider');
  expect(await processNextCatalogItem('product', { review: approve })).toBeNull();
});

test('simultaneous workers cannot claim the same content', async () => {
  await createPending(); const review = jest.fn(approve);
  const results = await Promise.all([processNextCatalogItem('product', { review }), processNextCatalogItem('product', { review })]);
  expect(review).toHaveBeenCalledTimes(1); expect(results.filter(Boolean)).toHaveLength(1);
});

test('store approval preserves subscription blocks, while content edits consume rename cooldown only after approval', async () => {
  const source = { seller: seller._id, storeName: 'Travel Corner', storeSlug: 'travel-corner', description: 'Everyday travel accessories.', isActive: false };
  const store = await Store.create({ ...source, ...stageStoreModeration(source).fields });
  expect(await Store.countDocuments(activeStoreQuery())).toBe(0);
  expect((await processNextCatalogItem('store', { review: approve })).status).toBe('approved');
  const approved = await Store.findById(store._id).select('+catalogModeration').lean();
  expect(approved.isActive).toBe(false); expect(approved.catalogModeration.lastApprovedName).toBe(source.storeName);
  const candidate = { ...approved, storeName: 'Travel Corner Goods' };
  const staged = stageStoreModeration(candidate, { previous: approved });
  expect(staged.fields.lastNameChangeAt).toBeNull();
  await Store.updateOne({ _id: store._id }, { $set: { storeName: candidate.storeName, ...staged.fields } });
  await processNextCatalogItem('store', { review: approve });
  expect((await Store.findById(store._id)).lastNameChangeAt).toBeInstanceOf(Date);
  expect(await Store.countDocuments(activeStoreQuery())).toBe(0);
});
