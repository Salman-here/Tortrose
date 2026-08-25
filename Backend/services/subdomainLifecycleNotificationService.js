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
      body: `Paid ownership of ${hostname} ended on ${dateLabel}. Renew from Seller Dashboard to protect it again.`,
    },
    push: {
      title: 'Subdomain ownership expired',
      body: `${hostname} is no longer protected. Open Seller Dashboard to renew.`,
    },
    email: {
      subject: 'Subdomain ownership expired - renewal available',
      text: `Paid ownership of ${hostname} ended on ${dateLabel}. Renew from Seller Dashboard > Subdomain to protect it again. The current price and currency are shown before checkout.`,
      html: `<p>Paid ownership of <strong>${escapeHtml(hostname)}</strong> ended on <strong>${escapeHtml(dateLabel)}</strong>.</p><p>Renew from <strong>Seller Dashboard &gt; Subdomain</strong> to protect it again. The current price and currency are shown before checkout.</p>`,
    },
    whatsapp: {
      message: `Subdomain Ownership Expired\n\n${hostname}\nOwnership ended: ${dateLabel}\n\nOpen Seller Dashboard > Subdomain to renew. The current price and currency are shown before checkout.`,
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
      body: `${hostname} was released after your inactive-store grace period ended. Reactivate your store before choosing a new subdomain.`,
    },
    push: {
      title: 'Subdomain removed',
      body: `${hostname} was released after the inactive-store grace period ended.`,
    },
    email: {
      subject: 'Your Rozare subdomain was removed',
      text: `${hostname} was released after your inactive-store grace period ended. Reactivate your store, then open Seller Dashboard > Subdomain to choose an available replacement.`,
      html: `<p><strong>${escapeHtml(hostname)}</strong> was released after your inactive-store grace period ended.</p><p>Reactivate your store, then open <strong>Seller Dashboard &gt; Subdomain</strong> to choose an available replacement.</p>`,
    },
    whatsapp: {
      message: `Subdomain Removed\n\n${hostname} was released after your inactive-store grace period ended.\n\nReactivate your store, then open Seller Dashboard > Subdomain to choose an available replacement.`,
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
