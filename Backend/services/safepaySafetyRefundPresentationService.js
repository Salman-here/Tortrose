'use strict';
const Payment = require('../models/SafepayPayment');
const RefundEvent = require('../models/SafepayRefundEvent');
const { getExpectedStripeTotalMinor } = require('./stripeOrderPaymentService');
const id = value => String(value?._id || value || '');
const positiveMinor = value => Number.isSafeInteger(value) && value > 0;
const validDate = value => (value instanceof Date || typeof value === 'string') && value && Number.isFinite(new Date(value).getTime());
const unavailable = () => ({ available: false, status: 'unavailable' });

function isSafetyRefundCheckout(order) {
  return order?.paymentMethod === 'safepay' && order.orderStatus === 'cancelled'
    && order.awaitingPayment === true
    && order.paymentResult?.failureCode === 'SAFEPAY_SAFETY_REFUND_PENDING';
}

// Keep ordinary abandoned checkouts hidden. This marker is written only after
// a captured, owner/amount-bound payment could not fulfill its frozen order.
function buyerOrderVisibilityFilter() {
  return { $or: [
    { awaitingPayment: { $ne: true } },
    { paymentMethod: 'safepay', orderStatus: 'cancelled', awaitingPayment: true,
      'paymentResult.failureCode': 'SAFEPAY_SAFETY_REFUND_PENDING' },
  ] };
}

function buildSafetyRefundView(order, payment, events = []) {
  try {
    const amountMinor = getExpectedStripeTotalMinor(order);
    if (!isSafetyRefundCheckout(order) || !payment || payment.purpose !== 'order'
      || id(payment._id) !== id(order.safepayPaymentId) || id(payment.order) !== id(order._id)
      || id(payment.user) !== id(order.user) || payment.environment !== order.safepayEnvironment
      || payment.currency !== order.currency || !['USD', 'PKR', 'EUR', 'GBP'].includes(payment.currency)
      || !positiveMinor(amountMinor) || payment.amountMinor !== amountMinor
      || payment.capturedMinor !== amountMinor || payment.appliedAt || !validDate(payment.paidAt)
      || !validDate(payment.safetyRefund?.requestedAt)
      || !Number.isSafeInteger(payment.refundedMinor) || payment.refundedMinor < 0 || payment.refundedMinor > amountMinor) return unavailable();
    const proof = events.filter(event => id(event.payment) === id(payment._id));
    const sorted = [...proof].sort((a, b) => a.cumulativeMinor - b.cumulativeMinor);
    let cumulative = 0;
    for (const event of sorted) {
      if (event.currency !== payment.currency || event.environment !== payment.environment
        || !positiveMinor(event.deltaMinor) || !positiveMinor(event.cumulativeMinor)
        || event.cumulativeMinor !== cumulative + event.deltaMinor || !validDate(event.occurredAt)) return unavailable();
      cumulative = event.cumulativeMinor;
    }
    if (cumulative !== payment.refundedMinor) return unavailable();
    const refunded = payment.status === 'refunded' && payment.providerState === 'TRACKER_REFUNDED'
      && cumulative === amountMinor && payment.safetyRefund.outcome === 'confirmed';
    const pending = ['refund_pending', 'manual_review'].includes(payment.status) && cumulative < amountMinor;
    if (!refunded && !pending) return unavailable();
    return { available: true, status: refunded ? 'refunded' : payment.status,
      currency: payment.currency, capturedMinor: amountMinor, refundedMinor: cumulative,
      capturedAt: new Date(payment.paidAt).toISOString(),
      refundedAt: refunded ? new Date(sorted[sorted.length - 1].occurredAt).toISOString() : null,
      destination: 'original_card' };
  } catch (_) { return unavailable(); }
}

async function attachSafetyRefundViews(orders) {
  const candidates = orders.filter(isSafetyRefundCheckout);
  if (!candidates.length) return orders;
  const paymentIds = candidates.map(order => id(order.safepayPaymentId)).filter(value => /^[a-f0-9]{24}$/i.test(value));
  const payments = paymentIds.length ? await Payment.find({ _id: { $in: paymentIds } })
    .select('_id purpose user order environment currency amountMinor capturedMinor refundedMinor appliedAt paidAt status providerState safetyRefund.requestedAt safetyRefund.outcome').lean() : [];
  const events = paymentIds.length ? await RefundEvent.find({ payment: { $in: paymentIds } })
    .select('payment environment currency cumulativeMinor deltaMinor occurredAt').lean() : [];
  const byId = new Map(payments.map(payment => [id(payment._id), payment]));
  return orders.map(order => isSafetyRefundCheckout(order)
    ? { ...order, safepaySafetyRefund: buildSafetyRefundView(order, byId.get(id(order.safepayPaymentId)), events) }
    : order);
}

module.exports = { isSafetyRefundCheckout, buyerOrderVisibilityFilter, buildSafetyRefundView, attachSafetyRefundViews };
