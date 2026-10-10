'use strict';

const Operation = require('../models/SafepayBillingOperation');
const Grant = require('../models/SafepaySubdomainGrant');
const Payment = require('../models/SafepayPayment');
const Refund = require('../models/SafepayRefundEvent');
const Subscription = require('../models/SellerSubscription');
const Order = require('../models/Order');
const { tryOrderBuyerPhoneE164 } = require('./orderBuyerContactService');

const id = value => String(value?._id || value || '');
const sameTime = (a, b) => Boolean(a && b && Number.isFinite(new Date(a).getTime())
  && new Date(a).getTime() === new Date(b).getTime());
const minor = value => Number.isSafeInteger(value) && value >= 0;
const rejected = () => ({ outcome: 'skipped', code: 'NOTIFICATION_NO_LONGER_ACTIONABLE',
  reason: 'The Safepay notification does not match its authoritative owner, transition and frozen money.' });
const MODEL_TYPES = new Set(['SafepayBillingOperation', 'SafepaySubdomainGrant', 'SafepayRefundEvent', 'SafepayPayment']);
const isSafepayNotification = record => MODEL_TYPES.has(record.aggregateType)
  || (record.aggregateType === 'SellerSubscription' && String(record.eventKey || '').startsWith('safepay-sub:'));
const sellerRecipient = (record, seller) => record.recipient?.kind === 'user'
  && record.recipient.audienceRole === 'seller' && record.recipient.destinationPolicy === 'current_user'
  && record.recipient.allowBlocked === true && id(record.recipient.user) === id(seller);
const moneyMatches = (record, key, amount, currency, model, documentId, path) => {
  const rows = record.money, m = rows?.[0];
  return record.financial === true && Array.isArray(rows) && rows.length === 1 && minor(amount)
    && m?.key === key && m.amountMinor === amount && m.currency === currency && m.sourceModel === model
    && id(m.sourceDocumentId) === id(documentId) && m.sourcePath === path;
};

async function billingOperation(record) {
  const op = await Operation.findById(record.aggregateId).lean();
  const failure = record.eventType === 'subscription.payment_failed';
  if (!op || !['subscription.payment_received', 'subscription.payment_failed'].includes(record.eventType)
    || op.status !== (failure ? 'failed' : 'applied') || op.terms?.currency !== 'USD'
    || !sellerRecipient(record, op.seller) || record.payload?.data?.type !== 'subscription_updated'
    || id(record.payload.data.operationId) !== id(op)
    || record.eventKey !== `safepay-billing:${op._id}:${record.eventType}:v1`
    || !sameTime(record.occurredAt, op.appliedAt || op.acceptedAt)
    || !moneyMatches(record, 'charged', op.terms.dueMinor, 'USD', 'SafepayBillingOperation', op, 'terms.dueMinor')) return rejected();
  if (failure) {
    const sub = await Subscription.findById(op.subscription).lean();
    if (!sub || id(sub.seller) !== id(op.seller) || sub.billingProvider !== 'safepay'
      || sub.safepayBilling?.environment !== op.environment || id(sub.safepayBilling.lastFailedOperation) !== id(op)
      || !sub.safepayBilling.lastFailureCode) return rejected();
  }
  return null;
}

async function subdomainReceipt(record) {
  const grant = await Grant.findById(record.aggregateId).lean();
  const payment = grant && await Payment.findById(grant.payment).lean();
  if (!grant || !payment || payment.purpose !== 'subdomain' || !payment.appliedAt
    || payment.environment !== grant.environment || id(payment.user) !== id(grant.seller)
    || id(payment.store) !== id(grant.store) || payment.amountMinor !== grant.capturedMinor
    || payment.currency !== grant.currency || grant.currency !== 'USD' || grant.completionState !== 'confirmed'
    || record.eventType !== 'subdomain.payment_received' || !sellerRecipient(record, grant.seller)
    || record.eventKey !== `safepay-subdomain:${payment._id}:received:v1`
    || !sameTime(record.occurredAt, grant.createdAt) || record.payload?.data?.type !== 'subdomain_payment_received'
    || id(record.payload.data.paymentId) !== id(payment) || id(record.payload.data.storeId) !== id(grant.store)
    || !moneyMatches(record, 'paid', grant.capturedMinor, 'USD', 'SafepaySubdomainGrant', grant, 'capturedMinor')) return rejected();
  return null;
}

async function lifecycleNotice(record) {
  const sub = await Subscription.findById(record.aggregateId).lean();
  const b = sub?.safepayBilling, n = b?.notification, data = record.payload?.data;
  if (!sub || sub.billingProvider !== 'safepay' || !n?.contractId || n.contractId !== b.contractId
    || n.version !== b.version || !sellerRecipient(record, sub.seller)
    || data?.type !== 'subscription_updated' || data.lifecycleKind !== n.kind
    || data.contractId !== n.contractId || data.billingVersion !== n.version || id(data.subscriptionId) !== id(sub)
    || !sameTime(record.occurredAt, n.occurredAt)
    || record.eventKey !== `safepay-sub:${sub._id}:${n.contractId}:${n.kind}:${new Date(n.occurredAt).getTime()}`
    || !moneyMatches(record, 'monthly', n.monthlyMinor, 'USD', 'SellerSubscription', sub, 'safepayBilling.notification.monthlyMinor')) return rejected();
  const states = {
    cancel_scheduled: !b.autoRenew && Boolean(sub.cancelledAt) && !sub.pendingDowngrade?.toPlan,
    ended: !b.autoRenew && sub.status === 'cancelled' && sameTime(b.endedAt, n.occurredAt),
    resumed: b.autoRenew && !sub.cancelledAt && !sub.pendingDowngrade?.toPlan,
    downgrade_scheduled: b.autoRenew && sub.pendingDowngrade?.toPlan === 'starter',
    downgrade_cancelled: b.autoRenew && !sub.cancelledAt && !sub.pendingDowngrade?.toPlan,
  };
  const type = ['ended', 'cancel_scheduled'].includes(n.kind) ? 'subscription.cancelled' : 'subscription.payment_received';
  return states[n.kind] && record.eventType === type ? null : rejected();
}

async function refundReceipt(record) {
  const refund = await Refund.findById(record.aggregateId).lean();
  const payment = refund && await Payment.findById(refund.payment).lean();
  const order = payment && await Order.findById(payment.order).lean();
  if (!refund || !payment || !order || payment.purpose !== 'order' || payment.environment !== refund.environment
    || payment.currency !== refund.currency || !minor(refund.cumulativeMinor) || !minor(refund.deltaMinor)
    || !minor(payment.refundedMinor) || !minor(payment.amountMinor)
    || refund.deltaMinor <= 0 || refund.deltaMinor > refund.cumulativeMinor || refund.cumulativeMinor > payment.refundedMinor
    || refund.cumulativeMinor > payment.amountMinor || record.eventType !== 'order.payment_refund_completed'
    || !sameTime(record.occurredAt, refund.occurredAt) || record.payload?.data?.type !== 'order_refund'
    || id(record.payload.data.orderId) !== id(order) || id(record.payload.relatedOrder) !== id(order)
    || id(order.safepayPaymentId) !== id(payment) || id(order.user) !== id(payment.user)
    || order.safepayEnvironment !== payment.environment || order.currency !== payment.currency) return rejected();
  const recipient = record.recipient || {}, isSeller = recipient.audienceRole === 'seller';
  const index = isSeller ? refund.sellerAllocations.findIndex(row => id(row.seller) === id(recipient.user)) : -1;
  if (isSeller) {
    if (index < 0 || !sellerRecipient(record, refund.sellerAllocations[index].seller)) return rejected();
  } else if (recipient.audienceRole !== 'buyer' || recipient.destinationPolicy !== 'event_snapshot'
    || (order.user ? recipient.kind !== 'user' || id(recipient.user) !== id(order.user)
      : recipient.kind !== 'guest' || recipient.guestKey !== `order:${order._id}`)
    || (recipient.email || '') !== String(order.shippingInfo?.email || '').trim().toLowerCase()
    || (recipient.phone || '') !== tryOrderBuyerPhoneE164(order).replace(/\D/g, '')) return rejected();
  const amount = isSeller ? refund.sellerAllocations[index].amountMinor : refund.deltaMinor;
  return record.eventKey === `safepay-refund:${payment._id}:${refund.cumulativeMinor}:${isSeller ? id(recipient.user) : 'buyer'}:v1`
    && moneyMatches(record, 'refund', amount, refund.currency, 'SafepayRefundEvent', refund,
      isSeller ? `sellerAllocations[${index}].amountMinor` : 'deltaMinor') ? null : rejected();
}

async function refundReview(record) {
  const payment = await Payment.findById(record.aggregateId).lean();
  const r = record.recipient || {}, data = record.payload?.data;
  const unsubmittedReview = payment?.status === 'manual_review' && payment.safetyRefund?.outcome === 'failed'
    && payment.safetyRefund?.submitStartedAt == null && payment.safetyRefund?.requestedAt
    // Only missing refund capability establishes this no-submit owed-money
    // notice. A mismatched owner/tracker must not turn into a refund claim.
    && ['SAFEPAY_RAAST_REFUND_UNAVAILABLE', 'SAFEPAY_REFUND_RAIL_UNVERIFIED'].includes(payment.lastErrorCode)
    && minor(payment.amountMinor) && payment.amountMinor > 0 && payment.capturedMinor === payment.amountMinor
    && minor(payment.refundedMinor) && minor(payment.walletRefundMinor)
    && payment.refundedMinor + payment.walletRefundMinor < payment.amountMinor
    && Boolean(payment.paidAt && Number.isFinite(new Date(payment.paidAt).getTime()));
  // A preflight rejection has no POST timestamp. Its exact durable review
  // marker is the original request time, while post-POST notices retain theirs.
  const reviewTime = unsubmittedReview ? payment.safetyRefund.requestedAt : payment?.safetyRefund?.submitStartedAt;
  if (!payment || payment.purpose !== 'order' || payment.appliedAt || (payment.status !== 'refund_pending' && !unsubmittedReview)
    || !['failed', 'unknown'].includes(payment.safetyRefund?.outcome) || !payment.safetyRefund?.requestedAt
    || record.eventType !== 'payment.refund_review_required' || !['inapp', 'email'].includes(record.channel)
    || r.kind !== 'user' || r.audienceRole !== 'admin' || r.destinationPolicy !== 'current_user' || !id(r.user)
    || record.eventKey !== `safepay:${payment._id}:refund-review:${id(r.user)}:v1`
    || !sameTime(record.occurredAt, reviewTime)
    || data?.type !== 'payment_review' || id(data.paymentId) !== id(payment)
    || !moneyMatches(record, 'amount', payment.amountMinor, payment.currency, 'SafepayPayment', payment, 'amountMinor')) return rejected();
  return null;
}

async function verifySafepayNotificationAuthority(record) {
  switch (record.aggregateType) {
    case 'SafepayBillingOperation': return billingOperation(record);
    case 'SafepaySubdomainGrant': return subdomainReceipt(record);
    case 'SafepayRefundEvent': return refundReceipt(record);
    case 'SafepayPayment': return refundReview(record);
    case 'SellerSubscription': return lifecycleNotice(record);
    default: return rejected();
  }
}

module.exports = { isSafepayNotification, verifySafepayNotificationAuthority };
