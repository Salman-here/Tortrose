'use strict';
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Payment = require('../models/SafepayPayment');
const Order = require('../models/Order');
const { readSafepayConfig } = require('../config/safepay');
const { createSafepayClient } = require('./safepayClient');
const { paymentResponse } = require('./safepayPaymentService');
const fail = (message, code = 'SAFEPAY_PAYMENT_METHOD_CHANGE_PENDING', statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const pending = () => fail('Your previous payment is being verified. Check its status before changing payment methods.');

function createCheckoutSwitchService({ configFor = () => readSafepayConfig(process.env, { requireWebhook: true }),
  clientFor = config => createSafepayClient({ config }),
  reconcile = id => require('./safepayPaymentService').reconcilePayment(id),
  cancel = input => require('./orderCancellationService').cancelOrderSafely(input), now = () => new Date() } = {}) {
  return async function retireCheckout(paymentId, buyerId) {
    if (!mongoose.isValidObjectId(paymentId) || !mongoose.isValidObjectId(buyerId)) throw fail('Payment not found.', 'PAYMENT_NOT_FOUND', 404);
    const config = configFor();
    let payment = await Payment.findOne({ _id: paymentId, user: buyerId, environment: config.environment, purpose: 'order' }).select('+cardId');
    if (!payment) throw fail('Payment not found.', 'PAYMENT_NOT_FOUND', 404);
    payment = await reconcile(payment._id);
    if (payment.appliedAt || payment.capturedMinor > 0 || payment.riskPending || !['ready', 'cancelled', 'failed'].includes(payment.status)) {
      return { ...paymentResponse(payment), checkoutRetired: false };
    }
    const orderFilter = { _id: payment.order, user: buyerId, safepayPaymentId: payment._id, paymentMethod: 'safepay', isPaid: false };
    if (payment.localCancelledAt) {
      if (!await Order.exists({ ...orderFilter, orderStatus: 'cancelled' })) throw pending();
      return { ...paymentResponse(payment), checkoutRetired: true };
    }
    if (payment.terms?.settlementPolicy !== 'revalidate-on-payment-v1' || !payment.tracker) throw pending();
    const at = now(), token = crypto.randomUUID();
    // This is the same fence taken before saved-card approval. A stale secure
    // page cannot start bank verification after this purchase has been retired.
    const claimed = await Payment.findOneAndUpdate({ _id: payment._id, user: buyerId, environment: config.environment,
      status: 'ready', appliedAt: null, localCancelledAt: null, riskPending: false, capturedMinor: 0, refundedMinor: 0, walletRefundMinor: 0,
      'checkoutCard.approvalStartedAt': null, 'savedCardAuthentication.setupStartedAt': null,
      'savedCardAuthentication.encryptedContext': { $in: [null, ''] }, 'savedCardAuthentication.resetStartedAt': null,
      $or: [{ 'savedCardAuthentication.operationLeaseUntil': null }, { 'savedCardAuthentication.operationLeaseUntil': { $lte: at } }] },
    { $set: { 'savedCardAuthentication.operationToken': token, 'savedCardAuthentication.operationLeaseUntil': new Date(at.getTime() + 90000) } },
    { new: true }).select('+cardId');
    if (!claimed) throw pending();
    try {
      const tracker = await clientFor(config).getTracker(claimed.tracker, claimed);
      // A QR request, entered card/3DS approval or uncertain provider outcome is
      // not an idle checkout. Never create another payable purchase in its place.
      if (tracker.state !== 'TRACKER_STARTED' || tracker.charge || tracker.intent !== 'CYBERSOURCE'
        || !['GENERATE_CAPTURE_CONTEXT', 'PAYER_AUTH_SETUP'].includes(tracker.next_actions?.CYBERSOURCE?.kind)) throw pending();
      if (!await Order.exists(orderFilter)) throw pending();
      await cancel({ orderId: claimed.order, cancellationActorRole: 'buyer',
        reason: 'Buyer changed payment method before payment approval.', confirmationFields: { cancelledVia: 'dashboard' }, at });
      const retired = await Payment.findById(claimed._id);
      if (!retired.localCancelledAt || retired.appliedAt || retired.capturedMinor > 0 || !await Order.exists({ ...orderFilter, orderStatus: 'cancelled' })) throw pending();
      // Purchase retirement is not financial cancellation/refund proof. Keep
      // the original tracker for late reconciliation and existing refund safety.
      return { ...paymentResponse(retired), checkoutRetired: true };
    } finally {
      await Payment.updateOne({ _id: claimed._id, 'savedCardAuthentication.operationToken': token },
        { $set: { 'savedCardAuthentication.operationToken': '', 'savedCardAuthentication.operationLeaseUntil': null } });
    }
  };
}
module.exports = { createCheckoutSwitchService, retireCheckout: createCheckoutSwitchService() };
