'use strict';
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Cancellation = require('../models/OrderCancellation');
const Payment = require('../models/SafepayPayment');
const { cancellationView, notifyCancellation } = require('./buyerCancellationService');
const id = value => String(value?._id || value || '');
const fail = (message, code = 'ORDER_CANCELLATION_REFUND_MISMATCH') => Object.assign(new Error(message), { code, statusCode: 409 });

async function holdUnattributedRefund(payment, tracker, rows, session) {
  for (const row of rows.filter(value => ['pending', 'processing'].includes(value.refundStatus))) {
    row.refundStatus = 'manual_review'; row.lastErrorCode = 'ORDER_CANCELLATION_REFUND_MISMATCH'; await row.save({ session });
    const order = await Order.findById(row.order).session(session);
    const fulfillment = order?.sellerFulfillment.find(value => id(value.seller) === id(row.seller));
    if (fulfillment) { fulfillment.cancellation = cancellationView(row); await order.save({ session }); }
  }
  await require('./safepaySettlementService').quarantineSafepayPayment(payment, tracker, session, { skipRefundReconciliation: true });
  return { resolved: false, status: 'manual_review' };
}

// An authorised cancellation refund belongs to one seller. It must never be
// distributed to the unrelated sellers by the generic charge-risk allocator.
async function reconcileCancellationRefund(payment, tracker, session, evidence) {
  const rows = await Cancellation.find({ payment: payment._id }).sort({ createdAt: 1 }).session(session);
  if (!rows.length) return null;
  const pending = rows.find(row => ['processing', 'manual_review'].includes(row.refundStatus) && row.submitStartedAt);
  if (!pending) {
    if (evidence.amountMinor === payment.refundedMinor) return { resolved: true, status: evidence.full ? 'refunded' : 'paid', refundedMinor: evidence.amountMinor };
    return holdUnattributedRefund(payment, tracker, rows, session);
  }
  const fresh = (tracker.charge?.cybersource_refunds || []).filter(row => !pending.previousRefundTokens.includes(row.token));
  const sum = fresh.reduce((total, row) => total + Number(row.totals?.amount), 0);
  if (evidence.amountMinor !== pending.refundTargetMinor || sum !== pending.amountMinor
    || pending.refundBaselineMinor !== payment.refundedMinor || fresh.some(row => row.tracker !== payment.tracker || row.totals?.currency !== payment.currency)) {
    return holdUnattributedRefund(payment, tracker, rows, session);
  }
  pending.refundStatus = 'refunded'; pending.refundedAt = evidence.occurredAt;
  pending.providerRefundTokens = fresh.map(row => row.token); pending.lastErrorCode = '';
  await pending.save({ session });
  const order = await Order.findById(pending.order).session(session);
  const fulfillment = order.sellerFulfillment.find(row => id(row.seller) === id(pending.seller));
  if (!fulfillment || fulfillment.status !== 'cancelled' || id(fulfillment.cancellation?.reference) !== id(pending)) throw fail('Cancellation ownership changed.');
  fulfillment.cancellation = cancellationView(pending); await order.save({ session });
  const RefundEvent = require('../models/SafepayRefundEvent');
  await RefundEvent.updateOne({ payment: payment._id, cumulativeMinor: evidence.amountMinor }, { $setOnInsert: {
    payment: payment._id, environment: payment.environment, currency: payment.currency,
    cumulativeMinor: evidence.amountMinor, deltaMinor: pending.amountMinor, occurredAt: evidence.occurredAt,
    sellerAllocations: [{ seller: pending.seller, amountMinor: pending.amountMinor }],
  } }, { upsert: true, session });
  await notifyCancellation(pending, order, { completed: true, session });
  return { resolved: true, status: evidence.full ? 'refunded' : 'paid', refundedMinor: evidence.amountMinor };
}

async function processCancellationRefund(paymentId) {
  const token = crypto.randomUUID();
  // Share the actual payment lease with webhook reconciliation, not a separate
  // process-local lock. This also serialises cancellations of different sellers.
  const payment = await Payment.findOneAndUpdate({ _id: paymentId, appliedAt: { $ne: null },
    $or: [{ leaseUntil: null }, { leaseUntil: { $lt: new Date() } }] },
  { $set: { processingToken: token, leaseUntil: new Date(Date.now() + 120000) } }, { new: true });
  if (!payment) return;
  try {
    const config = require('../config/safepay').readSafepayConfig(process.env, { requireWebhook: true });
    if (config.environment !== payment.environment) throw fail('The cancellation belongs to a different payment environment.');
    const client = require('./safepayClient').createSafepayClient({ config });
    let row = await Cancellation.findOne({ payment: payment._id, refundStatus: { $in: ['pending', 'processing'] } }).sort({ createdAt: 1 });
    if (!row) return;
    // Back off the whole tracker while an earlier refund is unresolved. A few
    // stalled providers must not occupy the first queue page indefinitely.
    await Cancellation.updateMany({ payment: payment._id, refundStatus: { $in: ['pending', 'processing'] } },
      { $set: { nextAttemptAt: new Date(Date.now() + 30000) } });
    const tracker = await client.getTracker(payment.tracker, payment);
    const { refundEvidence } = require('./safepayRefundService');
    const evidence = refundEvidence(tracker, payment);
    const baseline = evidence?.amountMinor || 0;
    if (row.refundStatus === 'processing') {
      // Lost response recovery is GET-only. Never submit the same refund again.
      if (!evidence || evidence.amountMinor === row.refundBaselineMinor) return;
      await mongoose.connection.transaction(async session => {
        const current = await Payment.findOne({ _id: payment._id, processingToken: token }).session(session);
        if (!current) throw fail('Refund lease changed.');
        const result = await reconcileCancellationRefund(current, tracker, session, evidence);
        if (Number.isSafeInteger(result.refundedMinor)) current.refundedMinor = result.refundedMinor;
        current.status = result.status; current.providerState = tracker.state;
        current.riskPending = result.resolved !== true;
        current.lastErrorCode = result.resolved ? '' : 'ORDER_CANCELLATION_REFUND_MISMATCH'; await current.save({ session });
      });
      return;
    }
    if (baseline !== payment.refundedMinor || baseline + row.amountMinor > payment.amountMinor) throw fail('The refund baseline needs review.');
    if (row.amountMinor === 0) throw fail('A zero cancellation must not start a card refund.');
    row = await Cancellation.findOneAndUpdate({ _id: row._id, refundStatus: 'pending', submitStartedAt: null }, { $set: {
      refundStatus: 'processing', submitStartedAt: new Date(), refundBaselineMinor: baseline,
      refundTargetMinor: baseline + row.amountMinor, previousRefundTokens: (tracker.charge?.cybersource_refunds || []).map(value => value.token),
    } }, { new: true });
    if (!row) return;
    await client.refundPaymentAmount(payment.tracker, payment, row.amountMinor);
    // The next worker/webhook independently reads the provider evidence. A
    // successful POST response alone does not mark the buyer refund completed.
  } catch (error) {
    const transient = error.outcomeUnknown || error.code === 'SAFEPAY_REQUEST_UNCERTAIN'
      || error.providerStatus >= 500 || (!error.providerStatus && error.statusCode >= 500);
    await Cancellation.updateMany({ payment: payment._id, refundStatus: { $in: ['pending', 'processing'] } }, { $set: {
      ...(transient ? {} : { refundStatus: 'manual_review' }), lastErrorCode: error.code || 'ORDER_CANCELLATION_REFUND_REVIEW',
    } });
    if (!transient) await mongoose.connection.transaction(async session => {
      const rows = await Cancellation.find({ payment: payment._id, refundStatus: 'manual_review' }).session(session);
      const order = await Order.findById(payment.order).session(session);
      if (!order) return;
      for (const row of rows) {
        const fulfillment = order.sellerFulfillment.find(entry => id(entry.seller) === id(row.seller));
        if (fulfillment && id(fulfillment.cancellation?.reference) === id(row)) fulfillment.cancellation = cancellationView(row);
        const admins = await require('../models/User').find({ role: 'admin', status: 'active' }).select('_id').session(session).lean();
        for (const admin of admins) await require('./notificationOutboxService').enqueueNotificationEvent({
          eventKey: `cancellation-refund:${row._id}:review:${admin._id}:v1`, eventType: 'payment.cancellation_refund_review',
          aggregateType: 'OrderCancellation', aggregateId: row._id, occurredAt: row.requestedAt, financial: true,
          recipient: { kind: 'user', audienceRole: 'admin', user: admin._id, destinationPolicy: 'current_user' }, channels: ['inapp', 'email'],
          templates: { inapp: { title: 'Cancellation refund needs review', body: 'Verify {{money.amount}} against the original Safepay tracker before retrying. No duplicate refund was submitted.' },
            email: { subject: 'Cancellation refund needs review', text: `Order ${order.orderId}: verify {{money.amount}} against Safepay before retrying.` } },
          money: [require('./notificationMoneySnapshotService').snapshotMinorMoney({ key: 'amount', label: 'Cancellation refund', amountMinor: row.amountMinor,
            currency: row.currency, sourceModel: 'OrderCancellation', sourceDocumentId: row._id, sourcePath: 'amountMinor' })],
          metadata: { category: 'payment', linkTo: '/admin-dashboard/payments', data: { type: 'payment_review', orderId: id(order) } }, session });
      }
      await order.save({ session });
    });
  } finally {
    await Payment.updateOne({ _id: payment._id, processingToken: token }, { $set: { processingToken: '', leaseUntil: null, nextReconcileAt: new Date() } });
  }
}

async function runCancellationRefundWorker() {
  const config = require('../config/safepay').readSafepayConfig(process.env, { requireWebhook: true });
  const rows = await Cancellation.find({ environment: config.environment, refundStatus: { $in: ['pending', 'processing'] },
    nextAttemptAt: { $lte: new Date() } })
    .sort({ createdAt: 1 }).limit(20).select('payment');
  for (const paymentId of new Set(rows.map(row => id(row.payment)).filter(Boolean))) await processCancellationRefund(paymentId);
}

module.exports = { reconcileCancellationRefund, processCancellationRefund, runCancellationRefundWorker };
