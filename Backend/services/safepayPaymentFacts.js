'use strict';

// Only a freshly retrieved, identity-checked tracker is input to this module.
// A browser redirect, webhook type, authorization or failed card attempt is
// never sufficient to mark a purchase paid or to release a payable order.
const PENDING = new Set(['TRACKER_STARTED', 'TRACKER_ENROLLED', 'TRACKER_AUTHORIZED']);
const CLOSED = new Set(['TRACKER_CANCELLED', 'TRACKER_EXPIRED']);
const RISK = new Set(['TRACKER_DISPUTED', 'TRACKER_REVERSED', 'TRACKER_VOIDED', 'TRACKER_REFUNDED', 'TRACKER_PARTIAL_REFUND']);
const error = (message, code = 'SAFEPAY_PAYMENT_STATE_INVALID') => Object.assign(new Error(message), { code, statusCode: 409 });

function safepayPaymentFacts(tracker) {
  const state = tracker?.state;
  if (PENDING.has(state)) return { state, outcome: 'pending' };
  if (CLOSED.has(state)) return { state, outcome: 'closed' };
  if (RISK.has(state)) return { state, outcome: 'risk' };
  if (state === 'TRACKER_ENDED') return { state, outcome: 'paid' };
  throw error('The payment provider returned an unrecognized payment state.');
}

function assertSafepayOrderBinding(order, payment, expectedMinor) {
  if (!order || payment.purpose !== 'order' || order.paymentMethod !== 'safepay'
    || String(order._id) !== String(payment.order)
    || String(order.user || '') !== String(payment.user || '')
    || order.safepayEnvironment !== payment.environment
    || String(order.safepayPaymentId || '') !== String(payment._id)
    || order.currency !== payment.currency || expectedMinor !== payment.amountMinor
    || (order.safepayTrackerId && order.safepayTrackerId !== payment.tracker)) {
    throw error('The payment does not match its immutable order.', 'SAFEPAY_ORDER_BINDING_INVALID');
  }
}

module.exports = { safepayPaymentFacts, assertSafepayOrderBinding };
