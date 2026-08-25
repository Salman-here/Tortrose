'use strict';

const crypto = require('crypto');
const Store = require('../models/Store');

const checkoutLockExpiry = checkoutClaimExpiry => {
  const claimMs = new Date(checkoutClaimExpiry || 0).getTime();
  const baseMs = Number.isFinite(claimMs) && claimMs > Date.now() ? claimMs : Date.now();
  // Signed completion/expiry webhooks normally release this immediately. The
  // safety tail protects a successfully charged but delayed completion event.
  return new Date(baseMs + 7 * 24 * 60 * 60 * 1000);
};

const acquireLock = async ({ storeId, sellerId, expectedSlug, kind, token, expiresAt }) => {
  const now = new Date();
  return Store.findOneAndUpdate({
    _id: storeId,
    seller: sellerId,
    ...(expectedSlug ? { storeSlug: expectedSlug } : {}),
    $or: [
      { 'subdomainResourceLock.token': token },
      { 'subdomainResourceLock.expiresAt': { $lte: now } },
      { 'subdomainResourceLock.expiresAt': null },
      { 'subdomainResourceLock.expiresAt': { $exists: false } },
    ],
  }, {
    $set: {
      'subdomainResourceLock.kind': kind,
      'subdomainResourceLock.token': token,
      'subdomainResourceLock.expiresAt': expiresAt,
    },
  }, { new: true });
};

const acquireSubdomainCheckoutLock = async ({ storeId, sellerId, storeSlug, token, checkoutClaimExpiry: claimExpiry }) => {
  if (!token) throw new Error('Subdomain Checkout lock requires its claim token.');
  return acquireLock({
    storeId,
    sellerId,
    expectedSlug: storeSlug,
    kind: 'checkout',
    token,
    expiresAt: checkoutLockExpiry(claimExpiry),
  });
};

const acquireSubdomainSlugChangeLock = async ({ storeId, sellerId, expectedSlug }) => {
  const token = crypto.randomUUID();
  const store = await acquireLock({
    storeId,
    sellerId,
    expectedSlug,
    kind: 'slug_change',
    token,
    expiresAt: new Date(Date.now() + 2 * 60 * 1000),
  });
  return store ? { acquired: true, token, store } : { acquired: false, token: null, store: null };
};

const releaseSubdomainResourceLock = async ({ storeId, sellerId, token }) => {
  if (!storeId || !sellerId || !token) return false;
  const result = await Store.updateOne({
    _id: storeId,
    seller: sellerId,
    'subdomainResourceLock.token': token,
  }, {
    $set: {
      'subdomainResourceLock.kind': null,
      'subdomainResourceLock.token': '',
      'subdomainResourceLock.expiresAt': null,
    },
  });
  return result.modifiedCount > 0;
};

module.exports = {
  acquireSubdomainCheckoutLock,
  acquireSubdomainSlugChangeLock,
  releaseSubdomainResourceLock,
};
