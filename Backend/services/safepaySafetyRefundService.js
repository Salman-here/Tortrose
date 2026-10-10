'use strict';
const mongoose = require('mongoose');
const Payment = require('../models/SafepayPayment');
const Order = require('../models/Order');
const { assertSafepayOrderBinding } = require('./safepayPaymentFacts');
const { getExpectedStripeTotalMinor: orderTotalMinor } = require('./stripeOrderPaymentService');
const { cancelUnpaidOrderLocally } = require('./orderCancellationService');
const { enqueueNotificationEvent } = require('./notificationOutboxService');
const { snapshotMinorMoney } = require('./notificationMoneySnapshotService');
const { externalRefundCapability, requireExternalRefundRail } = require('./safepayRefundCapabilityService');

const isFulfillmentFailure = error => ['ORDER_STOCK_CHANGED', 'CHECKOUT_REPRICE_REQUIRED', 'STORE_DELIVERY_UNAVAILABLE',
  'SAFEPAY_SELLER_UNAVAILABLE', 'SAFEPAY_OPTIONS_CHANGED', 'SAFEPAY_ORDER_INTENT_CLOSED', 'SAFEPAY_ORDER_SETTLEMENT_CONFLICT'].includes(error?.code)
  || (/^COUPON_/.test(error?.code || '') && [400, 409].includes(error.statusCode));

async function schedule(paymentId, reasonCode) {
  return mongoose.connection.transaction(async session => {
    const payment = await Payment.findById(paymentId).session(session);
    if (!payment || payment.appliedAt || payment.purpose !== 'order') throw new Error('Safety refund ownership changed.');
    const order = await Order.findById(payment.order).session(session);
    assertSafepayOrderBinding(order, payment, orderTotalMinor(order));
    if (order.isPaid || order.paymentFulfilledAt) throw new Error('Cannot safety-refund a fulfilled order.');
    payment.status = 'refund_pending'; payment.capturedMinor = payment.amountMinor;
    payment.providerState = 'TRACKER_ENDED'; payment.paidAt = payment.paidAt || new Date();
    payment.safetyRefund.reasonCode = payment.safetyRefund.reasonCode || reasonCode;
    payment.safetyRefund.requestedAt = payment.safetyRefund.requestedAt || new Date();
    payment.nextReconcileAt = new Date();
    await payment.save({ session });
    // This closes only Rozare's fulfillment intent. It does not claim the
    // provider checkout is closed; the captured amount has a durable refund.
    const external = externalRefundCapability(payment.paymentRail);
    await cancelUnpaidOrderLocally({ orderId: order._id, externalPaymentClosed: true, session,
      reason: external.available ? 'The payment arrived after the order could no longer be fulfilled. A refund is being verified.'
        : 'The payment arrived after the order could no longer be fulfilled. The refund requires support review.',
      paymentFailure: { code: 'SAFEPAY_SAFETY_REFUND_PENDING', message: external.available
        ? 'Your payment could not complete this order. A refund to the original card is being verified.'
        : 'Your payment could not complete this order. The captured amount is owed back to you and requires support review; no bank refund has been confirmed.' } });
    return payment;
  });
}

async function submit(payment, client) {
  // A read/preflight failure is not an uncertain refund submission. Keep a
  // durable liability without calling the card API or claiming bank delivery.
  try {
    const tracker = await client.getTracker(payment.tracker, payment);
    requireExternalRefundRail(tracker, payment);
  } catch (error) {
    const requiresReview = error.definitiveNoMutation || [400, 401, 403, 404, 409, 422].includes(error.statusCode);
    if (requiresReview) {
      const updated = await Payment.updateOne({ _id: payment._id, status: 'refund_pending', appliedAt: null,
        'safetyRefund.submitStartedAt': null, 'safetyRefund.outcome': { $ne: 'confirmed' } }, { $set: {
        status: 'manual_review', riskPending: true, 'safetyRefund.outcome': 'failed',
        lastErrorCode: error.code || 'SAFEPAY_REFUND_PREFLIGHT_INVALID', nextReconcileAt: new Date(Date.now() + 60000),
      } });
      if (updated.modifiedCount === 1) await notifyRefundReview(payment, { notSubmitted: true });
    } else {
      await Payment.updateOne({ _id: payment._id, status: 'refund_pending', appliedAt: null,
        'safetyRefund.submitStartedAt': null, 'safetyRefund.outcome': { $ne: 'confirmed' } }, { $set: {
        lastErrorCode: error.code || 'SAFEPAY_REFUND_PREFLIGHT_UNAVAILABLE', nextReconcileAt: new Date(Date.now() + 60000),
      } });
    }
    return;
  }
  // At most one external mutation. If a response is lost, read the same
  // tracker on later runs; never submit a second refund based on a timeout.
  const claimed = await Payment.findOneAndUpdate({ _id: payment._id, status: 'refund_pending', appliedAt: null,
    'safetyRefund.requestedAt': { $ne: null }, 'safetyRefund.submitStartedAt': null, 'safetyRefund.outcome': { $ne: 'confirmed' } },
  { $set: { 'safetyRefund.submitStartedAt': new Date(), 'safetyRefund.outcome': 'unknown' } }, { new: true });
  if (!claimed) return;
  try {
    await client.refundRemainingPayment(claimed.tracker, claimed);
    await Payment.updateOne({ _id: claimed._id, status: 'refund_pending', appliedAt: null,
      'safetyRefund.submitStartedAt': claimed.safetyRefund.submitStartedAt, 'safetyRefund.outcome': { $ne: 'confirmed' } },
    { $set: { 'safetyRefund.submittedAt': new Date(), nextReconcileAt: new Date() } });
  } catch (error) {
    const updated = await Payment.updateOne({ _id: claimed._id, status: 'refund_pending', appliedAt: null,
      'safetyRefund.submitStartedAt': claimed.safetyRefund.submitStartedAt, 'safetyRefund.outcome': { $ne: 'confirmed' } },
    { $set: { 'safetyRefund.outcome': error.outcomeUnknown ? 'unknown' : 'failed',
      lastErrorCode: error.outcomeUnknown ? 'SAFEPAY_REFUND_OUTCOME_UNKNOWN' : 'SAFEPAY_REFUND_NEEDS_REVIEW', nextReconcileAt: new Date() } });
    if (updated.modifiedCount === 1) await notifyRefundReview(claimed);
  }
}
async function notifyRefundReview(payment, { notSubmitted = false } = {}) {
    const at = payment.safetyRefund.submitStartedAt || payment.safetyRefund.requestedAt || new Date();
    const admins = await require('../models/User').find({ role: 'admin', status: 'active' }).select('_id').lean();
    for (const admin of admins) await enqueueNotificationEvent({ eventKey: `safepay:${payment._id}:refund-review:${admin._id}:v1`,
      eventType: 'payment.refund_review_required', aggregateType: 'SafepayPayment', aggregateId: payment._id, occurredAt: at,
      financial: true, recipient: { kind: 'user', audienceRole: 'admin', user: admin._id, destinationPolicy: 'current_user' },
      channels: ['inapp', 'email'], templates: { inapp: { title: 'Safepay refund needs verification', body: notSubmitted
        ? 'Payment {{money.amount}} is owed back to the buyer. Automatic refund was not submitted; review the original method and arrange a supported resolution.'
        : 'Payment {{money.amount}} needs refund reconciliation. Do not submit another refund until its provider outcome is checked.' },
        email: { subject: 'Safepay refund needs verification', text: notSubmitted
          ? `Payment ${payment._id} for {{money.amount}} is owed back to the buyer. No automatic bank refund was submitted. Review and arrange a supported resolution.`
          : `Payment ${payment._id} for {{money.amount}} requires reconciliation. No duplicate refund was attempted.` } },
      money: [snapshotMinorMoney({ key: 'amount', label: 'Original payment', amountMinor: payment.amountMinor, currency: payment.currency,
        sourceModel: 'SafepayPayment', sourceDocumentId: payment._id, sourcePath: 'amountMinor' })],
      metadata: { category: 'payment', linkTo: '/admin-dashboard/payments', data: { type: 'payment_review', paymentId: String(payment._id) } } });
}
module.exports = { isFulfillmentFailure, schedule, submit };
