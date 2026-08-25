'use strict';

const Notification = require('../models/Notification');
const Order = require('../models/Order');
const Product = require('../models/Product');
const SellerSubscription = require('../models/SellerSubscription');
const Store = require('../models/Store');
const StoreReview = require('../models/StoreReview');
const StripeEntitlementPayment = require('../models/StripeEntitlementPayment');
const StripePaymentRiskEvent = require('../models/StripePaymentRiskEvent');
const StripePaymentRiskReview = require('../models/StripePaymentRiskReview');
const StripeSubscriptionCleanup = require('../models/StripeSubscriptionCleanup');
const User = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');
const { sendEmail } = require('../controllers/mailController');
const { sendExpoPushStrict } = require('../utils/expoPush');
const {
  enqueueOrderConfirmation,
  enqueueGenericTextNotification,
  enqueueTextNotification,
  findOrderConfirmationJob,
} = require('./whatsapp/queue');
const { notifySeller } = require('./whatsapp/sellerNotificationService');
const { blockedRecipientEventAllowed } = require('./notificationOutboxService');
const { orderBuyerPhoneDigits } = require('./orderBuyerContactService');
const {
  formatMoneySnapshot,
  orderTotalSnapshot,
} = require('./notificationMoneySnapshotService');

const deliveryError = (message, code = 'NOTIFICATION_DELIVERY_FAILED', { retryable = true } = {}) => {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
};

const delivered = providerMessageId => ({
  outcome: 'delivered',
  providerMessageId: String(providerMessageId || ''),
});

const skipped = (code, reason) => ({ outcome: 'skipped', code, reason });

const deferred = (code, reason) => ({ outcome: 'deferred', code, reason });

const completedBuyerWhatsAppStatuses = new Set(['sent', 'voted_yes', 'voted_no']);

const buyerWhatsAppJobOutcome = (job, { confirmation = false } = {}) => {
  if (!job) {
    throw deliveryError('Buyer WhatsApp could not be queued.', 'BUYER_WHATSAPP_QUEUE_FAILED');
  }
  const status = String(job.status || '');
  if (completedBuyerWhatsAppStatuses.has(status)) {
    return delivered(job.summaryMessageId || job._id);
  }
  if (status === 'queued' || status === 'sending') {
    // A durable queue hand-off is not provider delivery. Keep the parent
    // outbox retryable until the child job records Evolution's result.
    return deferred(
      'BUYER_WHATSAPP_JOB_PENDING',
      `The durable buyer WhatsApp job is still ${status}.`,
    );
  }
  if (status === 'failed_invalid_number') {
    return skipped('WHATSAPP_DESTINATION_INVALID', 'The buyer WhatsApp destination is invalid.');
  }
  if (status === 'expired' && confirmation) {
    return skipped(
      'COD_CONFIRMATION_NO_LONGER_ACTIONABLE',
      'The cash on delivery confirmation request expired before delivery.'
    );
  }
  if (status === 'expired') {
    return skipped('BUYER_WHATSAPP_JOB_EXPIRED', 'The buyer WhatsApp message expired before delivery.');
  }
  if (status === 'failed') {
    throw deliveryError(
      'The durable buyer WhatsApp job exhausted its delivery attempts.',
      'BUYER_WHATSAPP_JOB_FAILED',
      { retryable: false }
    );
  }
  throw deliveryError(
    `The durable buyer WhatsApp job has an invalid status: ${status || 'missing'}.`,
    'BUYER_WHATSAPP_JOB_STATUS_INVALID',
    { retryable: false }
  );
};

const currentUserWhatsAppJobOutcome = job => {
  if (!job) throw deliveryError('Current-user WhatsApp could not be queued.', 'CURRENT_USER_WHATSAPP_QUEUE_FAILED');
  const status = String(job.status || '');
  if (completedBuyerWhatsAppStatuses.has(status)) return delivered(job.summaryMessageId || job._id);
  if (status === 'queued' || status === 'sending') {
    return deferred(
      'CURRENT_USER_WHATSAPP_JOB_PENDING',
      `The durable current-user WhatsApp job is still ${status}.`,
    );
  }
  if (status === 'failed_invalid_number') {
    return skipped('WHATSAPP_DESTINATION_INVALID', 'The current-user WhatsApp destination is invalid.');
  }
  if (status === 'expired') {
    return skipped('CURRENT_USER_WHATSAPP_JOB_EXPIRED', 'The current-user WhatsApp message expired before delivery.');
  }
  if (status === 'failed') {
    throw deliveryError(
      'The durable current-user WhatsApp job exhausted its delivery attempts.',
      'CURRENT_USER_WHATSAPP_JOB_FAILED',
      { retryable: false },
    );
  }
  throw deliveryError(
    `The durable current-user WhatsApp job has an invalid status: ${status || 'missing'}.`,
    'CURRENT_USER_WHATSAPP_JOB_STATUS_INVALID',
    { retryable: false },
  );
};

const allowedCurrentRoles = Object.freeze({
  buyer: new Set(['user', 'seller']),
  seller: new Set(['seller']),
  admin: new Set(['admin']),
});

const targetRoleForAudience = Object.freeze({
  buyer: 'both',
  seller: 'seller',
  admin: 'admin',
});

const normalizePhone = value => String(value || '').replace(/\D/g, '');

const SUBSCRIPTION_NOTIFICATION_EVENTS = new Set([
  'subscription.payment_failed',
  'subscription.plan_change_action_required',
  'subscription.plan_change_completed',
  'subscription.trial_expiring',
  'subscription.trial_blocked',
  'subscription.ending_soon',
  'subscription.bonus_expiring',
  'subscription.bonus_expired',
  'subscription.bonus_removed',
  'subscription.activated',
  'subscription.downgrade_scheduled',
  'subscription.cancelled',
]);

const SUBSCRIPTION_CLEANUP_NOTIFICATION_EVENTS = new Set([
  'subscription.cleanup_required',
  'subscription.cleanup_resolved',
]);

const ENTITLEMENT_PAYMENT_RECEIPT_DEFINITIONS = Object.freeze({
  'subscription.payment_received': Object.freeze({
    entitlementType: 'subscription', kind: 'received', moneyKey: 'invoice_paid',
  }),
  'subscription.payment_recovered': Object.freeze({
    entitlementType: 'subscription', kind: 'recovered', moneyKey: 'invoice_paid',
  }),
  'subdomain.payment_received': Object.freeze({
    entitlementType: 'subdomain', kind: 'received', moneyKey: 'subdomain_paid',
  }),
});

const SUBSCRIPTION_EVENT_MONEY = Object.freeze({
  'subscription.payment_failed': Object.freeze([
    Object.freeze({ key: 'amount_outstanding', path: 'paymentRisk.failureNotification.amountDueMinor' }),
  ]),
  'subscription.plan_change_action_required': Object.freeze([
    Object.freeze({ key: 'target_monthly_price', path: 'planChangeAttempt.targetUnitAmountMinor' }),
  ]),
  'subscription.plan_change_completed': Object.freeze([
    Object.freeze({ key: 'target_monthly_price', path: 'planChangeAttempt.targetUnitAmountMinor' }),
  ]),
  'subscription.trial_expiring': Object.freeze([
    Object.freeze({ key: 'starter_standard', path: 'lifecyclePricing.trialExpiring.starterStandardAmountMinor' }),
    Object.freeze({ key: 'starter_founder', path: 'lifecyclePricing.trialExpiring.starterFounderAmountMinor' }),
  ]),
  'subscription.trial_blocked': Object.freeze([]),
  'subscription.ending_soon': Object.freeze([]),
  'subscription.bonus_expiring': Object.freeze([
    Object.freeze({ key: 'elite_price', path: 'lifecyclePricing.bonusExpiring.eliteAmountMinor' }),
  ]),
  'subscription.bonus_expired': Object.freeze([
    Object.freeze({ key: 'elite_price', path: 'lifecyclePricing.bonusExpired.eliteAmountMinor' }),
  ]),
  'subscription.bonus_removed': Object.freeze([
    Object.freeze({ key: 'elite_price', path: 'lifecyclePricing.bonusRemoved.eliteAmountMinor' }),
  ]),
  'subscription.activated': Object.freeze([
    Object.freeze({ key: 'recurring_price', path: 'activationNotification.recurringAmountMinor' }),
  ]),
  'subscription.downgrade_scheduled': Object.freeze([
    Object.freeze({ key: 'recurring_price', path: 'pendingDowngrade.targetUnitAmountMinor' }),
  ]),
  'subscription.cancelled': Object.freeze([]),
});

const STRIPE_RISK_EVENT_TYPE_BY_CLASSIFICATION = Object.freeze({
  order_refund: 'order.payment_refund_completed',
  order_dispute_opened: 'order.payment_dispute_opened',
  order_dispute_inquiry: 'order.payment_dispute_opened',
  order_dispute_won: 'order.payment_dispute_won',
  order_dispute_won_no_reserve: 'order.payment_dispute_won',
  order_dispute_lost: 'order.payment_dispute_lost',
  wallet_refund: 'wallet.payment_refund_completed',
  wallet_dispute_opened: 'wallet.payment_dispute_opened',
  wallet_dispute_inquiry: 'wallet.payment_dispute_opened',
  wallet_dispute_won: 'wallet.payment_dispute_won',
  wallet_dispute_won_no_reserve: 'wallet.payment_dispute_won',
  wallet_dispute_lost: 'wallet.payment_dispute_lost',
  return_refund: 'return.payment_refund_completed',
  return_dispute_opened: 'return.payment_dispute_opened',
  return_dispute_inquiry: 'return.payment_dispute_opened',
  return_dispute_won: 'return.payment_dispute_won',
  return_dispute_won_no_reserve: 'return.payment_dispute_won',
  return_dispute_lost: 'return.payment_dispute_lost',
});
const STRIPE_RISK_OUTCOME_EVENT_TYPES = new Set(
  Object.values(STRIPE_RISK_EVENT_TYPE_BY_CLASSIFICATION),
);

const ENTITLEMENT_RISK_EVENT_DEFINITIONS = Object.freeze({
  'subscription.refund_confirmed': Object.freeze({ entitlementType: 'subscription', kind: 'refund' }),
  'subscription.dispute_opened': Object.freeze({ entitlementType: 'subscription', kind: 'dispute_opened' }),
  'subscription.dispute_won': Object.freeze({ entitlementType: 'subscription', kind: 'dispute_won' }),
  'subscription.dispute_lost': Object.freeze({ entitlementType: 'subscription', kind: 'dispute_lost' }),
  'subdomain.refund_confirmed': Object.freeze({ entitlementType: 'subdomain', kind: 'refund' }),
  'subdomain.dispute_opened': Object.freeze({ entitlementType: 'subdomain', kind: 'dispute_opened' }),
  'subdomain.dispute_won': Object.freeze({ entitlementType: 'subdomain', kind: 'dispute_won' }),
  'subdomain.dispute_lost': Object.freeze({ entitlementType: 'subdomain', kind: 'dispute_lost' }),
});

const sameInstant = (left, right) => {
  if (!left || !right) return false;
  const leftDate = left instanceof Date ? left : new Date(left);
  const rightDate = right instanceof Date ? right : new Date(right);
  return Number.isFinite(leftDate.getTime())
    && Number.isFinite(rightDate.getTime())
    && leftDate.getTime() === rightDate.getTime();
};

const notificationNoLongerActionable = reason => skipped(
  'NOTIFICATION_NO_LONGER_ACTIONABLE',
  reason,
);

const sellerImpactMoneyPath = sourcePath => {
  const match = /^sellerImpacts\[(\d+)]\.(sourceAmountMinor|amountUSDMinor)$/.exec(
    String(sourcePath || ''),
  );
  return match ? { index: Number(match[1]), field: match[2] } : null;
};

const riskMoneyValue = (event, sourcePath) => {
  if (sourcePath === 'refundDeltaMinor') {
    return { amountMinor: event.refundDeltaMinor, currency: event.currency };
  }
  if (sourcePath === 'disputeExposureMinor') {
    return { amountMinor: event.disputeExposureMinor, currency: event.currency };
  }
  if (sourcePath === 'accountImpact.sourceAmountMinor' && event.accountImpact) {
    return {
      amountMinor: event.accountImpact.sourceAmountMinor,
      currency: event.accountImpact.sourceCurrency,
    };
  }
  const sellerPath = sellerImpactMoneyPath(sourcePath);
  if (!sellerPath) return null;
  const impact = event.sellerImpacts?.[sellerPath.index];
  if (!impact) return null;
  return sellerPath.field === 'sourceAmountMinor'
    ? { amountMinor: impact.sourceAmountMinor, currency: impact.sourceCurrency }
    : { amountMinor: impact.amountUSDMinor, currency: 'USD' };
};

const riskMoneySnapshotMatches = (event, snapshot) => {
  if (
    snapshot?.sourceModel !== 'StripePaymentRiskEvent'
    || String(snapshot?.sourceDocumentId || '') !== String(event?._id || '')
  ) return false;
  const authoritative = riskMoneyValue(event, snapshot.sourcePath);
  return Boolean(
    authoritative
    && Number.isSafeInteger(snapshot.amountMinor)
    && snapshot.amountMinor === authoritative.amountMinor
    && snapshot.currency === authoritative.currency,
  );
};

const verifyStripeRiskNotificationAuthority = async record => {
  const relevant = record.aggregateType === 'StripePaymentRiskEvent'
    || STRIPE_RISK_OUTCOME_EVENT_TYPES.has(record.eventType);
  if (!relevant) return null;
  if (record.aggregateType !== 'StripePaymentRiskEvent') {
    return notificationNoLongerActionable(
      'The Stripe payment-risk receipt has an invalid immutable aggregate owner.',
    );
  }
  const event = await StripePaymentRiskEvent.findById(record.aggregateId)
    .select('classification sourceType occurredAt order walletTopUp returnRequest currency refundDeltaMinor disputeExposureMinor accountImpact sellerImpacts')
    .lean();
  const expectedEventType = STRIPE_RISK_EVENT_TYPE_BY_CLASSIFICATION[event?.classification];
  const expectedSourceType = event?.classification?.startsWith('order_')
    ? 'order_payment'
    : event?.classification?.startsWith('wallet_')
      ? 'wallet_top_up'
      : event?.classification?.startsWith('return_')
        ? 'return_settlement'
        : '';
  if (
    !event
    || !expectedEventType
    || record.eventType !== expectedEventType
    || event.sourceType !== expectedSourceType
    || !sameInstant(record.occurredAt, event.occurredAt)
    || record.financial !== true
    || String(record.payload?.data?.riskEventId || '') !== String(event._id)
    || !Array.isArray(record.money)
    || record.money.length === 0
    || record.money.some(snapshot => !riskMoneySnapshotMatches(event, snapshot))
  ) {
    return notificationNoLongerActionable(
      'The Stripe payment-risk receipt no longer matches its immutable event and money snapshot.',
    );
  }

  const recipientId = String(record.recipient?.user || '');
  if (record.recipient?.audienceRole === 'seller') {
    const ownedImpactIndexes = new Set((event.sellerImpacts || [])
      .map((impact, index) => (String(impact.seller || '') === recipientId ? index : null))
      .filter(index => index !== null));
    const sellerMoneyPaths = record.money
      .map(snapshot => sellerImpactMoneyPath(snapshot.sourcePath))
      .filter(Boolean);
    const ownsImpact = record.recipient?.kind === 'user'
      && recipientId
      && ownedImpactIndexes.size > 0
      && sellerMoneyPaths.length > 0
      && sellerMoneyPaths.every(path => ownedImpactIndexes.has(path.index))
      && record.money.every(snapshot => snapshot.sourcePath !== 'accountImpact.sourceAmountMinor');
    return ownsImpact
      ? null
      : notificationNoLongerActionable(
        'The Stripe payment-risk seller receipt is not owned by this recipient.',
      );
  }

  if (record.recipient?.audienceRole !== 'buyer') {
    return notificationNoLongerActionable(
      'Stripe payment-risk outcomes cannot be delivered to this audience.',
    );
  }
  if (record.money.some(snapshot => sellerImpactMoneyPath(snapshot.sourcePath))) {
    return notificationNoLongerActionable(
      'A Stripe buyer receipt cannot render another account’s seller allocation.',
    );
  }
  if (event.classification === 'order_refund') {
    const order = await Order.findById(event.order).select('_id user').lean();
    if (!order) {
      return notificationNoLongerActionable('The related refunded order no longer exists.');
    }
    const orderUserId = String(order.user || '');
    const ownsOrder = orderUserId
      ? record.recipient?.kind === 'user' && recipientId === orderUserId
      : record.recipient?.kind === 'guest'
        && record.recipient?.guestKey === `order:${String(order._id)}`;
    return ownsOrder
      ? null
      : notificationNoLongerActionable(
        'The Stripe order-refund receipt is not owned by this buyer recipient.',
      );
  }
  if (event.classification.startsWith('wallet_')) {
    const topUp = await WalletTransaction.findById(event.walletTopUp).select('user').lean();
    const ownsWallet = topUp
      && record.recipient?.kind === 'user'
      && recipientId === String(topUp.user || '')
      && (!event.accountImpact || String(event.accountImpact.user || '') === recipientId);
    return ownsWallet
      ? null
      : notificationNoLongerActionable(
        'The Stripe Wallet-risk receipt is not owned by this buyer recipient.',
      );
  }
  return notificationNoLongerActionable(
    'This Stripe payment-risk source has no buyer outcome recipient.',
  );
};

const sameStringArray = (left, right) => (
  Array.isArray(left)
  && Array.isArray(right)
  && left.length === right.length
  && left.every((value, index) => String(value) === String(right[index]))
);

const verifyEntitlementRiskNotificationAuthority = async record => {
  const definition = ENTITLEMENT_RISK_EVENT_DEFINITIONS[record.eventType];
  if (!definition) return null;
  if (record.aggregateType !== 'StripeEntitlementPayment') {
    return notificationNoLongerActionable(
      'The entitlement outcome receipt has an invalid durable payment owner.',
    );
  }
  const payment = await StripeEntitlementPayment.findById(record.aggregateId)
    .select('seller entitlementType disputes riskNotificationIntents')
    .lean();
  const paymentId = String(payment?._id || '');
  if (
    !payment
    || payment.entitlementType !== definition.entitlementType
    || record.recipient?.kind !== 'user'
    || record.recipient?.audienceRole !== 'seller'
    || String(record.recipient?.user || '') !== String(payment.seller || '')
  ) {
    return notificationNoLongerActionable(
      'The entitlement outcome recipient does not own this durable payment.',
    );
  }

  const intents = Array.isArray(payment.riskNotificationIntents)
    ? payment.riskNotificationIntents
    : [];
  const intentIndex = intents.findIndex(intent => (
    intent?.kind === definition.kind
    && record.eventKey === `stripe-entitlement-risk:${paymentId}:${String(intent.intentKey || '')}:seller:v1`
  ));
  const intent = intents[intentIndex];
  const data = record.payload?.data || {};
  const money = Array.isArray(record.money) ? record.money : [];
  const snapshot = money[0];
  const expectedProviderReferences = definition.kind === 'refund'
    ? (intent?.providerRefunds || []).map(refund => String(refund?.refundId || ''))
    : [String(intent?.disputeId || '')];
  const refundEvidenceTotal = definition.kind === 'refund'
    ? (intent?.providerRefunds || []).reduce((total, refund) => (
      Number.isSafeInteger(refund?.amountMinor) ? total + refund.amountMinor : Number.NaN
    ), 0)
    : null;
  if (
    !intent
    || !['pending', 'outboxed'].includes(String(intent.state || ''))
    || !sameInstant(record.occurredAt, intent.occurredAt)
    || record.financial !== true
    || record.recipient.allowBlocked !== true
    || !Number.isSafeInteger(intent.amountMinor)
    || intent.amountMinor <= 0
    || intent.currency !== 'usd'
    || !String(intent.eventId || '')
    || !String(intent.chargeId || '')
    || !String(intent.paymentIntentId || '')
    || expectedProviderReferences.some(reference => !reference)
    || (definition.kind === 'refund' && refundEvidenceTotal !== intent.amountMinor)
    || data.type !== record.eventType.replace(/\./g, '_')
    || String(data.entitlementPaymentId || '') !== paymentId
    || String(data.providerEvent || '') !== String(intent.eventId)
    || data.outcome !== intent.kind
    || !sameStringArray(data.providerReferences, expectedProviderReferences)
    || money.length !== 1
    || snapshot?.key !== 'risk_amount'
    || snapshot?.amountMinor !== intent.amountMinor
    || snapshot?.currency !== 'USD'
    || snapshot?.sourceModel !== 'StripeEntitlementPayment'
    || String(snapshot?.sourceDocumentId || '') !== paymentId
    || snapshot?.sourcePath !== `riskNotificationIntents[${intentIndex}].amountMinor`
  ) {
    return notificationNoLongerActionable(
      'The entitlement outcome no longer matches its immutable provider evidence and money snapshot.',
    );
  }

  if (definition.kind.startsWith('dispute_')) {
    const track = (payment.disputes || []).find(
      dispute => String(dispute?.disputeId || '') === String(intent.disputeId || ''),
    );
    const expectedCurrentState = {
      dispute_opened: intent.disputeState,
      dispute_won: 'won',
      dispute_lost: 'lost',
    }[definition.kind];
    if (!track || !['inquiry', 'open', 'won', 'lost'].includes(expectedCurrentState)
      || track.state !== expectedCurrentState) {
      return notificationNoLongerActionable(
        'A newer Stripe dispute state superseded this queued entitlement outcome.',
      );
    }
  }
  return null;
};

const verifyEntitlementPaymentReceiptAuthority = async record => {
  const definition = ENTITLEMENT_PAYMENT_RECEIPT_DEFINITIONS[record.eventType];
  if (!definition) return null;
  if (record.aggregateType !== 'StripeEntitlementPayment') {
    return notificationNoLongerActionable(
      'The entitlement payment receipt has an invalid durable payment owner.',
    );
  }
  const payment = await StripeEntitlementPayment.findById(record.aggregateId)
    .select('seller store entitlementType completionState capturedMinor currency paymentNotification')
    .lean();
  const paymentId = String(payment?._id || '');
  const money = Array.isArray(record.money) ? record.money : [];
  const snapshot = money[0];
  const data = record.payload?.data || {};
  const expectedEventKey = definition.entitlementType === 'subscription'
    ? `subscription-payment:${paymentId}:${definition.kind}:seller:v1`
    : `subdomain-payment:${paymentId}:seller:v1`;
  const expectedDataType = definition.entitlementType === 'subscription'
    ? `subscription_payment_${definition.kind}`
    : 'subdomain_payment_received';
  if (
    !payment
    || payment.entitlementType !== definition.entitlementType
    || payment.completionState !== 'confirmed'
    || payment.paymentNotification?.kind !== definition.kind
    || !sameInstant(payment.paymentNotification?.occurredAt, record.occurredAt)
    || !Number.isSafeInteger(payment.capturedMinor)
    || payment.capturedMinor <= 0
    || payment.currency !== 'usd'
    || record.eventKey !== expectedEventKey
    || record.financial !== true
    || record.recipient?.kind !== 'user'
    || record.recipient?.audienceRole !== 'seller'
    || record.recipient?.destinationPolicy !== 'current_user'
    || record.recipient?.allowBlocked !== true
    || String(record.recipient?.user || '') !== String(payment.seller || '')
    || data.type !== expectedDataType
    || String(data.paymentId || '') !== paymentId
    || (definition.entitlementType === 'subdomain'
      && String(data.storeId || '') !== String(payment.store || ''))
    || money.length !== 1
    || snapshot?.key !== definition.moneyKey
    || snapshot?.amountMinor !== payment.capturedMinor
    || snapshot?.currency !== 'USD'
    || snapshot?.sourceModel !== 'StripeEntitlementPayment'
    || String(snapshot?.sourceDocumentId || '') !== paymentId
    || snapshot?.sourcePath !== 'capturedMinor'
  ) {
    return notificationNoLongerActionable(
      'The entitlement payment receipt no longer matches its immutable owner, event, and money snapshot.',
    );
  }
  return null;
};

const verifyStripeRiskReviewNotificationAuthority = async record => {
  const relevant = record.aggregateType === 'StripePaymentRiskReview'
    || record.eventType === 'payment.risk_review_required';
  if (!relevant) return null;
  if (
    record.aggregateType !== 'StripePaymentRiskReview'
    || record.eventType !== 'payment.risk_review_required'
  ) {
    return notificationNoLongerActionable(
      'The Stripe payment-risk review alert has an invalid durable review owner.',
    );
  }
  const review = await StripePaymentRiskReview.findById(record.aggregateId)
    .select('reviewKey stripeEventId occurredAt sourceType reasonCode status')
    .lean();
  const recipientId = String(record.recipient?.user || '');
  const data = record.payload?.data || {};
  if (
    !review
    || review.status !== 'open'
    || record.financial !== false
    || !Array.isArray(record.money)
    || record.money.length !== 0
    || record.recipient?.kind !== 'user'
    || record.recipient?.audienceRole !== 'admin'
    || record.recipient?.destinationPolicy !== 'current_user'
    || !recipientId
    || !sameInstant(review.occurredAt, record.occurredAt)
    || record.eventKey !== `stripe-risk-review:${review.reviewKey}:admin:${recipientId}:v1`
    || String(data.reviewId || '') !== String(review._id)
    || String(data.providerEvent || '') !== String(review.stripeEventId)
    || String(data.sourceType || '') !== String(review.sourceType)
    || String(data.reasonCode || '') !== String(review.reasonCode)
  ) {
    return notificationNoLongerActionable(
      'The Stripe payment-risk review is resolved or no longer matches this exact admin alert.',
    );
  }
  return null;
};

const verifySellerOperationalNotificationAuthority = async record => {
  const recipientId = String(record.recipient?.user || '');
  if (record.recipient?.audienceRole !== 'seller') return null;

  if (record.eventType === 'product.blocked') {
    if (record.aggregateType !== 'Product') {
      return notificationNoLongerActionable('The blocked-product alert has an invalid aggregate owner.');
    }
    const product = await Product.findById(record.aggregateId)
      .select('seller isBlocked moderationStatus moderationNotice')
      .lean();
    if (
      !product
      || String(product.seller || '') !== recipientId
      || (product.isBlocked !== true && product.moderationStatus !== 'blocked')
      || !sameInstant(product.moderationNotice?.reviewedAt, record.occurredAt)
    ) {
      return notificationNoLongerActionable(
        'The product is no longer in the exact blocked state described by this alert.'
      );
    }
    return null;
  }

  if (record.eventType === 'store.created') {
    if (record.aggregateType !== 'Store') {
      return notificationNoLongerActionable('The store-created alert has an invalid aggregate owner.');
    }
    const store = await Store.findById(record.aggregateId).select('seller createdAt').lean();
    if (
      !store
      || String(store.seller || '') !== recipientId
      || !sameInstant(store.createdAt, record.occurredAt)
    ) {
      return notificationNoLongerActionable('The created store no longer belongs to this seller.');
    }
    return null;
  }

  const verificationState = {
    'store.verification_approved': { status: 'approved', isVerified: true },
    'store.verification_rejected': { status: 'rejected', isVerified: false },
    'store.verification_removed': { status: 'none', isVerified: false },
  }[record.eventType];
  if (verificationState) {
    if (record.aggregateType !== 'Store') {
      return notificationNoLongerActionable('The store-verification alert has an invalid aggregate owner.');
    }
    const store = await Store.findById(record.aggregateId).select('seller verification').lean();
    if (
      !store
      || String(store.seller || '') !== recipientId
      || store.verification?.status !== verificationState.status
      || store.verification?.isVerified !== verificationState.isVerified
      || !sameInstant(store.verification?.reviewedAt, record.occurredAt)
    ) {
      return notificationNoLongerActionable(
        'The store verification decision was superseded before this alert was delivered.'
      );
    }
    return null;
  }

  if (record.eventType === 'store.review_created') {
    if (record.aggregateType !== 'StoreReview') {
      return notificationNoLongerActionable('The store-review alert has an invalid aggregate owner.');
    }
    const review = await StoreReview.findById(record.aggregateId).select('store createdAt rating').lean();
    const snapshotRating = record.payload?.data?.rating;
    if (
      !review
      || !sameInstant(review.createdAt, record.occurredAt)
      || !Number.isInteger(snapshotRating)
      || snapshotRating < 1
      || snapshotRating > 5
      || review.rating !== snapshotRating
    ) {
      return notificationNoLongerActionable(
        'The related store review no longer matches the exact rating described by this alert.'
      );
    }
    const store = await Store.findById(review.store).select('seller').lean();
    if (!store || String(store.seller || '') !== recipientId) {
      return notificationNoLongerActionable('The related store no longer belongs to this seller.');
    }
  }
  return null;
};

const verifySubscriptionCleanupNotificationAuthority = async record => {
  if (!SUBSCRIPTION_CLEANUP_NOTIFICATION_EVENTS.has(record.eventType)) return null;
  if (record.aggregateType !== 'StripeSubscriptionCleanup') {
    return notificationNoLongerActionable(
      'The Stripe subscription cleanup alert has an invalid durable aggregate owner.',
    );
  }
  const cleanup = await StripeSubscriptionCleanup.findById(record.aggregateId).lean();
  const recipientId = String(record.recipient?.user || '');
  const resolved = record.eventType === 'subscription.cleanup_resolved';
  const expectedInstant = resolved ? cleanup?.completedAt : cleanup?.manualReview?.requiredAt;
  const expectedType = resolved
    ? 'subscription_cleanup_resolved'
    : 'subscription_cleanup_review_required';
  const expectedSuffix = resolved ? 'resolved' : 'required';
  const data = record.payload?.data || {};
  if (
    !cleanup
    || record.recipient?.kind !== 'user'
    || record.recipient?.audienceRole !== 'admin'
    || record.recipient?.destinationPolicy !== 'current_user'
    || !recipientId
    || record.eventKey !== `subscription-cleanup:${cleanup.cleanupKey}:${expectedSuffix}:admin:${recipientId}:v1`
    || !sameInstant(record.occurredAt, expectedInstant)
    || record.financial !== false
    || !Array.isArray(record.money)
    || record.money.length !== 0
    || data.type !== expectedType
    || String(data.cleanupId || '') !== String(cleanup._id)
    || String(data.sellerId || '') !== String(cleanup.seller)
    || data.reason !== cleanup.reason
  ) {
    return notificationNoLongerActionable(
      'The Stripe subscription cleanup alert no longer matches its immutable cleanup evidence.',
    );
  }
  if (resolved) {
    if (
      cleanup.status !== 'completed'
      || cleanup.providerStatus !== 'canceled'
      || !sameInstant(cleanup.cancelledAt, cleanup.completedAt)
      || !sameInstant(cleanup.manualReview?.resolvedAt, cleanup.completedAt)
      || !cleanup.manualReview?.notificationEnqueuedAt
    ) {
      return notificationNoLongerActionable(
        'The Stripe subscription cancellation has not been authoritatively resolved.',
      );
    }
    return null;
  }
  if (
    !['retry', 'processing', 'manual_review'].includes(cleanup.status)
    || cleanup.manualReview?.resolvedAt
  ) {
    return notificationNoLongerActionable(
      'The Stripe subscription cleanup no longer requires administrator review.',
    );
  }
  return null;
};

const subscriptionMoneyAuthority = (subscription, sourcePath) => {
  const amountByPath = {
    'paymentRisk.failureNotification.amountDueMinor': subscription?.paymentRisk?.failureNotification?.amountDueMinor,
    'planChangeAttempt.targetUnitAmountMinor': subscription?.planChangeAttempt?.targetUnitAmountMinor,
    'lifecyclePricing.trialExpiring.starterStandardAmountMinor': subscription?.lifecyclePricing?.trialExpiring?.starterStandardAmountMinor,
    'lifecyclePricing.trialExpiring.starterFounderAmountMinor': subscription?.lifecyclePricing?.trialExpiring?.starterFounderAmountMinor,
    'lifecyclePricing.bonusExpiring.eliteAmountMinor': subscription?.lifecyclePricing?.bonusExpiring?.eliteAmountMinor,
    'lifecyclePricing.bonusExpired.eliteAmountMinor': subscription?.lifecyclePricing?.bonusExpired?.eliteAmountMinor,
    'lifecyclePricing.bonusRemoved.eliteAmountMinor': subscription?.lifecyclePricing?.bonusRemoved?.eliteAmountMinor,
    'activationNotification.recurringAmountMinor': subscription?.activationNotification?.recurringAmountMinor,
    'pendingDowngrade.targetUnitAmountMinor': subscription?.pendingDowngrade?.targetUnitAmountMinor,
  };
  if (!Object.prototype.hasOwnProperty.call(amountByPath, sourcePath)) return null;
  if (
    sourcePath === 'paymentRisk.failureNotification.amountDueMinor'
    && subscription?.paymentRisk?.failureNotification?.currency !== 'USD'
  ) return null;
  if (
    sourcePath === 'activationNotification.recurringAmountMinor'
    && subscription?.activationNotification?.currency !== 'USD'
  ) return null;
  if (
    sourcePath === 'pendingDowngrade.targetUnitAmountMinor'
    && subscription?.pendingDowngrade?.targetCurrency !== 'usd'
  ) return null;
  const amountMinor = amountByPath[sourcePath];
  return Number.isSafeInteger(amountMinor) && amountMinor > 0
    ? { amountMinor, currency: 'USD' }
    : null;
};

const subscriptionMoneySnapshotsMatch = (record, subscription) => {
  const expected = SUBSCRIPTION_EVENT_MONEY[record.eventType];
  if (!expected) return false;
  const money = Array.isArray(record.money) ? record.money : [];
  if (money.length !== expected.length || record.financial !== (expected.length > 0)) return false;
  return expected.every((definition, index) => {
    const snapshot = money[index];
    const authoritative = subscriptionMoneyAuthority(subscription, definition.path);
    return Boolean(
      authoritative
      && snapshot?.key === definition.key
      && snapshot?.amountMinor === authoritative.amountMinor
      && snapshot?.currency === authoritative.currency
      && snapshot?.sourceModel === 'SellerSubscription'
      && String(snapshot?.sourceDocumentId || '') === String(subscription?._id || '')
      && snapshot?.sourcePath === definition.path
    );
  });
};

const verifySubscriptionNotificationAuthority = async record => {
  if (!SUBSCRIPTION_NOTIFICATION_EVENTS.has(record.eventType)) return null;
  if (record.aggregateType !== 'SellerSubscription') {
    return notificationNoLongerActionable('The subscription alert has an invalid aggregate owner.');
  }
  const subscription = await SellerSubscription.findById(record.aggregateId).lean();
  if (!subscription) {
    return notificationNoLongerActionable('The related seller subscription no longer exists.');
  }
  if (
    record.recipient?.kind !== 'user'
    || record.recipient?.audienceRole !== 'seller'
    || String(record.recipient?.user || '') !== String(subscription.seller || '')
  ) {
    return notificationNoLongerActionable(
      'The subscription alert recipient no longer owns this seller subscription.'
    );
  }
  if (!subscriptionMoneySnapshotsMatch(record, subscription)) {
    return notificationNoLongerActionable(
      'The subscription alert no longer matches its exact financial source snapshot.',
    );
  }
  const data = record.payload?.data || {};
  const exactInvoice = String(data.invoiceId || '');
  const exactAttempt = String(data.attemptToken || '');

  switch (record.eventType) {
    case 'subscription.payment_failed': {
      const failure = subscription.paymentRisk?.failureNotification;
      if (
        !['past_due', 'blocked'].includes(subscription.status)
        || subscription.paymentRisk?.suspended !== true
        || !exactInvoice
        || String(subscription.paymentRisk?.latestFailureInvoiceId || '') !== exactInvoice
        || String(failure?.invoiceId || '') !== exactInvoice
        || !sameInstant(failure?.occurredAt, record.occurredAt)
        || String(failure?.stripeSubscriptionId || '') !== String(data.stripeSubscriptionId || '')
        || ['superseded', 'sent'].includes(String(failure?.state || ''))
      ) return notificationNoLongerActionable('The failed subscription invoice has recovered or was superseded.');
      return null;
    }
    case 'subscription.plan_change_action_required':
    case 'subscription.plan_change_completed': {
      const attempt = subscription.planChangeAttempt;
      const completed = record.eventType === 'subscription.plan_change_completed';
      if (
        attempt?.state !== (completed ? 'applied' : 'pending_payment')
        || !exactAttempt
        || String(attempt?.idempotencyToken || '') !== exactAttempt
        || (!completed && (
          !exactInvoice
          || String(attempt?.stripeInvoiceId || '') !== exactInvoice
        ))
        || !sameInstant(
          completed ? attempt?.completedAt : attempt?.notificationStartedAt || attempt?.startedAt,
          record.occurredAt,
        )
        || (completed && !['active', 'free_period'].includes(subscription.status))
      ) return notificationNoLongerActionable('The plan change no longer requires payment authentication.');
      return null;
    }
    case 'subscription.trial_expiring':
      if (
        subscription.status !== 'trial'
        || !sameInstant(subscription.trialEndDate, data.trialEndAt)
      ) return notificationNoLongerActionable('The seller trial is no longer approaching this expiry.');
      return null;
    case 'subscription.trial_blocked':
      if (
        subscription.status !== 'blocked'
        || !/trial period expired/i.test(String(subscription.blockedReason || ''))
        || !sameInstant(subscription.trialEndDate, data.trialEndAt)
      ) return notificationNoLongerActionable('The seller is no longer blocked by this trial expiry.');
      return null;
    case 'subscription.ending_soon':
      if (
        !['active', 'free_period'].includes(subscription.status)
        || !subscription.cancelledAt
        || subscription.pendingDowngrade?.toPlan
        || String(subscription.stripeSubscriptionId || '') !== String(data.stripeSubscriptionId || '')
        || !sameInstant(subscription.currentPeriodEnd, data.currentPeriodEndAt)
      ) return notificationNoLongerActionable('The subscription is no longer scheduled to end at this period boundary.');
      return null;
    case 'subscription.bonus_expiring':
      if (
        subscription.plan === 'elite'
        || subscription.bonusFeaturesActive !== true
        || !sameInstant(subscription.bonusExpiryDate, data.sourceDateAt)
      ) return notificationNoLongerActionable('The Starter bonus is no longer approaching this expiry.');
      return null;
    case 'subscription.bonus_expired':
      if (
        subscription.plan === 'elite'
        || subscription.bonusFeaturesActive === true
        || subscription.bonusFeaturesExpiredPermanently !== true
        || !sameInstant(subscription.bonusExpiredNotificationEventAt, data.sourceDateAt)
      ) return notificationNoLongerActionable('The seller no longer has the expired Starter-bonus state described by this alert.');
      return null;
    case 'subscription.bonus_removed':
      if (
        subscription.plan === 'elite'
        || subscription.bonusFeaturesExpiredPermanently !== true
        || !sameInstant(subscription.bonusGraceExpiredNotificationEventAt, data.sourceDateAt)
      ) return notificationNoLongerActionable('The seller no longer has the Starter grace-expiry state described by this alert.');
      return null;
    case 'subscription.activated': {
      const activation = subscription.activationNotification;
      if (
        !['active', 'free_period'].includes(subscription.status)
        || !['checkout_activation', 'automatic_downgrade'].includes(activation?.kind)
        || String(subscription.stripeSubscriptionId || '') !== String(activation?.stripeSubscriptionId || '')
        || !sameInstant(activation?.occurredAt, record.occurredAt)
        || data.kind !== activation?.kind
      ) return notificationNoLongerActionable('This subscription activation was superseded before delivery.');
      return null;
    }
    case 'subscription.downgrade_scheduled': {
      const pending = subscription.pendingDowngrade;
      if (
        pending?.toPlan !== 'starter'
        || String(subscription.stripeSubscriptionId || '') !== String(pending?.sourceStripeSubscriptionId || '')
        || !sameInstant(pending?.scheduledAt, record.occurredAt)
      ) return notificationNoLongerActionable('This scheduled downgrade is no longer active.');
      return null;
    }
    case 'subscription.cancelled': {
      const transition = subscription.cancellationTransition;
      if (
        subscription.status !== 'blocked'
        || !String(transition?.stripeSubscriptionId || '')
        || String(subscription.stripeSubscriptionId || '') !== String(transition?.stripeSubscriptionId || '')
        || !sameInstant(transition?.cancelledAt, record.occurredAt)
      ) return notificationNoLongerActionable('This ended-subscription block was superseded before delivery.');
      return null;
    }
    default:
      return null;
  }
};

const loadRecipientUser = async record => {
  if (record.recipient?.kind !== 'user') return null;
  if (
    record.recipient.allowBlocked
    && !blockedRecipientEventAllowed(record.eventType, record.recipient.audienceRole)
  ) {
    return skipped(
      'BLOCKED_RECIPIENT_EVENT_FORBIDDEN',
      'This event is not authorized for delivery to a blocked account.'
    );
  }
  const user = await User.findById(record.recipient.user)
    .select('username email role status expoPushTokens sellerInfo.whatsappNumber sellerInfo.whatsappVerified whatsappInfo.number whatsappInfo.verified')
    .lean();
  if (!user) return skipped('RECIPIENT_NOT_FOUND', 'The notification recipient no longer exists.');
  if (!record.recipient.allowBlocked && user.status !== 'active') {
    return skipped('RECIPIENT_BLOCKED', 'The notification recipient is blocked.');
  }
  const roles = allowedCurrentRoles[record.recipient.audienceRole];
  if (!roles?.has(user.role)) {
    return skipped(
      'RECIPIENT_ROLE_CHANGED',
      'The recipient no longer belongs to the event audience.'
    );
  }
  return user;
};

const currentUserEmail = user => {
  const email = String(user?.email || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
};

const resolvedEmail = (record, user) => (
  record.recipient.destinationPolicy === 'event_snapshot'
    ? String(record.recipient.email || '').trim().toLowerCase()
    : currentUserEmail(user)
);

const deliverInApp = async (record, user) => {
  if (!user) return skipped('INAPP_UNAVAILABLE', 'Guest recipients do not have an in-app inbox.');
  try {
    const notification = await Notification.create({
      user: user._id,
      title: record.payload.title,
      body: record.payload.body,
      category: record.payload.category,
      linkTo: record.payload.linkTo,
      source: 'system',
      targetRole: targetRoleForAudience[record.recipient.audienceRole],
      audience: 'specific',
      dedupeKey: `outbox:${record.dedupeKey}`,
      eventKey: record.eventKey,
      eventType: record.eventType,
      aggregateType: record.aggregateType,
      aggregateId: record.aggregateId,
    });
    return delivered(notification._id);
  } catch (error) {
    if (Number(error?.code) === 11000) return delivered('existing-inapp-notification');
    throw error;
  }
};

const deliverPush = async (record, user) => {
  if (!user?.expoPushTokens?.length) {
    return skipped('PUSH_DESTINATION_UNAVAILABLE', 'The recipient has no registered push installation.');
  }
  const result = await sendExpoPushStrict(user.expoPushTokens, {
    title: record.payload.title,
    body: record.payload.body,
    channelId: record.payload.channelId,
    data: {
      ...(record.payload.data || {}),
      category: record.payload.category,
      linkTo: record.payload.linkTo || '',
      notificationEventType: record.eventType,
      notificationEventKey: record.eventKey,
      notificationDedupeKey: record.dedupeKey,
      targetRole: user.role,
      audienceRole: record.recipient.audienceRole,
    },
  }, { recipientUserId: user._id });

  if (result.invalidTokens?.length) {
    await User.updateOne(
      { _id: user._id },
      { $pull: { expoPushTokens: { $in: result.invalidTokens } } }
    );
  }
  if (!result.sentCount) {
    return skipped(
      'PUSH_DESTINATION_UNAVAILABLE',
      'No authoritative active push installation accepted the notification.'
    );
  }
  return delivered(result.ticketIds?.join(',') || `${result.sentCount}-expo-ticket(s)`);
};

const deliverEmail = async (record, user) => {
  const email = resolvedEmail(record, user);
  if (!email) return skipped('EMAIL_DESTINATION_UNAVAILABLE', 'The recipient has no valid email destination.');
  const response = await sendEmail({
    to: email,
    subject: record.payload.subject,
    text: record.payload.text || undefined,
    html: record.payload.html || undefined,
  });
  return delivered(response?.messageId);
};

const TRANSIENT_SELLER_WHATSAPP_REASONS = new Set([
  'seller_instance_not_connected',
  'hourly_cap_reached',
  'send_error',
  'queue_error',
  'no_seller_config',
]);

const deliverSellerWhatsApp = async (record, user) => {
  const result = await notifySeller(
    user._id,
    record.payload.whatsappCategory,
    record.payload.message
  );
  if (result?.sent) return delivered(result.messageId);
  const reason = String(result?.reason || 'seller_whatsapp_failed');
  if (TRANSIENT_SELLER_WHATSAPP_REASONS.has(reason)) {
    throw deliveryError(
      `Seller WhatsApp delivery is temporarily unavailable: ${reason}.`,
      'SELLER_WHATSAPP_TEMPORARILY_UNAVAILABLE'
    );
  }
  return skipped('SELLER_WHATSAPP_SKIPPED', `Seller WhatsApp delivery was skipped: ${reason}.`);
};

const loadRelatedBuyerOrder = async (record, user) => {
  if (!record.payload.relatedOrder) {
    throw deliveryError(
      'Buyer WhatsApp delivery requires its authoritative related order.',
      'BUYER_WHATSAPP_ORDER_REQUIRED',
      { retryable: false }
    );
  }
  const order = await Order.findById(record.payload.relatedOrder);
  if (!order) {
    throw deliveryError('The related order no longer exists.', 'BUYER_WHATSAPP_ORDER_MISSING', {
      retryable: false,
    });
  }
  if (record.recipient.kind === 'user' && String(order.user || '') !== String(user._id)) {
    throw deliveryError(
      'The related order does not belong to the notification recipient.',
      'BUYER_WHATSAPP_ORDER_RECIPIENT_MISMATCH',
      { retryable: false }
    );
  }
  return order;
};

const loadBuyerWhatsAppContext = async (record, user) => {
  const order = await loadRelatedBuyerOrder(record, user);
  const snapshotPhone = record.recipient.destinationPolicy === 'event_snapshot'
    ? normalizePhone(record.recipient.phone)
    : normalizePhone(user?.whatsappInfo?.verified ? user.whatsappInfo.number : '');
  if (!snapshotPhone) {
    return skipped('WHATSAPP_DESTINATION_UNAVAILABLE', 'The buyer has no verified notification number.');
  }
  if (record.recipient.destinationPolicy === 'event_snapshot') {
    let orderPhone;
    try {
      orderPhone = orderBuyerPhoneDigits(order);
    } catch (_error) {
      throw deliveryError(
        'The related order has no valid international WhatsApp destination.',
        'BUYER_WHATSAPP_ORDER_DESTINATION_INVALID',
        { retryable: false }
      );
    }
    if (orderPhone !== snapshotPhone) {
      throw deliveryError(
        'The snapshot WhatsApp destination does not match the related order.',
        'BUYER_WHATSAPP_DESTINATION_MISMATCH',
        { retryable: false }
      );
    }
  }
  return { order, snapshotPhone };
};

const deliverBuyerOrderConfirmationWhatsApp = async (record, user) => {
  const context = await loadBuyerWhatsAppContext(record, user);
  if (context?.outcome === 'skipped') return context;
  const { order } = context;
  // A prior worker may already have handed this event to the durable child
  // queue. Inspect that result before the mutable actionability guard: a buyer
  // can vote between hand-off and the parent outbox retry, and a voted child is
  // still proof that Evolution delivered the original frozen message.
  const existingJob = await findOrderConfirmationJob(order);
  if (existingJob) return buyerWhatsAppJobOutcome(existingJob, { confirmation: true });
  if (
    order.paymentMethod !== 'cash_on_delivery'
    || order.isPaid === true
    || order.orderStatus === 'cancelled'
    || order.confirmation?.confirmedAt
    || order.confirmation?.declinedAt
  ) {
    return skipped(
      'COD_CONFIRMATION_NO_LONGER_ACTIONABLE',
      'The cash on delivery confirmation request is no longer actionable.'
    );
  }
  if (!order.confirmation?.token) {
    throw deliveryError(
      'The cash on delivery order no longer has its confirmation token.',
      'COD_CONFIRMATION_TOKEN_MISSING',
      { retryable: false }
    );
  }
  const frozenTotal = (record.money || []).find(entry => entry.key === 'order_total');
  if (!frozenTotal) {
    throw deliveryError(
      'The interactive confirmation is missing its immutable order total.',
      'COD_CONFIRMATION_MONEY_SNAPSHOT_MISSING',
      { retryable: false }
    );
  }
  const currentTotal = orderTotalSnapshot(order);
  if (
    currentTotal.currency !== frozenTotal.currency
    || currentTotal.amountMinor !== frozenTotal.amountMinor
    || currentTotal.sourceDocumentId !== frozenTotal.sourceDocumentId
  ) {
    throw deliveryError(
      'The cash on delivery order money changed after its confirmation event.',
      'COD_CONFIRMATION_MONEY_SNAPSHOT_DRIFT',
      { retryable: false }
    );
  }
  const formattedTotal = formatMoneySnapshot(frozenTotal);
  const buttonsPayloadJson = String(record.payload.whatsappButtonsPayloadJson || '');
  const listPayloadJson = String(record.payload.whatsappListPayloadJson || '');
  if (
    !buttonsPayloadJson
    || !listPayloadJson
    || !buttonsPayloadJson.includes(formattedTotal)
    || !listPayloadJson.includes(formattedTotal)
  ) {
    throw deliveryError(
      'The interactive confirmation payload does not match its immutable money snapshot.',
      'COD_CONFIRMATION_INTERACTIVE_SNAPSHOT_INVALID',
      { retryable: false }
    );
  }
  const job = await enqueueOrderConfirmation(order, {
    buttonsPayloadJson,
    listPayloadJson,
  });
  if (!job) {
    // Phone and token preconditions were checked above, so a null result here
    // represents a swallowed queue/database error and is safe to retry.
    throw deliveryError(
      'The interactive buyer WhatsApp confirmation could not be queued.',
      'BUYER_WHATSAPP_CONFIRMATION_QUEUE_FAILED'
    );
  }
  return buyerWhatsAppJobOutcome(job, { confirmation: true });
};

const deliverBuyerWhatsApp = async (record, user) => {
  if (record.eventType === 'order.confirmation_requested') {
    return deliverBuyerOrderConfirmationWhatsApp(record, user);
  }
  if (!record.payload.relatedOrder && record.recipient.destinationPolicy === 'current_user') {
    return deliverGenericCurrentUserWhatsApp(record, user);
  }
  const context = await loadBuyerWhatsAppContext(record, user);
  if (context?.outcome === 'skipped') return context;
  const { order, snapshotPhone } = context;
  const childDedupeKey = `outbox:${record.dedupeKey}`;
  // Always replay through the queue's immutable snapshot verifier. Looking up
  // by dedupe key alone could treat a corrupted/colliding child as delivery of
  // different content.
  const job = await enqueueTextNotification({
    order,
    phone: snapshotPhone,
    message: record.payload.message,
    dedupeKey: childDedupeKey,
  });
  return buyerWhatsAppJobOutcome(job);
};

const deliverGenericCurrentUserWhatsApp = async (record, user) => {
  if (record.recipient.destinationPolicy !== 'current_user') {
    throw deliveryError(
      'Generic WhatsApp delivery requires a current-user destination.',
      'WHATSAPP_DESTINATION_POLICY_INVALID',
      { retryable: false },
    );
  }
  const phone = normalizePhone(user?.whatsappInfo?.verified ? user.whatsappInfo.number : '');
  if (!phone) {
    return skipped('WHATSAPP_DESTINATION_UNAVAILABLE', 'The recipient has no verified notification number.');
  }
  const childDedupeKey = `outbox:${record.dedupeKey}`;
  const job = await enqueueGenericTextNotification({
    phone,
    message: record.payload.message,
    dedupeKey: childDedupeKey,
    recipientLabel: user.username || record.recipient.audienceRole,
  });
  return currentUserWhatsAppJobOutcome(job);
};

const deliverWhatsApp = (record, user) => {
  if (record.recipient.audienceRole === 'seller') return deliverSellerWhatsApp(record, user);
  if (record.recipient.audienceRole === 'buyer') return deliverBuyerWhatsApp(record, user);
  if (record.recipient.audienceRole === 'admin') return deliverGenericCurrentUserWhatsApp(record, user);
  return skipped(
    'WHATSAPP_AUDIENCE_UNSUPPORTED',
    `WhatsApp delivery is unsupported for the ${record.recipient.audienceRole || 'missing'} audience.`,
  );
};

async function deliverNotificationRecord(record) {
  const stripeRiskAuthority = await verifyStripeRiskNotificationAuthority(record);
  if (stripeRiskAuthority?.outcome === 'skipped') return stripeRiskAuthority;
  const entitlementRiskAuthority = await verifyEntitlementRiskNotificationAuthority(record);
  if (entitlementRiskAuthority?.outcome === 'skipped') return entitlementRiskAuthority;
  const entitlementReceiptAuthority = await verifyEntitlementPaymentReceiptAuthority(record);
  if (entitlementReceiptAuthority?.outcome === 'skipped') return entitlementReceiptAuthority;
  const stripeRiskReviewAuthority = await verifyStripeRiskReviewNotificationAuthority(record);
  if (stripeRiskReviewAuthority?.outcome === 'skipped') return stripeRiskReviewAuthority;
  const cleanupAuthority = await verifySubscriptionCleanupNotificationAuthority(record);
  if (cleanupAuthority?.outcome === 'skipped') return cleanupAuthority;
  const authority = await verifySubscriptionNotificationAuthority(record);
  if (authority?.outcome === 'skipped') return authority;
  const sellerOperationalAuthority = await verifySellerOperationalNotificationAuthority(record);
  if (sellerOperationalAuthority?.outcome === 'skipped') return sellerOperationalAuthority;
  const resolved = await loadRecipientUser(record);
  if (resolved?.outcome === 'skipped') return resolved;
  const user = resolved;
  if (record.channel === 'inapp') return deliverInApp(record, user);
  if (record.channel === 'push') return deliverPush(record, user);
  if (record.channel === 'email') return deliverEmail(record, user);
  if (record.channel === 'whatsapp') return deliverWhatsApp(record, user);
  throw deliveryError('The notification channel is unsupported.', 'NOTIFICATION_CHANNEL_UNSUPPORTED', {
    retryable: false,
  });
}

module.exports = {
  allowedCurrentRoles,
  buyerWhatsAppJobOutcome,
  deliverNotificationRecord,
  deliverBuyerOrderConfirmationWhatsApp,
  deliveryError,
  targetRoleForAudience,
  verifySellerOperationalNotificationAuthority,
  verifyEntitlementPaymentReceiptAuthority,
  verifyEntitlementRiskNotificationAuthority,
  verifyStripeRiskReviewNotificationAuthority,
  verifyStripeRiskNotificationAuthority,
  verifySubscriptionCleanupNotificationAuthority,
  verifySubscriptionNotificationAuthority,
};
