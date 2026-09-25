'use strict';
const Subscription = require('../models/SellerSubscription');
const Operation = require('../models/SafepayBillingOperation');
const Payment = require('../models/SafepayPayment');
const Customer = require('../models/SafepayCustomer');
const billing = require('./safepayBillingService');
const payments = require('./safepayPaymentService');
const { readSafepayConfig } = require('../config/safepay');
const { claimSellerCheckout, releaseSellerCheckoutClaim } = require('./sellerCheckoutClaimService');
const { requireOwnedReusableCard } = require('./safepayCustomerService');
const { fail, id, date, transaction } = billing;

async function retryQuote(sellerId, body) {
  const config = readSafepayConfig(process.env, { requireWebhook: true });
  if (typeof body.requestKey !== 'string' || !/^[A-Za-z0-9:_-]{8,160}$/.test(body.requestKey)) {
    throw fail('A valid billing attempt key is required.', 'INVALID_IDEMPOTENCY_KEY', 400);
  }
  const fingerprint = payments.fingerprint({ seller: id(sellerId), failedOperation: String(body.failedOperation || ''), kind: 'renewal_retry' });
  const existing = await Operation.findOne({ seller: sellerId, environment: config.environment, requestKey: body.requestKey });
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw fail('This retry has different terms.', 'IDEMPOTENCY_CONFLICT');
    return billing.presentQuote(existing);
  }
  const sub = await billing.sellerSubscription(sellerId);
  if (sub.billingProvider !== 'safepay' || sub.safepayBilling.environment !== config.environment
    || !sub.safepayBilling.autoRenew || sub.safepayBilling.pendingOperation
    || !sub.safepayBilling.lastFailedOperation || id(sub.safepayBilling.lastFailedOperation) !== String(body.failedOperation)
    || sub.cancelledAt && !sub.pendingDowngrade?.toPlan) throw fail('This subscription has no retryable renewal.', 'SUBSCRIPTION_RETRY_UNAVAILABLE');
  const previous = await Operation.findOne({ _id: sub.safepayBilling.lastFailedOperation, subscription: sub._id,
    environment: config.environment, status: 'failed', kind: { $in: ['renewal', 'downgrade'] } });
  const failedPayment = previous?.payment && await Payment.findById(previous.payment);
  if (!previous || failedPayment?.status !== 'failed' || failedPayment.chargeOutcome !== 'declined'
    || failedPayment.appliedAt || previous.terms.sourceContractId !== sub.safepayBilling.contractId
    || previous.terms.cycle !== sub.safepayBilling.cycle) {
    throw fail('The earlier payment must be definitively declined before retrying.', 'SUBSCRIPTION_RETRY_UNAVAILABLE');
  }
  if (date(previous.terms.periodEnd) <= new Date()) {
    throw fail('That billing period has ended. Cancel the expired agreement and choose a new plan instead of paying for an old period.', 'SUBSCRIPTION_MISSED_PERIOD_REVIEW');
  }
  const claim = await claimSellerCheckout({ sellerId, flow: 'subscription', provider: 'safepay', requestFingerprint: fingerprint });
  if (!claim.acquired) throw fail('A billing quote is already being prepared.', 'CHECKOUT_PENDING');
  try {
    const op = await Operation.create({ seller: sellerId, subscription: sub._id, environment: config.environment,
      requestKey: body.requestKey, fingerprint, sourceVersion: sub.safepayBilling.version, kind: previous.kind,
      expiresAt: new Date(Math.min(date(claim.claim.expiresAt).getTime(), date(previous.terms.periodEnd).getTime())),
      terms: { ...previous.terms, trialDays: 0, retryOf: id(previous), checkoutClaimToken: claim.claim.token } });
    return billing.presentQuote(op);
  } catch (error) {
    await releaseSellerCheckoutClaim({ sellerId, flow: 'subscription', token: claim.claim.token });
    throw error;
  }
}

async function changeCard(sellerId, body) {
  if (body.consentAccepted !== true || body.consentVersion !== billing.CONSENT_VERSION) {
    throw fail('Authorize the selected card for your existing recurring agreement.', 'SUBSCRIPTION_CONSENT_REQUIRED', 400);
  }
  await billing.sellerSubscription(sellerId);
  const { link, card, config } = await requireOwnedReusableCard(sellerId, body.cardId);
  return transaction(async session => {
    const sub = await Subscription.findOne({ seller: sellerId, billingProvider: 'safepay',
      'safepayBilling.environment': config.environment }).select('+safepayBilling.cardId').session(session);
    if (!sub || sub.paymentRisk?.suspended || sub.safepayBilling.pendingOperation
      || !sub.safepayBilling.autoRenew || sub.safepayBilling.version !== body.billingVersion) {
      throw fail('Billing details changed or a payment is still in progress. Refresh before changing the card.', 'SUBSCRIPTION_QUOTE_STALE');
    }
    const owner = await Customer.updateOne({ _id: link._id, customerId: sub.safepayBilling.customerId,
      status: 'ready', deletingCardId: { $ne: card.token } }, { $inc: { __v: 1 } }, { session });
    if (!owner.matchedCount) throw fail('This card is being removed or its owner changed.', 'CARD_REMOVAL_PENDING');
    sub.safepayBilling.cardId = card.token;
    sub.safepayBilling.consentedAt = new Date();
    sub.safepayBilling.consentVersion = billing.CONSENT_VERSION;
    sub.safepayBilling.version += 1;
    await sub.save({ session });
    return { success: true, msg: 'The card for future subscription payments was updated. No payment was collected.' };
  });
}
module.exports = { retryQuote, changeCard };
