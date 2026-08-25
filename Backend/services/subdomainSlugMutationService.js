'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');
const Store = require('../models/Store');
const { ensureSubdomainLegacyLedger } = require('./stripeEntitlementPaymentService');
const {
  acquireSubdomainSlugChangeLock,
  releaseSubdomainResourceLock,
} = require('./subdomainResourceLockService');
const { validateStoreSlug } = require('../utils/storeSlug');

const slugMutationError = (message, code, statusCode, details = {}) => Object.assign(
  new Error(message),
  { code, statusCode, ...details },
);

const normalizeActor = actor => {
  const actorType = ['seller', 'admin', 'ai', 'system'].includes(actor?.type)
    ? actor.type
    : 'system';
  const actorId = mongoose.Types.ObjectId.isValid(String(actor?.id || ''))
    ? new mongoose.Types.ObjectId(String(actor.id))
    : null;
  return {
    actorType,
    actorId,
    reason: String(actor?.reason || '').trim().slice(0, 240),
  };
};

const hasCurrentPurchasedOwnership = (store, now = new Date()) => Boolean(
  store?.subdomainPurchase?.isPurchased
  && store.subdomainPurchase.expiresAt
  && new Date(store.subdomainPurchase.expiresAt) > now
);

/**
 * Atomically changes the public Store slug behind the same resource lock used
 * by paid Stripe Checkout. Every caller (seller UI, AI, admin) must use this
 * boundary so a Checkout can never be charged for a slug that moves before its
 * signed completion webhook runs.
 */
const changeStoreSlug = async ({
  storeId,
  sellerId,
  expectedSlug,
  newSlug,
  confirmPurchasedForfeit = false,
  actor,
  additionalSet = {},
  requiredStoreFilter = {},
  updateCooldown = true,
}) => {
  const validation = validateStoreSlug(newSlug);
  if (!validation.valid) {
    throw slugMutationError(validation.msg, validation.code, 400);
  }
  const normalizedNewSlug = validation.slug;
  const normalizedExpectedSlug = String(expectedSlug || '').trim().toLowerCase();
  if (!storeId || !sellerId || !normalizedExpectedSlug) {
    throw slugMutationError(
      'The current store and subdomain are required for a safe change.',
      'SUBDOMAIN_CHANGE_IDENTITY_INVALID',
      400,
    );
  }
  if (normalizedNewSlug === normalizedExpectedSlug) {
    const unchanged = await Store.findOne({
      _id: storeId,
      seller: sellerId,
      storeSlug: normalizedExpectedSlug,
    });
    if (!unchanged) {
      throw slugMutationError(
        'The store changed while this update was being prepared. Refresh and try again.',
        'SUBDOMAIN_CHANGE_STALE',
        409,
      );
    }
    return { store: unchanged, changed: false, forfeitedPurchasedOwnership: false };
  }

  const lockResult = await acquireSubdomainSlugChangeLock({
    storeId,
    sellerId,
    expectedSlug: normalizedExpectedSlug,
  });
  if (!lockResult.acquired) {
    throw slugMutationError(
      'A subdomain Checkout or another slug change is currently in progress. Try again after it finishes.',
      'SUBDOMAIN_RESOURCE_LOCKED',
      423,
    );
  }

  const lockIdentity = { storeId, sellerId, token: lockResult.token };
  let committed = false;
  try {
    // Re-read all ownership and risk predicates after acquiring the lock. The
    // pre-lock document is never authoritative at this boundary.
    const lockedStoreIdentity = {
      _id: storeId,
      seller: sellerId,
      storeSlug: normalizedExpectedSlug,
      'subdomainResourceLock.kind': 'slug_change',
      'subdomainResourceLock.token': lockResult.token,
    };
    const store = await Store.findOne({
      $and: [lockedStoreIdentity, requiredStoreFilter],
    });
    if (!store) {
      throw slugMutationError(
        'The store changed while this update was being prepared. Refresh and try again.',
        'SUBDOMAIN_CHANGE_STALE',
        409,
      );
    }
    if (store.subdomainPurchase?.paymentRiskState === 'open') {
      throw slugMutationError(
        'This purchased subdomain has an unresolved Stripe payment dispute. It cannot be changed until the dispute is resolved.',
        'SUBDOMAIN_PAYMENT_RISK_OPEN',
        423,
      );
    }

    const now = new Date();
    const forfeitsPurchasedOwnership = hasCurrentPurchasedOwnership(store, now);
    const hasProjectedPurchase = Boolean(
      store.subdomainPurchase?.isPurchased
      && Number.isFinite(new Date(store.subdomainPurchase?.expiresAt || 0).getTime())
    );
    if (forfeitsPurchasedOwnership && confirmPurchasedForfeit !== true) {
      throw slugMutationError(
        `Changing "${store.storeSlug}.rozare.com" will forfeit its remaining paid ownership. Explicit confirmation is required.`,
        'SUBDOMAIN_PURCHASE_FORFEIT_CONFIRMATION_REQUIRED',
        400,
        {
          requiresConfirmation: true,
          currentSubdomain: store.storeSlug,
          newSubdomain: normalizedNewSlug,
        },
      );
    }

    // Materialize any legacy projection into an immutable old-slug ledger
    // before clearing it. Refunds/disputes can then affect only that resource.
    if (hasProjectedPurchase) await ensureSubdomainLegacyLedger(store);

    const duplicate = await Store.exists({
      storeSlug: normalizedNewSlug,
      _id: { $ne: store._id },
    });
    if (duplicate) {
      throw slugMutationError(
        'This subdomain is already taken by another store.',
        'SUBDOMAIN_ALREADY_TAKEN',
        409,
      );
    }

    const normalizedActor = normalizeActor(actor);
    const set = {
      ...additionalSet,
      storeSlug: normalizedNewSlug,
      ...(updateCooldown ? { lastSlugChangeAt: now } : {}),
      'subdomainResourceLock.kind': null,
      'subdomainResourceLock.token': '',
      'subdomainResourceLock.expiresAt': null,
    };
    // A projection is always resource-specific, including expired/lost legacy
    // state. Clear it on every slug move so no old payment identity appears to
    // belong to the replacement hostname. Replay tombstones remain preserved.
    Object.assign(set, {
      'subdomainPurchase.isPurchased': false,
      'subdomainPurchase.purchasedAt': null,
      'subdomainPurchase.expiresAt': null,
      'subdomainPurchase.stripePaymentId': '',
      // Keep processedPaymentIds as replay tombstones. Financial attribution
      // itself lives in StripeEntitlementPayment.resourceKey.
      'subdomainPurchase.paymentRiskState': 'none',
      'subdomainPurchase.paymentRiskUpdatedAt': null,
      'subdomainPurchase.removalScheduledAt': null,
    });

    const updated = await Store.findOneAndUpdate({
      $and: [lockedStoreIdentity, requiredStoreFilter],
    }, {
      $set: set,
      $push: {
        subdomainSlugHistory: {
          $each: [{
            fromSlug: normalizedExpectedSlug,
            toSlug: normalizedNewSlug,
            actorType: normalizedActor.actorType,
            actorId: normalizedActor.actorId,
            reason: normalizedActor.reason,
            purchasedOwnershipForfeited: forfeitsPurchasedOwnership,
            changedAt: now,
          }],
          $slice: -100,
        },
      },
    }, { new: true, runValidators: true });
    if (!updated) {
      throw slugMutationError(
        'The store changed while this update was being committed. Refresh and try again.',
        'SUBDOMAIN_CHANGE_STALE',
        409,
      );
    }
    committed = true;
    return {
      store: updated,
      changed: true,
      forfeitedPurchasedOwnership: forfeitsPurchasedOwnership,
      previousSlug: normalizedExpectedSlug,
    };
  } catch (error) {
    // Preserve the database's unique-index error as a stable public contract.
    if (error?.code === 11000) {
      throw slugMutationError(
        'This subdomain is already taken by another store.',
        'SUBDOMAIN_ALREADY_TAKEN',
        409,
      );
    }
    throw error;
  } finally {
    if (!committed) {
      await releaseSubdomainResourceLock(lockIdentity).catch(() => {});
    }
  }
};

const releaseExpiredStoreSlug = async ({
  storeId,
  sellerId,
  expectedSlug,
  now = new Date(),
  reason,
  releasedPrefix = 'released',
}) => {
  if (!storeId || !sellerId || !expectedSlug) return { released: false, store: null };
  const safePrefix = releasedPrefix === 'removed' ? 'removed' : 'released';
  const releasedSlug = `${safePrefix}-${String(storeId).slice(-8)}-${now.getTime().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    const result = await changeStoreSlug({
      storeId,
      sellerId,
      expectedSlug,
      newSlug: releasedSlug,
      actor: {
        type: 'system',
        reason: reason || 'Inactive-store subdomain grace period expired',
      },
      additionalSet: {
        'subdomainPurchase.removalNotice.previousSlug': String(expectedSlug).trim().toLowerCase(),
        'subdomainPurchase.removalNotice.removedAt': now,
        'subdomainPurchase.removalNotice.notificationEnqueuedAt': null,
      },
      updateCooldown: false,
      requiredStoreFilter: {
        isActive: false,
        'subdomainPurchase.removalScheduledAt': { $lte: now, $ne: null },
        $or: [
          { 'subdomainPurchase.isPurchased': { $ne: true } },
          { 'subdomainPurchase.expiresAt': { $lte: now } },
        ],
      },
    });
    return { released: result.changed, store: result.store, previousSlug: result.previousSlug };
  } catch (error) {
    if (['SUBDOMAIN_RESOURCE_LOCKED', 'SUBDOMAIN_CHANGE_STALE'].includes(error?.code)) {
      return { released: false, store: null, code: error.code };
    }
    throw error;
  }
};

module.exports = {
  changeStoreSlug,
  hasCurrentPurchasedOwnership,
  releaseExpiredStoreSlug,
};
