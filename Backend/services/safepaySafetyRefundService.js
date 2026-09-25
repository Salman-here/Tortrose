'use strict';
const mongoose = require('mongoose');
const Payment = require('../models/SafepayPayment');
const Order = require('../models/Order');
const { assertSafepayOrderBinding } = require('./safepayPaymentFacts');
const { getExpectedStripeTotalMinor: orderTotalMinor } = require('./stripeOrderPaymentService');
const { cancelUnpaidOrderLocally } = require('./orderCancellationService');
const { enqueueNotificationEvent } = require('./notificationOutboxService');
const { snapshotMinorMoney } = require('./notificationMoneySnapshotService');

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
    await cancelUnpaidOrderLocally({ orderId: order._id, externalPaymentClosed: true, session,
      reason: 'The payment arrived after the order could no longer be fulfilled. A refund is being verified.',
      paymentFailure: { code: 'SAFEPAY_SAFETY_REFUND_PENDING', message: 'Your payment could not complete this order. A refund to the original card is being verified.' } });
    return payment;
  });
}

async function submit(payment, client) {
  // At most one external mutation. If a response is lost, read the same
  // tracker on later runs; never submit a second refund based on a timeout.
  const claimed = await Payment.findOneAndUpdate({ _id: payment._id, status: 'refund_pending', appliedAt: null,
    'safetyRefund.requestedAt': { $ne: null }, 'safetyRefund.submitStartedAt': null },
  { $set: { 'safetyRefund.submitStartedAt': new Date(), 'safetyRefund.outcome': 'unknown' } }, { new: true });
  if (!claimed) return;
  try {
    await client.refundRemainingPayment(claimed.tracker, claimed);
    await Payment.updateOne({ _id: claimed._id }, { $set: { 'safetyRefund.submittedAt': new Date(), nextReconcileAt: new Date() } });
  } catch (error) {
    await Payment.updateOne({ _id: claimed._id }, { $set: { 'safetyRefund.outcome': error.outcomeUnknown ? 'unknown' : 'failed',
      lastErrorCode: error.outcomeUnknown ? 'SAFEPAY_REFUND_OUTCOME_UNKNOWN' : 'SAFEPAY_REFUND_NEEDS_REVIEW', nextReconcileAt: new Date() } });
    const at = claimed.safetyRefund.submitStartedAt;
    const admins = await require('../models/User').find({ role: 'admin', status: 'active' }).select('_id').lean();
    for (const admin of admins) await enqueueNotificationEvent({ eventKey: `safepay:${claimed._id}:refund-review:${admin._id}:v1`,
      eventType: 'payment.refund_review_required', aggregateType: 'SafepayPayment', aggregateId: claimed._id, occurredAt: at,
      financial: true, recipient: { kind: 'user', audienceRole: 'admin', user: admin._id, destinationPolicy: 'current_user' },
      channels: ['inapp', 'email'], templates: { inapp: { title: 'Safepay refund needs verification', body: 'Payment {{money.amount}} needs refund reconciliation. Do not submit another refund until its provider outcome is checked.' },
        email: { subject: 'Safepay refund needs verification', text: `Payment ${claimed._id} for {{money.amount}} requires reconciliation. No duplicate refund was attempted.` } },
      money: [snapshotMinorMoney({ key: 'amount', label: 'Original payment', amountMinor: claimed.amountMinor, currency: claimed.currency,
        sourceModel: 'SafepayPayment', sourceDocumentId: claimed._id, sourcePath: 'amountMinor' })],
      metadata: { category: 'payment', linkTo: '/admin-dashboard/payments', data: { type: 'payment_review', paymentId: String(claimed._id) } } });
  }
}
module.exports = { isFulfillmentFailure, schedule, submit };
