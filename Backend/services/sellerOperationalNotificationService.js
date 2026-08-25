'use strict';

const crypto = require('crypto');
const Product = require('../models/Product');
const User = require('../models/User');
const { escapeHtml } = require('../utils/orderPresentation');
const { SUPPORTED_PAYOUT_CURRENCIES } = require('./payoutAccountValidationService');
const {
  enqueueNotificationEvent,
  outboxError,
} = require('./notificationOutboxService');

const DEFAULT_CHANNELS = Object.freeze(['inapp', 'push', 'email', 'whatsapp']);

const stringId = value => value?._id?.toString?.() || value?.toString?.() || '';

const requiredText = (value, label, maxLength) => {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text || text.length > maxLength) {
    throw outboxError(`${label} is invalid.`);
  }
  return text;
};

const optionalText = (value, maxLength) => {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  return text.slice(0, maxLength);
};

const requiredDate = (value, label) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!value || !Number.isFinite(date.getTime())) {
    throw outboxError(`${label} is invalid.`);
  }
  return date;
};

const eventDigest = (...parts) => crypto.createHash('sha256')
  .update(parts.map(part => String(part || '')).join('\u0000'))
  .digest('hex');

const sellerRecipient = sellerId => ({
  kind: 'user',
  audienceRole: 'seller',
  user: stringId(sellerId),
  destinationPolicy: 'current_user',
});

const sellerMetadata = ({
  linkTo,
  type,
  aggregateId,
  whatsappCategory,
  category = 'seller',
  data = {},
}) => ({
  category,
  linkTo,
  channelId: 'seller',
  whatsappCategory,
  data: {
    ...data,
    type,
    audienceRole: 'seller',
    aggregateId: stringId(aggregateId),
  },
});

const requiredPayoutCurrency = value => {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw outboxError('Payout currency is invalid.');
  }
  const currency = value.toUpperCase();
  if (!SUPPORTED_PAYOUT_CURRENCIES.has(currency)) {
    throw outboxError('Payout currency is invalid.');
  }
  return currency;
};

const optionalDestinationLast4 = value => {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'string' || value !== value.trim()) {
    throw outboxError('Payout destination last four characters are invalid.');
  }
  const last4 = value.toUpperCase();
  if (!/^[A-Z0-9]{4}$/u.test(last4)) {
    throw outboxError('Payout destination last four characters are invalid.');
  }
  return last4;
};

const enqueueSellerWelcomeNotification = async (user, {
  channels = DEFAULT_CHANNELS,
  session = null,
} = {}) => {
  const userId = stringId(user?._id);
  const notice = user?.sellerWelcomeNotice;
  const occurredAt = requiredDate(notice?.occurredAt, 'Seller welcome timestamp');
  const storeName = optionalText(notice?.storeName, 120);
  const storeSentence = storeName
    ? `Your seller account and ${storeName} are ready.`
    : 'Your seller account is ready.';
  const htmlStoreSentence = storeName
    ? `Your seller account and <strong>${escapeHtml(storeName)}</strong> are ready.`
    : 'Your seller account is ready.';

  return enqueueNotificationEvent({
    eventKey: `user:${userId}:seller-welcome:${eventDigest(occurredAt.toISOString())}:seller:v1`,
    eventType: 'seller.account_created',
    aggregateType: 'User',
    aggregateId: userId,
    occurredAt,
    financial: false,
    recipient: sellerRecipient(userId),
    channels,
    templates: {
      inapp: {
        title: 'Welcome to selling on Rozare',
        body: `${storeSentence} Open your seller dashboard to finish setup and manage products, orders, and store settings.`,
      },
      push: {
        title: 'Your seller account is ready',
        body: `${storeSentence} Open your dashboard to get started.`,
      },
      email: {
        subject: 'Your Rozare seller account is ready',
        text: `${storeSentence} Open your seller dashboard to finish setup and manage your store.`,
        html: `<p>${htmlStoreSentence}</p><p>Open your seller dashboard to finish setup and manage your store.</p>`,
      },
      whatsapp: {
        message: `Welcome to Rozare Seller\n\n${storeSentence}\n\nOpen your seller dashboard to finish setup and manage your store.`,
      },
    },
    metadata: sellerMetadata({
      linkTo: '/seller-dashboard/store-overview',
      type: 'seller_account_created',
      aggregateId: userId,
      whatsappCategory: 'seller_welcome',
    }),
    session,
  });
};

const ensureSellerWelcomeNotification = async (userOrId, {
  channels = DEFAULT_CHANNELS,
  session = null,
} = {}) => {
  const user = typeof userOrId === 'object' && userOrId?.sellerWelcomeNotice
    ? userOrId
    : await User.findById(stringId(userOrId))
      .select('role sellerWelcomeNotice')
      .session(session);
  if (!user || user.role !== 'seller' || !user.sellerWelcomeNotice?.occurredAt) return [];
  if (user.sellerWelcomeNotice.notificationEnqueuedAt) return [];

  const records = await enqueueSellerWelcomeNotification(user, { channels, session });
  const occurredAt = requiredDate(user.sellerWelcomeNotice.occurredAt, 'Seller welcome timestamp');
  await User.updateOne({
    _id: user._id,
    role: 'seller',
    'sellerWelcomeNotice.occurredAt': occurredAt,
    'sellerWelcomeNotice.notificationEnqueuedAt': null,
  }, {
    $set: { 'sellerWelcomeNotice.notificationEnqueuedAt': new Date() },
  }, session ? { session } : undefined);
  return records;
};

const enqueueStoreCreatedNotification = async (store, {
  channels = DEFAULT_CHANNELS,
  session = null,
} = {}) => {
  const storeId = stringId(store?._id);
  const sellerId = stringId(store?.seller);
  const storeName = requiredText(store?.storeName, 'Store name', 120);
  const storeSlug = requiredText(store?.storeSlug, 'Store slug', 120);
  const occurredAt = requiredDate(store?.createdAt, 'Store creation timestamp');
  const publicPath = `/store/${encodeURIComponent(storeSlug)}`;

  return enqueueNotificationEvent({
    eventKey: `store:${storeId}:created:seller:v1`,
    eventType: 'store.created',
    aggregateType: 'Store',
    aggregateId: storeId,
    occurredAt,
    financial: false,
    recipient: sellerRecipient(sellerId),
    channels,
    templates: {
      inapp: {
        title: 'Your store was created',
        body: `${storeName} was created successfully. Add products and review its settings before sharing it. Visibility follows your current account and subscription status.`,
      },
      push: {
        title: 'Your store was created',
        body: `${storeName} is ready for setup. Open Store Settings to continue.`,
      },
      email: {
        subject: `Your store ${storeName} was created`,
        text: `${storeName} was created successfully. Store path: ${publicPath}. Open Seller Dashboard > Store Settings to finish setup. Store visibility follows your current account and subscription status.`,
        html: `<p><strong>${escapeHtml(storeName)}</strong> was created successfully.</p><p>Store path: <strong>${escapeHtml(publicPath)}</strong></p><p>Open <strong>Seller Dashboard &gt; Store Settings</strong> to finish setup. Store visibility follows your current account and subscription status.</p>`,
      },
      whatsapp: {
        message: `Store Created\n\n${storeName} was created. Store path: ${publicPath}.\n\nOpen Seller Dashboard > Store Settings to finish setup. Visibility follows your current account and subscription status.`,
      },
    },
    metadata: sellerMetadata({
      linkTo: '/seller-dashboard/store-settings',
      type: 'store_created',
      aggregateId: storeId,
      whatsappCategory: 'store_created',
    }),
    session,
  });
};

const VERIFICATION_EVENT = Object.freeze({
  approved: {
    eventType: 'store.verification_approved',
    title: 'Store verification approved',
    state: 'approved',
    guidance: 'Your store now displays the verified badge.',
    whatsappCategory: 'store_verification_approved',
    type: 'store_verified',
  },
  rejected: {
    eventType: 'store.verification_rejected',
    title: 'Store verification rejected',
    state: 'rejected',
    guidance: 'Update your store information before applying again.',
    whatsappCategory: 'store_verification_rejected',
    type: 'store_verification_rejected',
  },
  removed: {
    eventType: 'store.verification_removed',
    title: 'Store verification removed',
    state: 'removed',
    guidance: 'The verified badge is no longer shown. Open Store Settings for next steps.',
    whatsappCategory: 'store_verification_removed',
    type: 'store_verification_removed',
  },
});

const enqueueStoreVerificationNotification = async (store, decision, {
  channels = DEFAULT_CHANNELS,
  session = null,
} = {}) => {
  const config = VERIFICATION_EVENT[decision];
  if (!config) throw outboxError('Store verification notification decision is invalid.');
  const storeId = stringId(store?._id);
  const sellerId = stringId(store?.seller);
  const storeName = requiredText(store?.storeName, 'Store name', 120);
  const occurredAt = requiredDate(store?.verification?.reviewedAt, 'Store verification review timestamp');
  const reason = decision === 'approved'
    ? ''
    : optionalText(store?.verification?.rejectionReason, 500) || 'No additional reason was provided.';
  const reasonSentence = reason ? ` Reason: ${reason}` : '';

  return enqueueNotificationEvent({
    eventKey: `store:${storeId}:verification:${decision}:${eventDigest(occurredAt.toISOString(), reason)}:seller:v1`,
    eventType: config.eventType,
    aggregateType: 'Store',
    aggregateId: storeId,
    occurredAt,
    financial: false,
    recipient: sellerRecipient(sellerId),
    channels,
    templates: {
      inapp: {
        title: config.title,
        body: `${storeName} verification was ${config.state}.${reasonSentence} ${config.guidance}`,
      },
      push: {
        title: config.title,
        body: `${storeName} verification was ${config.state}.${reasonSentence}`,
      },
      email: {
        subject: `${config.title} - ${storeName}`,
        text: `${storeName} verification was ${config.state}.${reasonSentence} ${config.guidance}`,
        html: `<p><strong>${escapeHtml(storeName)}</strong> verification was <strong>${escapeHtml(config.state)}</strong>.</p>${reason ? `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : ''}<p>${escapeHtml(config.guidance)}</p>`,
      },
      whatsapp: {
        message: `${config.title}\n\n${storeName} verification was ${config.state}.${reasonSentence}\n\n${config.guidance}`,
      },
    },
    metadata: sellerMetadata({
      linkTo: '/seller-dashboard/store-settings',
      type: config.type,
      aggregateId: storeId,
      whatsappCategory: config.whatsappCategory,
    }),
    session,
  });
};

const enqueueNewStoreReviewNotification = async ({ review, store, buyerName }, {
  channels = DEFAULT_CHANNELS,
  session = null,
} = {}) => {
  const reviewId = stringId(review?._id);
  const storeId = stringId(store?._id || review?.store);
  const sellerId = stringId(store?.seller);
  const storeName = requiredText(store?.storeName, 'Store name', 120);
  const storeSlug = requiredText(store?.storeSlug, 'Store slug', 120);
  const reviewer = optionalText(buyerName, 100) || 'A verified buyer';
  const rating = review?.rating;
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw outboxError('Store review rating is invalid.');
  }
  const occurredAt = requiredDate(review?.createdAt, 'Store review creation timestamp');
  const sentence = `${reviewer} rated ${storeName} ${rating} out of 5.`;

  return enqueueNotificationEvent({
    eventKey: `store-review:${reviewId}:created:seller:v1`,
    eventType: 'store.review_created',
    aggregateType: 'StoreReview',
    aggregateId: reviewId,
    occurredAt,
    financial: false,
    recipient: sellerRecipient(sellerId),
    channels,
    templates: {
      inapp: { title: 'New store rating', body: sentence },
      push: { title: 'New store rating', body: sentence },
      email: {
        subject: `New verified-buyer rating for ${storeName}`,
        text: `${sentence} Open Seller Dashboard > Store Overview to review it.`,
        html: `<p>${escapeHtml(reviewer)} rated <strong>${escapeHtml(storeName)}</strong> <strong>${rating} out of 5</strong>.</p><p>Open <strong>Seller Dashboard &gt; Store Overview</strong> to review it.</p>`,
      },
      whatsapp: {
        message: `New Store Rating\n\n${sentence}\n\nOpen Seller Dashboard > Store Overview to review it.`,
      },
    },
    metadata: sellerMetadata({
      linkTo: `/store/${encodeURIComponent(storeSlug)}#store-reviews`,
      type: 'new_review',
      aggregateId: reviewId,
      whatsappCategory: 'store_review',
      data: { rating },
    }),
    session,
  });
};

const enqueuePayoutAccountUpdatedNotification = async ({ account, occurredAt, changeFingerprint }, {
  channels = DEFAULT_CHANNELS,
  session = null,
} = {}) => {
  const accountId = stringId(account?._id);
  const sellerId = stringId(account?.seller);
  const at = requiredDate(occurredAt, 'Payout account update timestamp');
  const fingerprint = requiredText(changeFingerprint, 'Payout account change fingerprint', 64);
  const bankName = requiredText(account?.bankName, 'Payout bank name', 120);
  const currency = requiredPayoutCurrency(account?.currency);
  const destinationLast4 = optionalDestinationLast4(
    account?.ibanLast4 || account?.accountNumberLast4
  );
  const destination = destinationLast4 ? ` ending in ${destinationLast4}` : '';
  const sentence = `Your ${bankName} payout destination${destination} was saved for ${currency} payouts.`;

  return enqueueNotificationEvent({
    eventKey: `seller-payment-account:${accountId}:updated:${fingerprint}:seller:v1`,
    eventType: 'payout.account_updated',
    aggregateType: 'SellerPaymentAccount',
    aggregateId: accountId,
    occurredAt: at,
    financial: false,
    recipient: sellerRecipient(sellerId),
    channels,
    templates: {
      inapp: { title: 'Payout account updated', body: sentence },
      push: { title: 'Payout account updated', body: sentence },
      email: {
        subject: 'Your Rozare payout account was updated',
        text: `${sentence} If you did not make this change, contact Rozare support immediately.`,
        html: `<p>${escapeHtml(sentence)}</p><p><strong>If you did not make this change, contact Rozare support immediately.</strong></p>`,
      },
      whatsapp: {
        message: `Payout Account Updated\n\n${sentence}\n\nIf you did not make this change, contact Rozare support immediately.`,
      },
    },
    metadata: sellerMetadata({
      linkTo: '/seller-dashboard/payments',
      type: 'payout_account_updated',
      aggregateId: accountId,
      whatsappCategory: 'payout_account_updated',
      category: 'payment',
    }),
    session,
  });
};

const stageProductBlockedNotice = async productOrId => {
  const productId = stringId(productOrId?._id || productOrId);
  const current = await Product.findById(productId)
    .select('seller name isBlocked blockedAt blockedReason moderationStatus moderationReason moderationReviewedAt moderationNotice');
  if (!current || (current.isBlocked !== true && current.moderationStatus !== 'blocked')) return null;
  const reviewedAt = requiredDate(
    current.moderationReviewedAt || current.blockedAt,
    'Product moderation timestamp'
  );
  const existingAt = current.moderationNotice?.reviewedAt;
  if (existingAt && new Date(existingAt).getTime() === reviewedAt.getTime()) return current;

  const productName = optionalText(current.name, 200) || 'Your product';
  const reason = optionalText(
    current.blockedReason || current.moderationReason,
    600
  ) || 'it looks like test or placeholder content';
  const staged = await Product.findOneAndUpdate({
    _id: current._id,
    $or: [
      { isBlocked: true },
      { moderationStatus: 'blocked' },
    ],
    moderationReviewedAt: current.moderationReviewedAt,
  }, {
    $set: {
      moderationNotice: {
        reviewedAt,
        productName,
        reason,
        notificationEnqueuedAt: null,
      },
    },
  }, { new: true, runValidators: true });
  return staged || Product.findById(current._id)
    .select('seller name isBlocked blockedAt blockedReason moderationStatus moderationReason moderationReviewedAt moderationNotice');
};

const enqueueProductBlockedNotification = async (product, {
  channels = DEFAULT_CHANNELS,
  session = null,
} = {}) => {
  const productId = stringId(product?._id);
  const sellerId = stringId(product?.seller);
  const notice = product?.moderationNotice;
  const occurredAt = requiredDate(notice?.reviewedAt, 'Product moderation notice timestamp');
  const productName = requiredText(notice?.productName, 'Blocked product name', 200);
  const reason = requiredText(notice?.reason, 'Product moderation reason', 600);
  const sentence = `${productName} was blocked because ${reason}. Customers cannot see it until the listing is corrected.`;

  return enqueueNotificationEvent({
    eventKey: `product:${productId}:blocked:${eventDigest(occurredAt.toISOString(), reason)}:seller:v1`,
    eventType: 'product.blocked',
    aggregateType: 'Product',
    aggregateId: productId,
    occurredAt,
    financial: false,
    recipient: sellerRecipient(sellerId),
    channels,
    templates: {
      inapp: { title: 'Product blocked', body: sentence },
      push: { title: 'Product blocked', body: sentence },
      email: {
        subject: `Product blocked - ${productName}`,
        text: `${sentence} Open Seller Dashboard > Product Management to edit it.`,
        html: `<p><strong>${escapeHtml(productName)}</strong> was blocked because ${escapeHtml(reason)}.</p><p>Customers cannot see it until the listing is corrected. Open <strong>Seller Dashboard &gt; Product Management</strong> to edit it.</p>`,
      },
      whatsapp: {
        message: `Product Blocked\n\n${productName} was blocked because ${reason}.\n\nCustomers cannot see it until you correct the listing in Product Management.`,
      },
    },
    metadata: sellerMetadata({
      linkTo: '/seller-dashboard/product-management',
      type: 'product_blocked',
      aggregateId: productId,
      whatsappCategory: 'product_blocked',
    }),
    session,
  });
};

const ensureProductBlockedNotification = async (productOrId, {
  channels = DEFAULT_CHANNELS,
  stageIfMissing = false,
  session = null,
} = {}) => {
  let product = typeof productOrId === 'object' && productOrId?.moderationNotice
    ? productOrId
    : await Product.findById(stringId(productOrId?._id || productOrId))
      .select('seller name isBlocked blockedAt blockedReason moderationStatus moderationReason moderationReviewedAt moderationNotice')
      .session(session);
  if (!product || (product.isBlocked !== true && product.moderationStatus !== 'blocked')) return [];
  if (!product.moderationNotice?.reviewedAt && stageIfMissing) {
    product = await stageProductBlockedNotice(product);
  }
  if (!product?.moderationNotice?.reviewedAt || product.moderationNotice.notificationEnqueuedAt) return [];

  const records = await enqueueProductBlockedNotification(product, { channels, session });
  const reviewedAt = requiredDate(product.moderationNotice.reviewedAt, 'Product moderation notice timestamp');
  await Product.updateOne({
    _id: product._id,
    $or: [
      { isBlocked: true },
      { moderationStatus: 'blocked' },
    ],
    'moderationNotice.reviewedAt': reviewedAt,
    'moderationNotice.notificationEnqueuedAt': null,
  }, {
    $set: { 'moderationNotice.notificationEnqueuedAt': new Date() },
  }, session ? { session } : undefined);
  return records;
};

const recoverPendingSellerOperationalNotifications = async ({ limit = 25 } = {}) => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('Seller operational notification recovery limit must be between 1 and 100.');
  }
  const [users, products] = await Promise.all([
    User.find({
      role: 'seller',
      'sellerWelcomeNotice.occurredAt': { $ne: null },
      'sellerWelcomeNotice.notificationEnqueuedAt': null,
    }).select('role sellerWelcomeNotice').sort({ 'sellerWelcomeNotice.occurredAt': 1 }).limit(limit),
    Product.find({
      $or: [
        { isBlocked: true },
        { moderationStatus: 'blocked' },
      ],
      'moderationNotice.reviewedAt': { $ne: null },
      'moderationNotice.notificationEnqueuedAt': null,
    }).select('seller name isBlocked blockedAt blockedReason moderationStatus moderationReason moderationReviewedAt moderationNotice')
      .sort({ 'moderationNotice.reviewedAt': 1 })
      .limit(limit),
  ]);

  // Read a bounded head from each independently indexed queue, then enforce
  // the caller's limit across both event kinds. This avoids starving product
  // notices behind a constant welcome stream (or vice versa), while never
  // processing more than the configured batch size — including limit=1.
  const candidates = [
    ...users.map(user => ({
      kind: 'seller_welcome',
      document: user,
      occurredAt: new Date(user.sellerWelcomeNotice.occurredAt).getTime(),
    })),
    ...products.map(product => ({
      kind: 'product_blocked',
      document: product,
      occurredAt: new Date(product.moderationNotice.reviewedAt).getTime(),
    })),
  ]
    .sort((left, right) => left.occurredAt - right.occurredAt)
    .slice(0, limit);

  const results = [];
  for (const candidate of candidates) {
    const { kind, document } = candidate;
    try {
      if (kind === 'seller_welcome') {
        await ensureSellerWelcomeNotification(document);
      } else {
        await ensureProductBlockedNotification(document);
      }
      results.push({ kind, id: stringId(document._id), recovered: true });
    } catch (error) {
      results.push({ kind, id: stringId(document._id), recovered: false, error });
    }
  }
  return results;
};

module.exports = {
  DEFAULT_CHANNELS,
  enqueueNewStoreReviewNotification,
  enqueuePayoutAccountUpdatedNotification,
  enqueueProductBlockedNotification,
  enqueueSellerWelcomeNotification,
  enqueueStoreCreatedNotification,
  enqueueStoreVerificationNotification,
  ensureProductBlockedNotification,
  ensureSellerWelcomeNotification,
  recoverPendingSellerOperationalNotifications,
  stageProductBlockedNotice,
};
