'use strict';

const PAYMENT_RAILS = Object.freeze(['unknown', 'card', 'raast']);
const RAAST_ATTEMPT_STATUSES = Object.freeze(['UNSPECIFIED', 'INITIATED', 'RECEIVED', 'AUTHORIZED', 'CAPTURED',
  'SETTLED', 'CANCELLED', 'REJECTED', 'FAILED', 'REVERSED', 'PARTIALLY_REFUNDED', 'REFUNDED']);
const statusSet = new Set(RAAST_ATTEMPT_STATUSES);
const normalizeSafepayPaymentRail = value => PAYMENT_RAILS.includes(value) ? value : 'unknown';
const normalizeRaastAttemptStatus = value => statusSet.has(value) ? value : null;
const validDate = value => (value instanceof Date || typeof value === 'string' && value.trim().length > 0)
  && Number.isFinite(new Date(value).getTime());
const hasTrustedSafepayCapture = payment => Number.isSafeInteger(payment.amountMinor) && payment.amountMinor > 0
  && (validDate(payment.appliedAt) || validDate(payment.paymentRailCapturedAt)
    || payment.capturedMinor === payment.amountMinor && validDate(payment.paidAt));
const railError = () => Object.assign(new Error('The payment rail does not match this checkout.'), {
  code: 'SAFEPAY_PAYMENT_RAIL_MISMATCH', statusCode: 409,
});

// Call only with a freshly fetched, identity/amount-validated provider tracker.
// Browser choices, callbacks and webhook payloads are not payment-rail evidence.
function safepayPaymentRailFacts(tracker, expected = {}) {
  const providerIntent = ['CYBERSOURCE', 'RAAST'].includes(tracker?.intent) ? tracker.intent : '';
  if (providerIntent !== 'RAAST') return {
    paymentRail: providerIntent === 'CYBERSOURCE' ? 'card' : 'unknown',
    providerIntent, raastAttemptStatus: null,
  };
  const currency = expected.currency || tracker?.purchase_totals?.quote_amount?.currency;
  const mode = expected.providerMode || tracker?.mode || 'payment';
  if (currency !== 'PKR' || mode !== 'payment' || tracker?.mode && tracker.mode !== 'payment'
      || ['card_setup', 'subscription'].includes(expected.purpose)
      || expected.providerEntryMode === 'tms' || tracker?.entry_mode === 'tms' || tracker?.entry_mode === 'mit') throw railError();
  return { paymentRail: 'raast', providerIntent,
    // Reporter responses can omit the Raast payment. Never invent its state or
    // consume an unrelated top-level wrapper as evidence for this tracker.
    raastAttemptStatus: normalizeRaastAttemptStatus(tracker?.raast_payment?.status),
  };
}

function safepayPaymentRailObservation(payment, tracker, at = new Date()) {
  const facts = safepayPaymentRailFacts(tracker, payment);
  const previousRail = normalizeSafepayPaymentRail(payment.paymentRail);
  const previouslyCaptured = hasTrustedSafepayCapture(payment);
  if (previouslyCaptured && previousRail !== 'unknown' && facts.paymentRail !== 'unknown' && previousRail !== facts.paymentRail) {
    throw Object.assign(new Error('The verified payment rail changed after capture. Payment review is required.'), {
      code: 'SAFEPAY_PAYMENT_RAIL_CHANGED', statusCode: 409,
    });
  }
  // Capture and fulfillment are separate: stock failure or a process crash can
  // leave captured money unapplied. Neither may unpin its verified rail.
  const retainPaidRail = previouslyCaptured && previousRail !== 'unknown' && facts.paymentRail === 'unknown';
  const paymentRail = retainPaidRail ? previousRail : facts.paymentRail;
  const captureDate = validDate(payment.paymentRailCapturedAt) ? payment.paymentRailCapturedAt
    : previouslyCaptured && paymentRail !== 'unknown' ? (validDate(payment.paidAt) ? payment.paidAt : validDate(payment.appliedAt) ? payment.appliedAt : at)
      : tracker.state === 'TRACKER_ENDED' && payment.amountMinor > 0 && facts.paymentRail !== 'unknown' ? at : null;
  return { paymentRail: retainPaidRail ? previousRail : facts.paymentRail,
    providerIntent: retainPaidRail && ['CYBERSOURCE', 'RAAST'].includes(payment.providerIntent) ? payment.providerIntent : facts.providerIntent,
    paymentRailObservedAt: facts.paymentRail !== 'unknown' ? at : retainPaidRail ? payment.paymentRailObservedAt || null : null,
    paymentRailCapturedAt: captureDate,
    raastAttemptStatus: (retainPaidRail ? previousRail : facts.paymentRail) === 'raast' ? facts.raastAttemptStatus : null };
}

async function refreshOwnedSafepayOrderRail(order) {
  // Lazy imports keep the pure classifier usable by the payment schemas/client.
  const mongoose = require('mongoose');
  const crypto = require('node:crypto');
  const Payment = require('../models/SafepayPayment');
  const Order = require('../models/Order');
  const { assertSafepayOrderBinding } = require('./safepayPaymentFacts');
  const { getExpectedStripeTotalMinor: expectedOrderMinor } = require('./stripeOrderPaymentService');
  const needsReconciliation = () => Object.assign(new Error('The original payment needs reconciliation before its refund options can be verified.'), {
    code: 'SAFEPAY_PAYMENT_NEEDS_RECONCILIATION', statusCode: 409,
  });
  if (!order || order.paymentMethod !== 'safepay' || order.isPaid !== true || order.awaitingPayment === true
      || !mongoose.isValidObjectId(order.safepayPaymentId)) throw needsReconciliation();
  const amountMinor = expectedOrderMinor(order);
  const owned = { _id: order.safepayPaymentId, order: order._id, user: order.user || null, purpose: 'order',
    environment: order.safepayEnvironment, currency: order.currency, amountMinor, providerMode: 'payment',
    status: 'paid', capturedMinor: amountMinor, paidAt: { $ne: null }, appliedAt: { $ne: null }, riskPending: false };
  const at = new Date(), lease = crypto.randomUUID();
  const payment = await Payment.findOneAndUpdate({ ...owned,
    $or: [{ leaseUntil: null }, { leaseUntil: { $lt: at } }] },
  { $set: { processingToken: lease, leaseUntil: new Date(at.getTime() + 90000) } }, { new: true });
  if (!payment) {
    if (await Payment.exists(owned)) throw Object.assign(needsReconciliation(), { statusCode: 503, retryAfterSeconds: 4 });
    throw needsReconciliation();
  }
  try {
    if (amountMinor <= 0 || !validDate(payment.paidAt) || !validDate(payment.appliedAt)) throw needsReconciliation();
    const config = require('../config/safepay').readSafepayConfig(process.env, { requireWebhook: true });
    if (config.environment !== payment.environment) throw needsReconciliation();
    const tracker = await require('./safepayClient').createSafepayClient({ config }).getTracker(payment.tracker, payment);
    if (safepayPaymentRailFacts(tracker, payment).paymentRail === 'unknown') throw needsReconciliation();
    let observation;
    try { observation = safepayPaymentRailObservation(payment, tracker, at); }
    catch (error) {
      if (error.code !== 'SAFEPAY_PAYMENT_RAIL_CHANGED') throw error;
      await mongoose.connection.transaction(async session => {
        const current = await Payment.findOne({ ...owned, processingToken: lease }).session(session);
        if (!current) throw needsReconciliation();
        await require('./safepaySettlementService').quarantineSafepayPayment(current, tracker, session, { skipRefundReconciliation: true });
        current.status = 'manual_review'; current.riskPending = true; current.lastErrorCode = error.code;
        current.nextReconcileAt = new Date(); await current.save({ session });
      });
      throw error;
    }
    if (tracker.state === 'TRACKER_PARTIAL_REFUND') {
      // A previously accounted card refund can leave the remaining order paid.
      // New/unsupported external evidence belongs to the financial reconciler.
      if (observation.paymentRail !== 'card') throw needsReconciliation();
      let evidence;
      try { evidence = require('./safepayRefundService').refundEvidence(tracker, payment); } catch (_) { throw needsReconciliation(); }
      if (!evidence || evidence.amountMinor !== payment.refundedMinor) throw needsReconciliation();
    } else if (tracker.state !== 'TRACKER_ENDED' || payment.refundedMinor !== 0) throw needsReconciliation();
    if (!Number.isSafeInteger(payment.refundedMinor) || payment.refundedMinor < 0
        || !Number.isSafeInteger(payment.walletRefundMinor) || payment.walletRefundMinor < 0
        || payment.refundedMinor + payment.walletRefundMinor > amountMinor) throw needsReconciliation();
    await mongoose.connection.transaction(async session => {
      const current = await Payment.findOne({ ...owned, processingToken: lease }).session(session);
      const currentOrder = await Order.findById(order._id).session(session);
      if (!current || !currentOrder || currentOrder.isPaid !== true || currentOrder.awaitingPayment === true
          || !validDate(current.paidAt) || !validDate(current.appliedAt)
          || current.refundedMinor !== payment.refundedMinor || current.walletRefundMinor !== payment.walletRefundMinor) throw needsReconciliation();
      assertSafepayOrderBinding(currentOrder, current, expectedOrderMinor(currentOrder));
      Object.assign(current, observation); await current.save({ session });
      if (normalizeSafepayPaymentRail(currentOrder.safepayPaymentRail) !== observation.paymentRail) {
        const updated = await Order.updateOne({ _id: currentOrder._id, user: current.user, paymentMethod: 'safepay', isPaid: true,
          safepayPaymentId: current._id, safepayEnvironment: current.environment, currency: current.currency },
        { $set: { safepayPaymentRail: observation.paymentRail } }, { session });
        if (updated.matchedCount !== 1) throw needsReconciliation();
      }
    });
    // Refresh the caller's display snapshot too; the quote hashes the stable
    // rail, never the observation timestamp or confidential provider details.
    order.safepayPaymentRail = observation.paymentRail;
    return { paymentId: String(payment._id), paymentRail: observation.paymentRail,
      providerIntent: observation.providerIntent, raastAttemptStatus: observation.raastAttemptStatus };
  } finally {
    await Payment.updateOne({ _id: payment._id, processingToken: lease }, { $set: { processingToken: '', leaseUntil: null } });
  }
}

module.exports = { PAYMENT_RAILS, RAAST_ATTEMPT_STATUSES, normalizeSafepayPaymentRail,
  normalizeRaastAttemptStatus, safepayPaymentRailFacts, safepayPaymentRailObservation, hasTrustedSafepayCapture, refreshOwnedSafepayOrderRail };
