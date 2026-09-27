'use strict';

const Outbox = require('../models/NotificationOutbox');
const { verifySafepayNotificationAuthority } = require('./safepayNotificationAuthority');

// Repair only rows rejected by the former Stripe-only authority validator.
// Delivered, expired, role-restricted and newly rejected rows are not eligible.
const OLD_PROVIDER_REJECTIONS = [
  'The entitlement payment receipt has an invalid durable payment owner.',
  'The Stripe payment-risk receipt has an invalid immutable aggregate owner.',
  'The subscription alert has an invalid aggregate owner.',
];
async function recoverSkippedSafepayNotifications({ limit = 1000 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new RangeError('Invalid recovery limit.');
  const rows = await Outbox.find({ status: 'skipped', deliveredAt: null,
    lastErrorCode: 'NOTIFICATION_NO_LONGER_ACTIONABLE', lastError: { $in: OLD_PROVIDER_REJECTIONS },
    aggregateType: { $in: ['SafepayBillingOperation', 'SafepaySubdomainGrant', 'SafepayRefundEvent'] },
  }).sort({ createdAt: 1, _id: 1 }).limit(limit).select('+contentHash +recipient.email +recipient.phone').lean();
  let recovered = 0;
  for (const row of rows) {
    if (await verifySafepayNotificationAuthority(row)) continue;
    const updated = await Outbox.updateOne({ _id: row._id, status: 'skipped', deliveredAt: null,
      contentHash: row.contentHash, lastError: row.lastError }, { $set: { status: 'pending', attempts: 0,
      skippedAt: null, nextAttemptAt: new Date(), lastErrorCode: '', lastError: '',
      leaseToken: null, leaseOwner: '', leaseExpiresAt: null } });
    recovered += updated.modifiedCount;
  }
  return { inspected: rows.length, recovered };
}
module.exports = { recoverSkippedSafepayNotifications };
