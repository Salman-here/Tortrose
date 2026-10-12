'use strict';

const crypto = require('crypto');
const { escapeHtml } = require('../utils/orderPresentation');
const {
  enqueueNotificationEvent,
  outboxError,
} = require('./notificationOutboxService');

const stringId = value => value?._id?.toString?.() || value?.toString?.() || '';

const requireNoticeSlug = value => {
  const slug = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 120) {
    throw outboxError('Subdomain lifecycle notifications require a valid frozen slug.');
  }
  return slug;
};

const requireNoticeDate = (value, field) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!value || !Number.isFinite(date.getTime())) {
    throw outboxError(`Subdomain lifecycle notifications require a valid ${field}.`);
  }
  return date;
};

const eventDigest = (...parts) => crypto.createHash('sha256')
  .update(parts.join(':'))
  .digest('hex');

const sellerRecipient = seller => ({
  kind: 'user',
  audienceRole: 'seller',
  user: seller,
  destinationPolicy: 'current_user',
  // Ownership expiry/removal can coincide with an account block. This is an
  // operational account notice and must remain deliverable in that state.
  allowBlocked: true,
});

async function enqueueSubdomainOwnershipExpiredNotification(store, {
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
} = {}) {
  const storeId = stringId(store?._id);
  const sellerId = stringId(store?.seller);
  const notice = store?.subdomainPurchase?.expiryNotice;
  const slug = requireNoticeSlug(notice?.slug);
  const expiresAt = requireNoticeDate(notice?.expiresAt, 'ownership expiry timestamp');
  const dateLabel = expiresAt.toISOString().slice(0, 10);
  const hostname = `${slug}.rozare.com`;
  const templates = {
    inapp: {
      title: 'Subdomain ownership expired',
      body: `Your paid ownership of ${hostname} ended on ${dateLabel}. Renew in Subdomain settings to reserve the address again.`,
    },
    push: {
      title: 'Subdomain ownership expired',
      body: `Paid ownership of ${hostname} has expired. Review renewal options in Subdomain settings.`,
    },
    email: {
      subject: 'Your subdomain ownership has expired',
      text: `Your paid ownership of ${hostname} ended on ${dateLabel}.\n\nRenew in Subdomain settings to reserve the address again. Review the current price before you pay.`,
      html: `<p>Your paid ownership of <strong>${escapeHtml(hostname)}</strong> ended on <strong>${escapeHtml(dateLabel)}</strong>.</p><p>Renew in <strong>Subdomain settings</strong> to reserve the address again. Review the current price before you pay.</p>`,
    },
    whatsapp: {
      message: `*Your subdomain ownership has expired*\n\nStore address: ${hostname}\nOwnership ended: ${dateLabel}\n\nRenew in Subdomain settings to reserve the address again. Review the current price before you pay.`,
    },
  };
  return enqueueNotificationEvent({
    eventKey: `store:${storeId}:subdomain-expired:${eventDigest(slug, expiresAt.toISOString())}:seller:v1`,
    eventType: 'subdomain.ownership_expired',
    aggregateType: 'Store',
    aggregateId: storeId,
    occurredAt: expiresAt,
    financial: false,
    recipient: sellerRecipient(sellerId),
    channels,
    templates,
    metadata: {
      category: 'system',
      linkTo: '/seller-dashboard/subdomain',
      channelId: 'seller',
      whatsappCategory: 'subscription_ending',
      data: { type: 'subdomain_ownership_expired', storeId },
    },
    session,
  });
}

async function enqueueSubdomainRemovedNotification(store, {
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
} = {}) {
  const storeId = stringId(store?._id);
  const sellerId = stringId(store?.seller);
  const notice = store?.subdomainPurchase?.removalNotice;
  const slug = requireNoticeSlug(notice?.previousSlug);
  const removedAt = requireNoticeDate(notice?.removedAt, 'subdomain removal timestamp');
  const hostname = `${slug}.rozare.com`;
  const templates = {
    inapp: {
      title: 'Subdomain removed',
      body: `${hostname} was released because your store remained inactive after the grace period. Reactivate your store, then choose an available address in Subdomain settings.`,
    },
    push: {
      title: 'Subdomain removed',
      body: `${hostname} was released after the grace period. Reactivate your store to choose another available address.`,
    },
    email: {
      subject: 'Your store address has been released',
      text: `${hostname} was released because your store remained inactive after the grace period.\n\nReactivate your store, then choose an available address in Subdomain settings.`,
      html: `<p><strong>${escapeHtml(hostname)}</strong> was released because your store remained inactive after the grace period.</p><p>Reactivate your store, then choose an available address in <strong>Subdomain settings</strong>.</p>`,
    },
    whatsapp: {
      message: `*Your store address has been released*\n\n${hostname} was released because your store remained inactive after the grace period.\n\nReactivate your store, then choose an available address in Subdomain settings.`,
    },
  };
  return enqueueNotificationEvent({
    eventKey: `store:${storeId}:subdomain-removed:${eventDigest(slug, removedAt.toISOString())}:seller:v1`,
    eventType: 'subdomain.removed',
    aggregateType: 'Store',
    aggregateId: storeId,
    occurredAt: removedAt,
    financial: false,
    recipient: sellerRecipient(sellerId),
    channels,
    templates,
    metadata: {
      category: 'system',
      linkTo: '/seller-dashboard/subdomain',
      channelId: 'seller',
      whatsappCategory: 'account_blocked',
      data: { type: 'subdomain_removed', storeId },
    },
    session,
  });
}

module.exports = {
  enqueueSubdomainOwnershipExpiredNotification,
  enqueueSubdomainRemovedNotification,
};
