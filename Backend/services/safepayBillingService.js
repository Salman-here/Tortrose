'use strict';
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Subscription = require('../models/SellerSubscription');
const Operation = require('../models/SafepayBillingOperation');
const Payment = require('../models/SafepayPayment');
const Customer = require('../models/SafepayCustomer');
const Promotion = require('../models/SubscriptionPromotion');
const CheckoutClaim = require('../models/SellerCheckoutClaim');
const Store = require('../models/Store');
const User = require('../models/User');
const { readSafepayConfig } = require('../config/safepay');
const { buildPlanPricing } = require('./subscriptionPricingService');
const { monthlyBoundary, proratedPlanChange, applyBillingCredit, renewalPeriod } = require('./safepayBillingMath');
const { requireOwnedReusableCard } = require('./safepayCustomerService');
const payments = require('./safepayPaymentService');
const { FOUNDER_PROMOTION, reserveFounderSlot } = require('./founderPromotionService');
const { claimSellerCheckout, releaseSellerCheckoutClaim } = require('./sellerCheckoutClaimService');
const { enqueueNotificationEvent } = require('./notificationOutboxService');
const { snapshotMinorMoney } = require('./notificationMoneySnapshotService');

const CONSENT_VERSION = 'rozare-safepay-recurring-v1';
const id = value => String(value?._id || value || '');
const fail = (message, code, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const minor = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw fail('Stored subscription money is invalid.', 'SUBSCRIPTION_BILLING_TERMS_INVALID');
  return value;
};
const date = value => {
  const result = value instanceof Date ? value : new Date(value);
  if (!value || !Number.isFinite(result.getTime())) throw fail('Stored subscription dates are invalid.', 'SUBSCRIPTION_BILLING_TERMS_INVALID');
  return result;
};
const transaction = async work => {
  let result;
  await mongoose.connection.transaction(async session => { result = await work(session); }, {
    readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' },
  });
  return result;
};
const key = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{8,160}$/.test(value)) throw fail('A valid billing attempt key is required.', 'INVALID_IDEMPOTENCY_KEY', 400);
  return value;
};

async function sellerSubscription(sellerId) {
  const user = await User.findOne({ _id: sellerId, role: 'seller', status: 'active' }).select('_id').lean();
  if (!user) throw fail('An active seller account is required.', 'SELLER_REQUIRED', 403);
  let sub = await Subscription.findOne({ seller: sellerId }).select('+safepayBilling.cardId');
  if (!sub) sub = await require('../controllers/subscriptionController').initializeSubscription(sellerId);
  if (sub.paymentRisk?.suspended) throw fail('Billing changes are on hold while a payment is reviewed.', 'SUBSCRIPTION_PAYMENT_RISK_OPEN', 423);
  return sub;
}

function presentQuote(operation) {
  const t = operation.terms;
  return { quoteId: id(operation), kind: operation.kind, status: operation.status, expiresAt: operation.expiresAt,
    plan: t.plan, planName: t.planName, includeMetaAds: t.includeMetaAds, currency: 'USD',
    monthlyAmountMinor: t.monthlyMinor, dueNowMinor: t.dueMinor, creditMinor: t.creditMinor || 0,
    freePeriodDays: t.trialDays || 0, founderRate: t.founderRate === true,
    consentVersion: CONSENT_VERSION, requiresSafepayAccount: false,
    terms: `Authorize Rozare to charge ${t.monthlyMinor / 100} USD each month using your selected Safepay-saved card${t.trialDays ? ` after ${t.trialDays} free days` : ''}. Cancel renewal in your subscription settings before the next billing date.` };
}

async function createQuote(sellerId, body) {
  const config = readSafepayConfig(process.env, { requireWebhook: true });
  const requestKey = key(body.requestKey);
  const kind = body.kind || 'enrollment';
  if (!['enrollment', 'upgrade'].includes(kind)) throw fail('Choose a valid billing operation.', 'INVALID_BILLING_OPERATION', 400);
  const plan = kind === 'upgrade' ? 'elite' : body.plan;
  if (!['starter', 'elite'].includes(plan) || (body.includeMetaAds !== undefined && typeof body.includeMetaAds !== 'boolean')) {
    throw fail('Choose a valid plan and add-on selection.', 'INVALID_SUBSCRIPTION_PLAN', 400);
  }
  const includeMetaAds = body.includeMetaAds === true;
  if (includeMetaAds && plan !== 'elite') throw fail('Meta Ads are available only with Elite.', 'INVALID_META_ADS_SELECTION', 400);
  const coupon = String(body.couponCode || '').trim().toUpperCase();
  if (coupon && coupon !== FOUNDER_PROMOTION.code) throw fail('This subscription coupon is not valid.', 'INVALID_SUBSCRIPTION_COUPON', 400);
  const requestFingerprint = payments.fingerprint({ seller: id(sellerId), provider: 'safepay', kind, plan, includeMetaAds, coupon });
  await Promise.all([Operation.init(), Payment.init()]);
  const existing = await Operation.findOne({ seller: sellerId, environment: config.environment, requestKey });
  if (existing) {
    if (existing.fingerprint !== requestFingerprint) throw fail('This billing attempt has different terms.', 'IDEMPOTENCY_CONFLICT');
    return presentQuote(existing);
  }
  const sub = await sellerSubscription(sellerId);
  const store = await Store.findOne({ seller: sellerId }).select('isActive blockedAt moderationStatus').lean();
  if (!store || (store.moderationStatus && store.moderationStatus !== 'approved')
    || (!store.isActive && !sub.blockedAt)) throw fail('Resolve the store restriction before starting a new billing agreement.', 'STORE_BILLING_RESTRICTED', 423);
  if (sub.safepayBilling?.pendingOperation) throw fail('Finish or resolve the current billing operation first.', 'SUBSCRIPTION_BILLING_PENDING');
  if (kind === 'enrollment' && (['active', 'free_period'].includes(sub.status) || sub.safepayBilling?.autoRenew)) {
    throw fail('Manage or resume your existing subscription instead of creating a second one.', 'SUBSCRIPTION_ALREADY_ACTIVE');
  }
  if (kind === 'enrollment' && (sub.stripeSubscriptionId || sub.stripeCustomerId)) {
    const { stripe } = require('../config/stripe');
    if (!stripe) throw fail('The previous billing provider must be checked before switching.', 'LEGACY_BILLING_REVIEW_REQUIRED', 503);
    const legacy = sub.stripeSubscriptionId ? await stripe.subscriptions.retrieve(sub.stripeSubscriptionId) : null;
    if (legacy && !['canceled', 'incomplete_expired'].includes(legacy.status)) {
      throw fail('Your existing Stripe subscription must finish before switching to Safepay. Manage it on the website to avoid duplicate billing.', 'LEGACY_BILLING_STILL_ACTIVE');
    }
    if (sub.stripeCustomerId) {
      const checkouts = await stripe.checkout.sessions.list({ customer: sub.stripeCustomerId, limit: 100 });
      if (!Array.isArray(checkouts?.data) || checkouts.has_more) throw fail('Previous checkout history requires reconciliation before switching providers.', 'LEGACY_BILLING_REVIEW_REQUIRED', 503);
      if (checkouts.data.some(row => row.mode === 'subscription' && (row.status === 'open'
        || (row.status === 'complete' && row.subscription && row.subscription !== sub.stripeSubscriptionId)))) {
        throw fail('A previous Stripe subscription checkout must be resolved before starting Safepay billing.', 'LEGACY_BILLING_STILL_ACTIVE');
      }
    }
  }
  if (kind === 'upgrade' && (sub.billingProvider !== 'safepay' || sub.safepayBilling?.environment !== config.environment
      || !['active', 'free_period'].includes(sub.status) || sub.cancelledAt || sub.pendingDowngrade?.toPlan)) {
    throw fail('This subscription cannot change plans right now.', 'PLAN_CHANGE_BLOCKED');
  }
  if (kind === 'upgrade' && sub.plan === 'elite' && Boolean(sub.metaAdsIncluded) === includeMetaAds) {
    throw fail('This plan is already selected.', 'PLAN_ALREADY_SELECTED');
  }
  const isRemoval = kind === 'upgrade' && sub.plan === 'elite' && sub.metaAdsIncluded && !includeMetaAds;
  if (kind === 'upgrade' && sub.status === 'free_period' && !isRemoval) {
    throw fail('Paid Elite or Meta Ads access can be added after the introductory free period ends.', 'PLAN_CHANGE_PAYMENT_REQUIRED');
  }
  if (kind === 'enrollment' && coupon && (sub.founderOffer?.claimedAt || sub.founderOffer?.forfeitedAt)) {
    throw fail('This seller has already used the founder coupon.', 'FOUNDER_COUPON_ALREADY_USED', 400);
  }
  const claim = await claimSellerCheckout({ sellerId, flow: 'subscription', provider: 'safepay', requestFingerprint });
  if (!claim.acquired) throw fail('A subscription checkout is already being prepared. Retry the same attempt shortly.', 'CHECKOUT_PENDING');
  let reservation;
  const operationId = new mongoose.Types.ObjectId();
  try {
    if (kind === 'enrollment' && coupon) reservation = await reserveFounderSlot(sellerId);
    const founderRate = kind === 'enrollment' ? Boolean(reservation) : sub.founderOffer?.active === true;
    const price = buildPlanPricing(plan, includeMetaAds, founderRate);
    const trialDays = kind === 'enrollment' && !sub.hasUsedFreePeriod ? price.freePeriodDays : 0;
    const at = new Date();
    const proration = kind === 'upgrade' && sub.status !== 'free_period'
      ? proratedPlanChange({ sourceMinor: sub.safepayBilling.monthlyMinor, targetMinor: price.unitAmount,
        periodStart: sub.currentPeriodStart, periodEnd: sub.currentPeriodEnd, at }) : null;
    const gross = kind === 'enrollment' ? (trialDays ? 0 : price.unitAmount) : proration?.dueMinor || 0;
    const credit = applyBillingCredit(gross, minor(sub.safepayBilling?.creditMinor || 0));
    const [operation] = await Operation.create([{ _id: operationId, seller: sellerId, subscription: sub._id,
      environment: config.environment, requestKey, fingerprint: requestFingerprint, sourceVersion: sub.safepayBilling?.version || 0,
      kind: isRemoval ? 'meta_removal' : kind, expiresAt: claim.claim.expiresAt,
      terms: { plan, planName: price.planName, includeMetaAds, monthlyMinor: price.unitAmount, currency: 'USD', trialDays,
        founderRate, founderReservationToken: reservation?.token || '', checkoutClaimToken: claim.claim.token,
        sourceContractId: sub.safepayBilling?.contractId || '', sourceMonthlyMinor: sub.safepayBilling?.monthlyMinor || 0,
        sourcePlan: sub.plan, sourceMetaAds: sub.metaAdsIncluded, grossMinor: gross, dueMinor: credit.chargeMinor,
        appliedCreditMinor: credit.appliedCreditMinor, remainingCreditMinor: credit.remainingCreditMinor,
        creditMinor: proration?.creditMinor || 0, proration } }]);
    if (reservation) await Promotion.updateOne({ code: FOUNDER_PROMOTION.code, 'reservations.token': reservation.token },
      { $set: { 'reservations.$.provider': 'safepay', 'reservations.$.safepayOperationId': operation._id } }, { runValidators: true });
    return presentQuote(operation);
  } catch (error) {
    await releaseSellerCheckoutClaim({ sellerId, flow: 'subscription', token: claim.claim.token });
    if (reservation) await require('./founderPromotionService').releaseFounderReservation({ sellerId, token: reservation.token });
    throw error;
  }
}

async function claimFounder(operation, session) {
  const token = operation.terms.founderReservationToken;
  if (!token) return null;
  const promotion = await Promotion.findOne({ code: FOUNDER_PROMOTION.code }).session(session);
  const previous = promotion?.claims?.find(row => id(row.seller) === id(operation.seller));
  if (previous) {
    if (previous.provider === 'safepay' && id(previous.safepayOperationId) === id(operation)) return previous.claimedAt;
    throw fail('This founder offer was already claimed by another subscription.', 'FOUNDER_COUPON_ALREADY_USED');
  }
  const at = new Date();
  const updated = await Promotion.findOneAndUpdate({ code: FOUNDER_PROMOTION.code,
    reservations: { $elemMatch: { seller: operation.seller, token, safepayOperationId: operation._id, expiresAt: { $gt: at } } },
    'claims.seller': { $ne: operation.seller } }, { $pull: { reservations: { seller: operation.seller, token } },
    $push: { claims: { seller: operation.seller, claimedAt: at, source: 'coupon', provider: 'safepay', safepayOperationId: operation._id, checkoutSessionId: null } } },
  { session, new: true, runValidators: true });
  if (!updated) throw fail('The founder reservation expired. Review a new quote before paying.', 'FOUNDER_RESERVATION_INVALID');
  return at;
}

async function notifyOperation(operation, { session, type = 'subscription.payment_received', title = 'Subscription updated', body } = {}) {
  const amountMinor = minor(operation.terms.dueMinor);
  return enqueueNotificationEvent({ eventKey: `safepay-billing:${operation._id}:${type}:v1`, eventType: type,
    aggregateType: 'SafepayBillingOperation', aggregateId: operation._id, occurredAt: operation.appliedAt || operation.acceptedAt,
    financial: true, recipient: { kind: 'user', audienceRole: 'seller', user: operation.seller, destinationPolicy: 'current_user', allowBlocked: true },
    channels: ['inapp', 'push', 'email', 'whatsapp'],
    templates: { inapp: { title, body }, push: { title, body }, email: { subject: title, text: body }, whatsapp: { message: `${title}\n\n${body}` } },
    money: [snapshotMinorMoney({ key: 'charged', amountMinor, currency: 'USD', sourceModel: 'SafepayBillingOperation', sourceDocumentId: operation._id, sourcePath: 'terms.dueMinor', label: 'Subscription charge' })],
    metadata: { category: 'subscription', channelId: 'seller', whatsappCategory: 'subscriptionAlerts',
      linkTo: '/seller-dashboard/subscription', data: { type: 'subscription_updated', operationId: id(operation) } }, session });
}

async function applyOperation(operation, sub, session) {
  if (operation.status === 'applied') return sub;
  if (id(sub.safepayBilling?.pendingOperation) !== id(operation)) throw fail('The billing operation was superseded.', 'SUBSCRIPTION_OPERATION_SUPERSEDED');
  const terms = operation.terms, at = date(operation.acceptedAt);
  const previousBlockedAt = sub.blockedAt || null;
  const enrollment = operation.kind === 'enrollment';
  if (enrollment) {
    const founderAt = await claimFounder(operation, session);
    sub.subscribedAt = at;
    sub.hasUsedFreePeriod = sub.hasUsedFreePeriod || terms.trialDays > 0;
    sub.freePeriodEndDate = terms.trialDays ? new Date(at.getTime() + terms.trialDays * 86400000) : null;
    sub.currentPeriodStart = at;
    sub.currentPeriodEnd = sub.freePeriodEndDate || monthlyBoundary(at, 1);
    sub.safepayBilling.anchorAt = sub.freePeriodEndDate || at;
    sub.safepayBilling.cycle = terms.trialDays ? 0 : 1;
    sub.safepayBilling.contractId = id(operation);
    sub.status = terms.trialDays ? 'free_period' : 'active';
    sub.safepayBilling.endedAt = null;
    if (founderAt) sub.founderOffer = { active: true, code: FOUNDER_PROMOTION.code, discountPercent: FOUNDER_PROMOTION.discountPercent, claimedAt: founderAt, forfeitedAt: null, source: 'coupon' };
  } else if (operation.kind === 'renewal' || operation.kind === 'downgrade') {
    sub.currentPeriodStart = date(terms.periodStart);
    sub.currentPeriodEnd = date(terms.periodEnd);
    sub.safepayBilling.cycle = terms.cycle + 1;
    sub.status = 'active';
    if (operation.kind === 'downgrade') {
      sub.pendingDowngrade = { toPlan: null };
      if (sub.safepayBilling.autoRenew) sub.cancelledAt = null;
    }
  }
  sub.plan = terms.plan; sub.planName = terms.planName; sub.metaAdsIncluded = terms.includeMetaAds;
  sub.safepayBilling.monthlyMinor = minor(terms.monthlyMinor);
  sub.safepayBilling.creditMinor = minor(terms.remainingCreditMinor || 0) + minor(terms.creditMinor || 0);
  if (!Number.isSafeInteger(sub.safepayBilling.creditMinor)) throw fail('Subscription credit exceeds its safe range.', 'SUBSCRIPTION_BILLING_TERMS_INVALID');
  sub.safepayBilling.pendingOperation = null;
  sub.safepayBilling.lastFailedOperation = null;
  sub.safepayBilling.version += 1;
  sub.safepayBilling.lastFailureCode = '';
  sub.safepayBilling.nextChargeAt = sub.safepayBilling.autoRenew ? sub.currentPeriodEnd : null;
  sub.warningEmailSent = false; sub.blockedAt = null; sub.blockedReason = ''; sub.aiMessageLimit = -1;
  sub.trialBlockedNotificationEventAt = null; sub.trialBlockedNotificationEnqueuedAt = null;
  if (terms.plan === 'elite') {
    sub.bonusFeaturesActive = true; sub.bonusExpiryDate = null; sub.bonusFeaturesExpiredPermanently = false; sub.bonusGraceDeadline = null;
  } else if (enrollment || operation.kind === 'downgrade') {
    const grace = sub.bonusGraceDeadline && date(sub.bonusGraceDeadline) >= at && sub.bonusExpiryDate && date(sub.bonusExpiryDate) > at;
    if (grace && !sub.bonusFeaturesExpiredPermanently) { sub.bonusFeaturesActive = true; sub.bonusGraceDeadline = null; }
    else if (!sub.starterBonusPeriodUsed && !sub.bonusFeaturesExpiredPermanently) {
      sub.bonusFeaturesActive = true; sub.starterBonusPeriodUsed = true; sub.bonusExpiryDate = monthlyBoundary(at, 6); sub.bonusGraceDeadline = null;
    } else { sub.bonusFeaturesActive = false; sub.bonusFeaturesExpiredPermanently = true; }
  }
  operation.status = 'applied'; operation.appliedAt = new Date();
  await sub.save({ session }); await operation.save({ session });
  // Admin-blocked users and unrelated payment-risk locks remain untouched.
  const user = await User.findById(sub.seller).select('status role').session(session);
  if (user?.status === 'active' && user.role === 'seller') await Store.updateOne({ seller: sub.seller,
    'subscriptionPaymentRiskLock.stripeSubscriptionId': { $in: ['', null] },
    $or: [{ isActive: true }, ...(previousBlockedAt ? [{ blockedAt: previousBlockedAt }] : [])] },
  { $set: { isActive: true, blockedAt: null, 'subdomainPurchase.removalScheduledAt': null } }, { session });
  await notifyOperation(operation, { session, title: terms.trialDays ? 'Subscription trial started' : 'Subscription updated',
    body: `${terms.planName} is now ${sub.status === 'free_period' ? 'in its introductory free period' : 'active'}. Charged: {{money.charged}}. Review your next billing date and renewal settings in Rozare.` });
  return sub;
}

async function acceptQuote(sellerId, body) {
  if (body.consentAccepted !== true || body.consentVersion !== CONSENT_VERSION) throw fail('Review and accept the recurring billing terms first.', 'SUBSCRIPTION_CONSENT_REQUIRED', 400);
  if (!mongoose.isValidObjectId(body.quoteId)) throw fail('Quote not found.', 'SUBSCRIPTION_QUOTE_NOT_FOUND', 404);
  await sellerSubscription(sellerId);
  const { link, card, config } = await requireOwnedReusableCard(sellerId, body.cardId);
  const result = await transaction(async session => {
    const op = await Operation.findOne({ _id: body.quoteId, seller: sellerId, environment: config.environment }).select('+cardId').session(session);
    if (!op) throw fail('Quote not found.', 'SUBSCRIPTION_QUOTE_NOT_FOUND', 404);
    if (['accepted', 'awaiting_payment', 'applied'].includes(op.status)) {
      if (op.cardId !== card.token) throw fail('This billing operation was already authorized with a different card.', 'IDEMPOTENCY_CONFLICT');
      return op;
    }
    if (op.status !== 'quoted' || date(op.expiresAt) <= new Date()) throw fail('This quote expired. Please review a fresh quote.', 'SUBSCRIPTION_QUOTE_EXPIRED');
    if (op.terms.proration?.periodEnd && date(op.terms.proration.periodEnd) <= new Date()) throw fail('The quoted billing period ended. Review a new quote.', 'SUBSCRIPTION_QUOTE_STALE');
    const sub = await Subscription.findById(op.subscription).select('+safepayBilling.cardId').session(session);
    if (!sub || sub.paymentRisk?.suspended || (sub.safepayBilling?.version || 0) !== op.sourceVersion || sub.safepayBilling?.pendingOperation) {
      throw fail('Subscription details changed. Review a fresh quote.', 'SUBSCRIPTION_QUOTE_STALE');
    }
    if (op.terms.retryOf && (id(sub.safepayBilling.lastFailedOperation) !== op.terms.retryOf
      || !sub.safepayBilling.autoRenew || sub.cancelledAt && !sub.pendingDowngrade?.toPlan)) {
      throw fail('This renewal is no longer authorized. Review the current subscription.', 'SUBSCRIPTION_QUOTE_STALE');
    }
    const claim = await CheckoutClaim.findOne({ seller: sellerId, flow: 'subscription', provider: 'safepay',
      token: op.terms.checkoutClaimToken, expiresAt: { $gt: new Date() } }).session(session);
    if (!claim) throw fail('This checkout is no longer active.', 'SUBSCRIPTION_QUOTE_EXPIRED');
    // Touch the owned customer in this transaction to fence card removal.
    const owner = await Customer.findOneAndUpdate({ _id: link._id, customerId: link.customerId, status: 'ready', deletingCardId: { $ne: card.token } }, { $inc: { __v: 1 } }, { session });
    if (!owner) throw fail('Your payment profile changed.', 'SAFEPAY_CUSTOMER_MISMATCH');
    op.acceptedAt = new Date(); op.consentVersion = CONSENT_VERSION; op.cardId = card.token; op.status = 'accepted';
    sub.billingProvider = 'safepay'; sub.safepayBilling.environment = config.environment;
    sub.safepayBilling.customerId = link.customerId; sub.safepayBilling.cardId = card.token;
    sub.safepayBilling.pendingOperation = op._id; sub.safepayBilling.consentedAt = op.acceptedAt;
    sub.safepayBilling.consentVersion = CONSENT_VERSION;
    if (op.kind === 'enrollment') {
      sub.cancelledAt = null; sub.safepayBilling.autoRenew = true;
      sub.safepayBilling.contractId = id(op); sub.safepayBilling.monthlyMinor = minor(op.terms.monthlyMinor);
      sub.safepayBilling.endedAt = null;
      // Preserve historic Stripe invoice records but detach the closed live
      // projection, so delayed old-provider events cannot replace this plan.
      sub.stripeSubscriptionId = undefined; sub.stripePriceId = undefined; sub.stripeProductId = undefined;
    }
    if (op.terms.founderReservationToken) await Promotion.updateOne({ code: FOUNDER_PROMOTION.code,
      'reservations.token': op.terms.founderReservationToken }, { $set: {
      'reservations.$.expiresAt': new Date(Date.now() + 7 * 86400000) } }, { session, runValidators: true });
    if (op.terms.dueMinor > 0) {
      const payment = await payments.ensurePayment({ user: sellerId, purpose: 'subscription',
        reference: `billing:${op._id}`, requestKey: `billing:${op._id}`, amountMinor: minor(op.terms.dueMinor), currency: 'USD',
        customerId: link.customerId, cardId: card.token, terms: { billingOperationId: id(op), subscriptionId: id(sub), contractId: op.terms.sourceContractId } }, { session });
      op.payment = payment._id; op.status = 'awaiting_payment';
      await sub.save({ session }); await op.save({ session });
    } else { await sub.save({ session }); await applyOperation(op, sub, session); }
    await CheckoutClaim.deleteOne({ _id: claim._id, token: claim.token }).session(session);
    return op;
  });
  if (result.payment && result.status !== 'applied') await payments.submitRecurringPayment(result.payment);
  return operationStatus(sellerId, result._id);
}

async function claimRecurringCharge(paymentId) {
  return transaction(async session => {
    const payment = await Payment.findById(paymentId).select('+cardId').session(session);
    if (!payment || payment.purpose !== 'subscription' || payment.status !== 'ready' || payment.chargeStartedAt || payment.appliedAt) return null;
    const op = await Operation.findOne({ _id: payment.terms.billingOperationId, payment: payment._id,
      seller: payment.user, environment: payment.environment, status: 'awaiting_payment' }).session(session);
    const sub = op && await Subscription.findById(op.subscription).select('+safepayBilling.cardId').session(session);
    if (!op || !sub || id(sub.safepayBilling.pendingOperation) !== id(op) || sub.paymentRisk?.suspended
      || op.consentVersion !== CONSENT_VERSION || !op.acceptedAt || minor(op.terms.dueMinor) !== payment.amountMinor
      || payment.currency !== 'USD' || sub.safepayBilling.customerId !== payment.customerId) {
      throw fail('The recurring charge has no matching billing authorization.', 'SAFEPAY_RECURRING_BINDING_INVALID');
    }
    if (['renewal', 'downgrade'].includes(op.kind) && !sub.safepayBilling.autoRenew) return null;
    const fundedEnd = op.kind === 'enrollment' ? monthlyBoundary(op.acceptedAt, 1)
      : op.terms.periodEnd || op.terms.proration?.periodEnd;
    if (fundedEnd && date(fundedEnd) <= new Date()) throw fail('The agreed billing period ended before collection. Review is required before a new charge.', 'SUBSCRIPTION_MISSED_PERIOD_REVIEW');
    const user = await User.findOneAndUpdate({ _id: payment.user, status: 'active' }, { $inc: { __v: 1 } }, { new: true, session });
    if (!user) throw fail('Automatic billing is on hold for this account.', 'SUBSCRIPTION_ACCOUNT_HELD', 423);
    const owner = await Customer.updateOne({ user: payment.user, environment: payment.environment, customerId: payment.customerId, status: 'ready', deletingCardId: { $ne: payment.cardId } }, { $inc: { __v: 1 } }, { session });
    if (!owner.matchedCount) throw fail('This payment card is being removed or its owner changed.', 'CARD_REMOVAL_PENDING');
    payment.chargeStartedAt = new Date(); payment.chargeOutcome = 'pending'; await payment.save({ session });
    // Saving the subscription creates a write conflict with a concurrent
    // cancellation, which uses this same aggregate as its ordering boundary.
    sub.safepayBilling.lastFailureCode = '';
    sub.markModified('safepayBilling');
    await sub.save({ session });
    return payment;
  });
}

async function settleBillingPayment(payment, tracker, session) {
  const op = await Operation.findOne({ _id: payment.terms.billingOperationId, payment: payment._id,
    seller: payment.user, environment: payment.environment }).session(session);
  const sub = op && await Subscription.findById(op.subscription).select('+safepayBilling.cardId').session(session);
  if (!op || !sub || op.terms.dueMinor !== payment.amountMinor || payment.currency !== 'USD') {
    throw fail('Captured subscription payment does not match its invoice.', 'SAFEPAY_RECURRING_BINDING_INVALID');
  }
  return applyOperation(op, sub, session);
}

async function operationStatus(sellerId, operationId) {
  const op = await Operation.findOne({ _id: operationId, seller: sellerId });
  if (!op) throw fail('Billing operation not found.', 'SUBSCRIPTION_QUOTE_NOT_FOUND', 404);
  return { ...presentQuote(op), completed: op.status === 'applied', paymentId: op.payment || null,
    msg: op.status === 'applied' ? 'Your subscription was updated.' : 'Your exact billing operation is being verified.' };
}

async function holdBillingPayment(payment, tracker, session) {
  const op = await Operation.findOne({ _id: payment.terms.billingOperationId, payment: payment._id,
    seller: payment.user, environment: payment.environment }).session(session);
  if (!op) throw fail('The reversed payment has no owned billing operation.', 'SAFEPAY_RECURRING_BINDING_INVALID');
  const contractId = op.kind === 'enrollment' ? id(op) : op.terms.sourceContractId;
  const sub = await Subscription.findOne({ _id: op.subscription, billingProvider: 'safepay',
    'safepayBilling.environment': payment.environment, 'safepayBilling.contractId': contractId }).session(session);
  if (!sub) return;
  sub.paymentRisk.suspended = true;
  sub.paymentRisk.reason = 'Safepay reported a refund, reversal or dispute requiring billing reconciliation.';
  sub.paymentRisk.updatedAt = new Date();
  sub.safepayBilling.autoRenew = false; sub.safepayBilling.nextChargeAt = null;
  sub.safepayBilling.lastFailureCode = tracker.state;
  sub.status = 'past_due'; sub.blockedAt = sub.blockedAt || new Date();
  await sub.save({ session });
  await Store.updateOne({ seller: sub.seller, isActive: true }, { $set: { isActive: false, blockedAt: sub.blockedAt } }, { session });
}

async function failBillingPayment(payment, session) {
  const op = await Operation.findOne({ _id: payment.terms.billingOperationId, payment: payment._id,
    seller: payment.user, environment: payment.environment }).session(session);
  if (!op || op.status === 'applied') throw fail('The declined payment conflicts with its invoice.', 'SAFEPAY_RECURRING_BINDING_INVALID');
  if (op.status === 'failed') return;
  const sub = await Subscription.findById(op.subscription).session(session);
  op.status = 'failed'; op.failureCode = 'SAFEPAY_RECURRING_PAYMENT_DECLINED';
  await op.save({ session });
  if (sub && id(sub.safepayBilling.pendingOperation) === id(op)) {
    sub.safepayBilling.pendingOperation = null;
    sub.safepayBilling.lastFailedOperation = op._id;
    sub.safepayBilling.lastFailureCode = op.failureCode;
    sub.safepayBilling.version += 1;
    if (['renewal', 'downgrade'].includes(op.kind)) {
      sub.status = 'past_due'; sub.blockedAt = sub.blockedAt || new Date();
      // A declined recurring charge requires a deliberate retry/card update;
      // never hammer an issuer with repeated automatic authorization attempts.
      sub.safepayBilling.nextChargeAt = null;
    } else if (op.kind === 'enrollment') {
      // A definitively declined initial invoice must not leave a billing
      // agreement enabled without any funded period or usable retry route.
      sub.safepayBilling.autoRenew = false;
      sub.safepayBilling.nextChargeAt = null;
    }
    await sub.save({ session });
  }
  await notifyOperation(op, { session, type: 'subscription.payment_failed', title: 'Subscription payment was not completed',
    body: 'The payment of {{money.charged}} could not be completed. No paid subscription access was granted by this attempt. Review your billing details in Rozare.' });
}

module.exports = { CONSENT_VERSION, createQuote, acceptQuote, presentQuote, operationStatus, claimRecurringCharge,
  settleBillingPayment, holdBillingPayment, failBillingPayment, applyOperation, notifyOperation, sellerSubscription, transaction, fail, minor, date, id,
  renewalPeriod, monthlyBoundary };
