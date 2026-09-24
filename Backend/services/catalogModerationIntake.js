'use strict';
const { POLICY_VERSION, reviewExistingCatalog } = require('./catalogContentPolicy');
const { stageStoreModeration } = require('./catalogModerationService');

// Re-check managed content after a policy change. Existing, unmanaged content
// is included only when that separate catalog-wide rollout is enabled.
async function enqueueUnreviewedCatalog({ limit = 20 } = {}) {
  const Store = require('../models/Store'), Product = require('../models/Product'), User = require('../models/User');
  const { stageProductModeration } = require('./productModerationService');
  const oldVersion = reviewExistingCatalog() ? { $ne: POLICY_VERSION } : { $nin: [POLICY_VERSION, '', null] };
  const activeSellerLookup = { $lookup: { from: User.collection.name, localField: 'seller', foreignField: '_id', pipeline: [{ $match: { role: 'seller', status: 'active' } }, { $project: { _id: 1 } }], as: '_eligibleSeller' } };
  const stores = await Store.aggregate([
    { $match: { isActive: true, blockedAt: null, moderationPolicyVersion: oldVersion } },
    activeSellerLookup, { $match: { '_eligibleSeller.0': { $exists: true } } },
    { $sort: { _id: 1 } }, { $limit: limit }, { $project: { _eligibleSeller: 0 } },
  ]);
  let queuedStores = 0, queuedProducts = 0;
  for (const store of stores) {
    const { fields } = stageStoreModeration(store, { previous: store });
    const result = await Store.updateOne({ _id: store._id, moderationPolicyVersion: oldVersion, ...(store.updatedAt ? { updatedAt: store.updatedAt } : {}) }, { $set: fields, $inc: { __v: 1 } });
    queuedStores += result.modifiedCount || 0;
  }
  const products = await Product.aggregate([
    { $match: { isBlocked: { $ne: true }, moderationStatus: { $nin: ['blocked', 'pending'] }, moderationPolicyVersion: oldVersion } },
    activeSellerLookup,
    { $lookup: { from: Store.collection.name, localField: 'seller', foreignField: 'seller', pipeline: [{ $match: { isActive: true, blockedAt: null } }, { $project: { _id: 1 } }], as: '_eligibleStore' } },
    { $match: { $or: [{ seller: null }, { '_eligibleSeller.0': { $exists: true }, '_eligibleStore.0': { $exists: true } }] } },
    { $sort: { _id: 1 } }, { $limit: limit }, { $project: { _eligibleSeller: 0, _eligibleStore: 0 } },
  ]);
  for (const product of products) {
    const { fields } = stageProductModeration(product, { previous: product });
    const result = await Product.updateOne({ _id: product._id, isBlocked: { $ne: true }, moderationPolicyVersion: oldVersion, ...(product.updatedAt ? { updatedAt: product.updatedAt } : {}) }, { $set: fields, $inc: { __v: 1 } });
    queuedProducts += result.modifiedCount || 0;
  }
  return { queuedStores, queuedProducts };
}
module.exports = { enqueueUnreviewedCatalog };
