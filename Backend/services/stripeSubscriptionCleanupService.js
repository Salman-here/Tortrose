'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const StripeSubscriptionCleanup = require('../models/StripeSubscriptionCleanup');
const SellerSubscription = require('../models/SellerSubscription');
const User = require('../models/User');
const { stripe } = require('../config/stripe');
const { enqueueNotificationEvent, outboxError } = require('./notificationOutboxService');

const CLEANUP_LEASE_MS = 2 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_BATCH_LIMIT = 10;

const cleanRequired = (value, field, maxLength, pattern = null) => {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > maxLength) {
    throw outboxError(`${field} is invalid.`, 'STRIPE_SUBSCRIPTION_CLEANUP_INVALID');
  }
  if (pattern && !pattern.test(value)) {
    throw outboxError(`${field} is invalid.`, 'STRIPE_SUBSCRIPTION_CLEANUP_INVALID');
  }
  return value;
};

const optionalStripeId = (value, field, prefix) => {
  if (value === null || value === undefined || value === '') return '';
  return cleanRequired(value, field, 255, new RegExp(`^${prefix}_[A-Za-z0-9_]+$`));
};

const asDate = (value, field) => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw outboxError(`${field} is invalid.`, 'STRIPE_SUBSCRIPTION_CLEANUP_INVALID');
  }
  return value;
};

const markTransactionRetryable = error => {
  if (typeof error?.addErrorLabel === 'function') {
    error.addErrorLabel('TransientTransactionError');
  } else {
    const labels = Array.isArray(error?.errorLabels) ? error.errorLabels : [];
    if (!labels.includes('TransientTransactionError')) {
      error.errorLabels = [...labels, 'TransientTransactionError'];
    }
  }
  return error;
};

const shortError = error => String(error?.message || 'Stripe cancellation could not be confirmed.')
  .replace(/[\r\n]+/g, ' ')
  .slice(0, 1000);

const errorCode = error => String(
  error?.code || error?.type || error?.statusCode || 'STRIPE_CANCELLATION_UNCONFIRMED',
).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);

const escapeHtml = value => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const cleanupKeyFor = ({ seller, staleStripeSubscriptionId, replacementStripeSubscriptionId, reason }) => (
  crypto.createHash('sha256').update(JSON.stringify({
    schemaVersion: 1,
    seller: String(seller),
    staleStripeSubscriptionId,
    replacementStripeSubscriptionId,
    reason,
  })).digest('hex')
);

const sameCleanupEvidence = (record, input) => (
  record?.cleanupKey === input.cleanupKey
  && String(record?.seller) === String(input.seller)
  && record?.staleStripeSubscriptionId === input.staleStripeSubscriptionId
  && record?.replacementStripeSubscriptionId === input.replacementStripeSubscriptionId
  && record?.stripeCustomerId === input.stripeCustomerId
  && record?.reason === input.reason
);

async function ensureStripeSubscriptionCleanup({
  seller,
  staleStripeSubscriptionId,
  replacementStripeSubscriptionId = '',
  stripeCustomerId = '',
  reason,
  sourceReference,
  occurredAt,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}, { session = null } = {}) {
  if (!mongoose.isValidObjectId(seller)) {
    throw outboxError('Cleanup seller id is invalid.', 'STRIPE_SUBSCRIPTION_CLEANUP_INVALID');
  }
  const input = {
    seller: new mongoose.Types.ObjectId(seller),
    staleStripeSubscriptionId: cleanRequired(
      staleStripeSubscriptionId,
      'Cleanup Stripe subscription id',
      255,
      /^sub_[A-Za-z0-9_]+$/,
    ),
    replacementStripeSubscriptionId: optionalStripeId(
      replacementStripeSubscriptionId,
      'Cleanup replacement Stripe subscription id',
      'sub',
    ),
    stripeCustomerId: optionalStripeId(stripeCustomerId, 'Cleanup Stripe customer id', 'cus'),
    reason: cleanRequired(reason, 'Cleanup reason', 80),
    sourceReference: cleanRequired(sourceReference, 'Cleanup source reference', 255),
    occurredAt: asDate(occurredAt, 'Cleanup event timestamp'),
  };
  if (input.staleStripeSubscriptionId === input.replacementStripeSubscriptionId) {
    throw outboxError(
      'Cleanup target cannot equal the replacement subscription.',
      'STRIPE_SUBSCRIPTION_CLEANUP_INVALID',
    );
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 25) {
    throw outboxError('Cleanup maxAttempts is invalid.', 'STRIPE_SUBSCRIPTION_CLEANUP_INVALID');
  }
  input.cleanupKey = cleanupKeyFor(input);

  const replayQuery = {
    $or: [
      { cleanupKey: input.cleanupKey },
      { staleStripeSubscriptionId: input.staleStripeSubscriptionId },
    ],
  };
  const existing = await StripeSubscriptionCleanup.findOne(replayQuery).session(session);
  if (existing) {
    if (!sameCleanupEvidence(existing, input) || existing.maxAttempts !== maxAttempts) {
      throw outboxError(
        'Stripe subscription cleanup replay conflicts with its immutable evidence.',
        'STRIPE_SUBSCRIPTION_CLEANUP_IDEMPOTENCY_CONFLICT',
      );
    }
    return existing;
  }

  let record;
  try {
    [record] = await StripeSubscriptionCleanup.create([{
      ...input,
      maxAttempts,
      status: 'pending',
      nextAttemptAt: new Date(),
    }], { session });
  } catch (error) {
    if (Number(error?.code) !== 11000) throw error;
    if (session?.inTransaction?.()) {
      // MongoDB has already aborted a transaction that lost the unique-key
      // race. Never query using that dead session; let withTransaction replay
      // the complete unit of work and verify the winner on a fresh snapshot.
      throw markTransactionRetryable(error);
    }
    record = await StripeSubscriptionCleanup.findOne(replayQuery).session(session);
    if (!record || !sameCleanupEvidence(record, input) || record.maxAttempts !== maxAttempts) {
      throw outboxError(
        'Stripe subscription cleanup replay conflicts with its immutable evidence.',
        'STRIPE_SUBSCRIPTION_CLEANUP_IDEMPOTENCY_CONFLICT',
      );
    }
  }
  return record;
}

const alertBody = cleanup => {
  const replacement = cleanup.replacementStripeSubscriptionId
    ? ` Replacement subscription ${cleanup.replacementStripeSubscriptionId} remains authoritative.`
    : '';
  return `Cancellation of Stripe subscription ${cleanup.staleStripeSubscriptionId} could not be confirmed. It may continue billing.${replacement} Review the durable cleanup record before making billing changes.`;
};

const resolutionBody = cleanup => (
  `Stripe subscription ${cleanup.staleStripeSubscriptionId} is now confirmed cancelled. The previously escalated replacement-cleanup risk is resolved.`
);

async function enqueueCleanupAdminNotifications(cleanup, { resolved = false } = {}) {
  const admins = await User.find({ role: 'admin', status: 'active' }).select('_id').lean();
  if (!admins.length) {
    throw outboxError(
      'No active administrator is available for the Stripe subscription cleanup alert.',
      'SUBSCRIPTION_CLEANUP_ADMIN_UNAVAILABLE',
    );
  }
  const title = resolved
    ? 'Stripe subscription cleanup resolved'
    : 'Stripe subscription cleanup requires review';
  const body = resolved ? resolutionBody(cleanup) : alertBody(cleanup);
  const eventSuffix = resolved ? 'resolved' : 'required';
  const eventType = resolved ? 'subscription.cleanup_resolved' : 'subscription.cleanup_required';
  const records = [];
  for (const admin of admins) {
    records.push(...await enqueueNotificationEvent({
      eventKey: `subscription-cleanup:${cleanup.cleanupKey}:${eventSuffix}:admin:${String(admin._id)}:v1`,
      eventType,
      aggregateType: 'StripeSubscriptionCleanup',
      aggregateId: cleanup._id,
      occurredAt: resolved ? cleanup.completedAt : cleanup.manualReview.requiredAt,
      financial: false,
      recipient: {
        kind: 'user',
        audienceRole: 'admin',
        user: admin._id,
        destinationPolicy: 'current_user',
      },
      channels: ['inapp', 'push', 'email', 'whatsapp'],
      templates: {
        inapp: { title, body },
        push: { title, body },
        email: {
          subject: title,
          text: body,
          html: `<p>${escapeHtml(body)}</p>`,
        },
        whatsapp: { message: `${title}\n\n${body}` },
      },
      metadata: {
        category: 'subscription',
        linkTo: '/admin-dashboard/payments',
        channelId: 'general',
        whatsappCategory: resolved
          ? 'subscription_cleanup_resolved'
          : 'subscription_cleanup_review',
        data: {
          type: resolved
            ? 'subscription_cleanup_resolved'
            : 'subscription_cleanup_review_required',
          cleanupId: String(cleanup._id),
          sellerId: String(cleanup.seller),
          reason: cleanup.reason,
        },
      },
    }));
  }
  return records;
}

async function ensureCleanupEscalationNotified(cleanupId) {
  const cleanup = await StripeSubscriptionCleanup.findById(cleanupId);
  if (!cleanup?.manualReview?.requiredAt || cleanup.manualReview.notificationEnqueuedAt) return true;
  try {
    await enqueueCleanupAdminNotifications(cleanup);
    await StripeSubscriptionCleanup.updateOne({
      _id: cleanup._id,
      'manualReview.requiredAt': cleanup.manualReview.requiredAt,
      'manualReview.notificationEnqueuedAt': null,
    }, {
      $set: {
        'manualReview.notificationEnqueuedAt': new Date(),
        'manualReview.notificationLastError': '',
      },
    });
    return true;
  } catch (error) {
    await StripeSubscriptionCleanup.updateOne({ _id: cleanup._id }, {
      $set: { 'manualReview.notificationLastError': shortError(error) },
    });
    return false;
  }
}

async function ensureCleanupResolutionNotified(cleanupId) {
  let cleanup = await StripeSubscriptionCleanup.findById(cleanupId);
  if (
    cleanup?.status !== 'completed'
    || !cleanup.manualReview?.requiredAt
    || cleanup.manualReview.resolutionNotificationEnqueuedAt
  ) return true;
  if (!cleanup.manualReview.notificationEnqueuedAt) {
    const escalationNotified = await ensureCleanupEscalationNotified(cleanup._id);
    if (!escalationNotified) return false;
    cleanup = await StripeSubscriptionCleanup.findById(cleanup._id);
    if (!cleanup?.manualReview?.notificationEnqueuedAt) return false;
  }
  try {
    await enqueueCleanupAdminNotifications(cleanup, { resolved: true });
    await StripeSubscriptionCleanup.updateOne({
      _id: cleanup._id,
      status: 'completed',
      'manualReview.requiredAt': cleanup.manualReview.requiredAt,
      'manualReview.resolutionNotificationEnqueuedAt': null,
    }, {
      $set: {
        'manualReview.resolutionNotificationEnqueuedAt': new Date(),
        'manualReview.resolutionNotificationLastError': '',
      },
    });
    return true;
  } catch (error) {
    await StripeSubscriptionCleanup.updateOne({ _id: cleanup._id }, {
      $set: { 'manualReview.resolutionNotificationLastError': shortError(error) },
    });
    return false;
  }
}

const retryDelayMs = attempts => Math.min(6 * 60 * 60 * 1000, 60_000 * (2 ** Math.max(0, attempts - 1)));

async function claimCleanup({ cleanupId = null, workerId, now, leaseMs = CLEANUP_LEASE_MS }) {
  const owner = cleanRequired(workerId, 'Cleanup worker id', 120);
  const token = crypto.randomUUID();
  const eligibility = {
    $expr: { $lt: ['$attempts', '$maxAttempts'] },
    $or: [
      { status: { $in: ['pending', 'retry'] }, nextAttemptAt: { $lte: now } },
      { status: 'processing', leaseExpiresAt: { $lte: now } },
    ],
  };
  if (cleanupId) eligibility._id = cleanupId;
  return StripeSubscriptionCleanup.findOneAndUpdate(eligibility, {
    $set: {
      status: 'processing',
      leaseToken: token,
      leaseOwner: owner,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      lastAttemptAt: now,
    },
    $inc: { attempts: 1 },
  }, { new: true }).select('+leaseToken');
}

async function markCleanupCompleted(cleanup, providerStatus, now) {
  const result = await StripeSubscriptionCleanup.updateOne({
    _id: cleanup._id,
    status: 'processing',
    leaseToken: cleanup.leaseToken,
  }, {
    $set: {
      status: 'completed',
      providerStatus: String(providerStatus || 'canceled').slice(0, 80),
      cancelledAt: now,
      completedAt: now,
      nextAttemptAt: now,
      leaseToken: null,
      leaseOwner: '',
      leaseExpiresAt: null,
      lastErrorCode: '',
      lastError: '',
      'manualReview.resolvedAt': cleanup.manualReview?.requiredAt ? now : null,
    },
  });
  if (result.modifiedCount !== 1) {
    throw outboxError('Stripe subscription cleanup lease was lost.', 'STRIPE_SUBSCRIPTION_CLEANUP_LEASE_LOST');
  }
  await ensureCleanupEscalationNotified(cleanup._id);
  await ensureCleanupResolutionNotified(cleanup._id);
  return StripeSubscriptionCleanup.findById(cleanup._id);
}

async function markCleanupUnconfirmed(cleanup, error, now, { forceManualReview = false } = {}) {
  const exhausted = cleanup.attempts >= cleanup.maxAttempts;
  const status = forceManualReview || exhausted ? 'manual_review' : 'retry';
  const reasonCode = forceManualReview
    ? errorCode(error)
    : 'STRIPE_CANCELLATION_UNCONFIRMED';
  const result = await StripeSubscriptionCleanup.updateOne({
    _id: cleanup._id,
    status: 'processing',
    leaseToken: cleanup.leaseToken,
  }, {
    $set: {
      status,
      nextAttemptAt: status === 'retry'
        ? new Date(now.getTime() + retryDelayMs(cleanup.attempts))
        : now,
      leaseToken: null,
      leaseOwner: '',
      leaseExpiresAt: null,
      firstFailureAt: cleanup.firstFailureAt || now,
      lastErrorCode: errorCode(error),
      lastError: shortError(error),
      'manualReview.requiredAt': cleanup.manualReview?.requiredAt || now,
      'manualReview.reasonCode': reasonCode,
      'manualReview.resolvedAt': null,
    },
  });
  if (result.modifiedCount !== 1) {
    throw outboxError('Stripe subscription cleanup lease was lost.', 'STRIPE_SUBSCRIPTION_CLEANUP_LEASE_LOST');
  }
  await ensureCleanupEscalationNotified(cleanup._id);
  return StripeSubscriptionCleanup.findById(cleanup._id);
}

async function processClaimedStripeSubscriptionCleanup(cleanup, {
  stripeClient,
  now,
}) {
  const timestamp = now;
  const authoritative = await SellerSubscription.findOne({ seller: cleanup.seller })
    .select('stripeSubscriptionId')
    .lean();
  if (
    authoritative?.stripeSubscriptionId
    && authoritative.stripeSubscriptionId === cleanup.staleStripeSubscriptionId
  ) {
    const staleError = new Error(
      'Cleanup target is now the seller\'s authoritative Stripe subscription; automatic cancellation was stopped.',
    );
    staleError.code = 'SUBSCRIPTION_CLEANUP_TARGET_NOW_AUTHORITATIVE';
    return markCleanupUnconfirmed(cleanup, staleError, timestamp, { forceManualReview: true });
  }

  if (!stripeClient?.subscriptions?.cancel) {
    const configError = new Error('Stripe subscription cancellation is not configured.');
    configError.code = 'STRIPE_NOT_CONFIGURED';
    return markCleanupUnconfirmed(cleanup, configError, timestamp);
  }

  try {
    const cancelled = await stripeClient.subscriptions.cancel(
      cleanup.staleStripeSubscriptionId,
      {},
      { idempotencyKey: `subscription-cleanup:${cleanup.cleanupKey}` },
    );
    if (!cancelled || String(cancelled.id || '') !== cleanup.staleStripeSubscriptionId) {
      const mismatch = new Error('Stripe returned a mismatched subscription cancellation response.');
      mismatch.code = 'STRIPE_CANCELLATION_RESPONSE_MISMATCH';
      return markCleanupUnconfirmed(cleanup, mismatch, timestamp, { forceManualReview: true });
    }
    if (
      cleanup.stripeCustomerId
      && cancelled.customer
      && String(cancelled.customer) !== cleanup.stripeCustomerId
    ) {
      const mismatch = new Error('Stripe returned a cancellation response for a different customer.');
      mismatch.code = 'STRIPE_CANCELLATION_CUSTOMER_MISMATCH';
      return markCleanupUnconfirmed(cleanup, mismatch, timestamp, { forceManualReview: true });
    }
    if (cancelled.status !== 'canceled') {
      const unresolved = new Error(
        `Stripe did not return an exact canceled status after cancellation (received ${String(cancelled.status || 'missing').slice(0, 60)}).`,
      );
      unresolved.code = 'STRIPE_CANCELLATION_STATUS_UNCONFIRMED';
      return markCleanupUnconfirmed(cleanup, unresolved, timestamp);
    }
    return markCleanupCompleted(cleanup, cancelled.status, timestamp);
  } catch (error) {
    if (
      Number(error?.statusCode) === 404
      || String(error?.code || '').toLowerCase() === 'resource_missing'
    ) {
      // Absence in the currently configured Stripe account is not proof that
      // this subscription was cancelled in the account that created it. A key
      // rotation or account mismatch could otherwise leave billing active.
      const missing = new Error(
        'Stripe could not find the cleanup target; cancellation is not proven and account ownership requires review.',
      );
      missing.code = 'STRIPE_CANCELLATION_TARGET_NOT_FOUND';
      return markCleanupUnconfirmed(cleanup, missing, timestamp, { forceManualReview: true });
    }
    return markCleanupUnconfirmed(cleanup, error, timestamp);
  }
}

async function processStripeSubscriptionCleanupById(cleanupId, {
  stripeClient = stripe,
  workerId = `subscription-cleanup:${process.pid}`,
  now = new Date(),
} = {}) {
  const timestamp = asDate(now, 'Cleanup processing timestamp');
  const cleanup = await claimCleanup({ cleanupId, workerId, now: timestamp });
  if (!cleanup) {
    const existing = await StripeSubscriptionCleanup.findById(cleanupId);
    if (existing?.manualReview?.requiredAt && !existing.manualReview.notificationEnqueuedAt) {
      await ensureCleanupEscalationNotified(existing._id);
    }
    if (
      existing?.status === 'completed'
      && existing.manualReview?.requiredAt
      && !existing.manualReview.resolutionNotificationEnqueuedAt
    ) {
      await ensureCleanupResolutionNotified(existing._id);
    }
    return existing;
  }
  return processClaimedStripeSubscriptionCleanup(cleanup, { stripeClient, now: timestamp });
}

async function processPendingStripeSubscriptionCleanups({
  stripeClient = stripe,
  workerId = `subscription-cleanup:${process.pid}`,
  limit = DEFAULT_BATCH_LIMIT,
  now = new Date(),
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw outboxError('Cleanup batch limit is invalid.', 'STRIPE_SUBSCRIPTION_CLEANUP_INVALID');
  }
  const timestamp = asDate(now, 'Cleanup sweep timestamp');
  const results = [];
  for (let index = 0; index < limit; index += 1) {
    const claimed = await claimCleanup({ workerId, now: timestamp });
    if (!claimed) break;
    results.push(await processClaimedStripeSubscriptionCleanup(claimed, {
      stripeClient,
      now: timestamp,
    }));
  }

  const unresolvedAlerts = await StripeSubscriptionCleanup.find({
    'manualReview.requiredAt': { $ne: null },
    'manualReview.notificationEnqueuedAt': null,
  }).select('_id').limit(limit).lean();
  for (const item of unresolvedAlerts) await ensureCleanupEscalationNotified(item._id);

  const unresolvedResolutions = await StripeSubscriptionCleanup.find({
    status: 'completed',
    'manualReview.requiredAt': { $ne: null },
    'manualReview.resolutionNotificationEnqueuedAt': null,
  }).select('_id').limit(limit).lean();
  for (const item of unresolvedResolutions) await ensureCleanupResolutionNotified(item._id);

  return results;
}

module.exports = {
  CLEANUP_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  cleanupKeyFor,
  ensureCleanupEscalationNotified,
  ensureCleanupResolutionNotified,
  ensureStripeSubscriptionCleanup,
  processPendingStripeSubscriptionCleanups,
  processStripeSubscriptionCleanupById,
};
