'use strict';
const mongoose = require('mongoose');
const Subscription = require('../models/SellerSubscription');
const Payment = require('../models/SafepayPayment');
const Operation = require('../models/SafepayBillingOperation');
const Customer = require('../models/SafepayCustomer');

// A merchant-managed recurring agreement has no remote scheduler to cancel.
// Stop our scheduler before deleting its owner; retain financial history and
// refuse deletion while a payment/refund may still be moving money.
async function stopAccountBilling(userId) {
  const pending = await Payment.exists({ user: userId, purpose: { $ne: 'card_setup' },
    status: { $in: ['creating', 'ready', 'cancel_requested', 'refund_pending', 'manual_review'] } });
  if (pending) throw Object.assign(new Error('A Safepay payment or refund is still being reconciled. Resolve it before deleting this account.'), {
    statusCode: 409, code: 'SAFEPAY_ACCOUNT_PAYMENT_PENDING',
  });
  const hasResources = await Customer.exists({ user: userId });
  const hasBilling = await Subscription.exists({ seller: userId, billingProvider: 'safepay' });
  if (!hasResources && !hasBilling) return;
  await mongoose.connection.transaction(async session => {
    const subscription = await Subscription.findOne({ seller: userId, billingProvider: 'safepay' }).session(session);
    if (subscription) {
      subscription.safepayBilling.autoRenew = false;
      subscription.safepayBilling.nextChargeAt = null;
      subscription.cancelledAt = subscription.cancelledAt || new Date();
      subscription.safepayBilling.version += 1;
      await subscription.save({ session });
    }
    const inflight = await Payment.exists({ user: userId, purpose: { $ne: 'card_setup' },
      status: { $in: ['creating', 'ready', 'cancel_requested', 'refund_pending', 'manual_review'] } }).session(session);
    if (inflight) throw Object.assign(new Error('Billing began while account deletion was being prepared. Check the payment before retrying.'), { code: 'SAFEPAY_ACCOUNT_PAYMENT_PENDING' });
    await Operation.updateMany({ seller: userId, status: { $in: ['quoted', 'accepted'] } }, { $set: { status: 'cancelled' } }, { session });
    await Customer.updateMany({ user: userId }, { $set: { status: 'deleted', defaultCardId: null } }, { session });
  });
}
module.exports = { stopAccountBilling };
