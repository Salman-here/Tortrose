'use strict';
jest.mock('../../services/catalogModerationNotificationService', () => ({ ensureCatalogModerationNotification: jest.fn(async () => []), recoverCatalogModerationNotifications: jest.fn(async () => []) }));
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Product = require('../../models/Product');
const Store = require('../../models/Store');
const User = require('../../models/User');
const { stageProductModeration, publicProductFilter } = require('../../services/productModerationService');
const { stageStoreModeration } = require('../../services/catalogModerationService');
const { processNextCatalogItem } = require('../../services/catalogModerationWorker');
const { activeStoreQuery } = require('../../services/publicCatalogService');
const { POLICY_VERSION } = require('../../services/catalogContentPolicy');
let mongo, seller;
const item = { name: 'Cotton Travel Shirt', description: 'A breathable cotton shirt for everyday travel.', brand: 'Acme', category: 'Fashion', image: 'https://example.com/shirt.jpg', price: 20, currency: 'USD', stock: 10 };
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); }, 60000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); }, 60000);
beforeEach(async () => { await Promise.all([Product, Store, User].map(Model => Model.deleteMany({}))); seller = await User.create({ username: 'safety-seller', email: 'safety@example.com', role: 'seller', status: 'active' }); });
afterEach(() => jest.restoreAllMocks());
const createPending = async (extra = {}) => {
  const fields = stageProductModeration(item).fields;
  return Product.create({ ...item, seller: seller._id, ...fields, ...extra, moderationStatus: 'pending', isBlocked: true,
    moderationPolicyVersion: 'catalog-safety-2026-09-v1',
    catalogModeration: { ...fields.catalogModeration, policyVersion: 'catalog-safety-2026-09-v1',
      nextAttemptAt: new Date(Date.now() + 6 * 3600000), leaseUntil: new Date(Date.now() + 300000), leaseToken: 'old-ai-worker' } });
};

test('old pending AI submissions recover immediately using local rules without fetching or replacing images', async () => {
  const externalCall = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('No external review allowed'));
  const product = await createPending();
  expect(await Product.countDocuments(publicProductFilter())).toBe(0);
  expect((await processNextCatalogItem('product')).status).toBe('approved');
  expect(await Product.countDocuments(publicProductFilter())).toBe(1);
  const saved = await Product.findById(product._id).select('+catalogModeration').lean();
  expect(saved.moderationPolicyVersion).toBe(POLICY_VERSION);
  expect(saved.image).toBe(item.image); expect(saved.catalogModeration.nextAttemptAt).toBeNull();
  expect(saved.catalogModeration.leaseToken).toBe(''); expect(saved.isBlocked).toBe(false);
  expect(externalCall).not.toHaveBeenCalled();
});

test('recovery cannot overwrite a newer violating edit', async () => {
  const product = await createPending();
  const realUpdate = Product.findOneAndUpdate.bind(Product);
  jest.spyOn(Product, 'findOneAndUpdate').mockImplementationOnce((...args) => ({ lean: async () => {
    const current = await Product.findById(product._id).select('+catalogModeration').lean();
    await Product.updateOne({ _id: product._id }, { $set: { name: 'fuck', ...stageProductModeration({ ...current, name: 'fuck' }, { previous: current }).fields } });
    return realUpdate(...args).lean();
  } }));
  expect((await processNextCatalogItem('product')).status).toBe('superseded');
  expect((await Product.findById(product._id)).moderationStatus).toBe('blocked');
  expect(await Product.countDocuments(publicProductFilter())).toBe(0);
});

test('pending prohibited content is blocked locally instead of blindly released', async () => {
  const product = await createPending({ name: 'Silicone dildo' });
  expect((await processNextCatalogItem('product')).status).toBe('blocked');
  const saved = await Product.findById(product._id).lean();
  expect(saved.moderationSignals).toContain('sexual_goods'); expect(saved.isBlocked).toBe(true);
});

test('concurrent recovery commits only one decision', async () => {
  await createPending();
  const results = await Promise.all([processNextCatalogItem('product'), processNextCatalogItem('product')]);
  expect(results.filter(result => result?.status === 'approved')).toHaveLength(1);
});

test('store recovery preserves subscription blocks and completes a previously pending rename cooldown', async () => {
  const source = { seller: seller._id, storeName: 'Travel Corner Goods', storeSlug: 'travel-corner', description: 'Everyday travel accessories.', isActive: false };
  const fields = stageStoreModeration(source).fields;
  const store = await Store.create({ ...source, ...fields, moderationStatus: 'pending',
    catalogModeration: { ...fields.catalogModeration, lastApprovedName: 'Travel Corner' } });
  expect((await processNextCatalogItem('store')).status).toBe('approved');
  const saved = await Store.findById(store._id).lean();
  expect(saved.isActive).toBe(false); expect(saved.lastNameChangeAt).toBeInstanceOf(Date);
  expect(await Store.countDocuments(activeStoreQuery())).toBe(0);
});

test('previously approved AI-era listings stay available and blocked listings are not auto-released', async () => {
  await Product.create({ ...item, seller: seller._id, moderationStatus: 'approved', moderationPolicyVersion: 'catalog-safety-2026-09-v1', moderationReviewedAt: new Date() });
  const blocked = await Product.create({ ...item, name: 'Restricted item', seller: seller._id, moderationStatus: 'blocked', isBlocked: true, moderationPolicyVersion: 'catalog-safety-2026-09-v1' });
  expect(await processNextCatalogItem('product')).toBeNull();
  expect(await Product.countDocuments(publicProductFilter())).toBe(1);
  expect((await Product.findById(blocked._id)).isBlocked).toBe(true);
});
