'use strict';
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Subscription = require('../models/SellerSubscription');
const Operation = require('../models/SafepayBillingOperation');
const Payment = require('../models/SafepayPayment');
const Store = require('../models/Store');
const Promotion = require('../models/SubscriptionPromotion');
const User = require('../models/User');
const billing = require('./safepayBillingService');
const payments = require('./safepayPaymentService');
const { readSafepayConfig } = require('../config/safepay');
const { buildPlanPricing } = require('./subscriptionPricingService');
const { applyBillingCredit, renewalPeriod } = require('./safepayBillingMath');
const { requireOwnedReusableCard } = require('./safepayCustomerService');
const { snapshotMinorMoney } = require('./notificationMoneySnapshotService');
const { enqueueNotificationEvent } = require('./notificationOutboxService');
const { id, fail, minor, date, transaction } = billing;
let workerTimer = null;
let running = false;

async function notify(sub, kind, at, title, message, session) {
  const value = minor(sub.safepayBilling.monthlyMinor);
  return enqueueNotificationEvent({ eventKey: `safepay-sub:${sub._id}:${sub.safepayBilling.contractId}:${kind}:${date(at).getTime()}`,
    eventType: kind === 'ended' || kind === 'cancel_scheduled' ? 'subscription.cancelled' : 'subscription.payment_received',
    aggregateType: 'SellerSubscription', aggregateId: sub._id, occurredAt: at, financial: true,
    recipient: { kind: 'user', audienceRole: 'seller', user: sub.seller, destinationPolicy: 'current_user', allowBlocked: true },
    channels: ['inapp', 'push', 'email', 'whatsapp'],
    templates: { inapp: { title, body: message }, push: { title, body: message }, email: { subject: title, text: message }, whatsapp: { message: `${title}\n\n${message}` } },
    money: [snapshotMinorMoney({ key: 'monthly', label: 'Monthly subscription rate', amountMinor: value, currency: 'USD',
      sourceModel: 'SellerSubscription', sourceDocumentId: sub._id, sourcePath: 'safepayBilling.monthlyMinor' })],
    metadata: { category: 'subscription', channelId: 'seller', whatsappCategory: 'subscriptionAlerts',
      linkTo: '/seller-dashboard/subscription', data: { type: 'subscription_updated', subscriptionId: id(sub) } }, session });
}

async function scopedSubscription(sellerId, session) {
  const config = readSafepayConfig(process.env, { requireWebhook: true });
  const sub = await Subscription.findOne({ seller: sellerId, billingProvider: 'safepay', 'safepayBilling.environment': config.environment }).select('+safepayBilling.cardId').session(session);
  if (!sub) throw fail('No Safepay subscription was found in this environment.', 'SAFEPAY_SUBSCRIPTION_NOT_FOUND', 404);
  return sub;
}

async function cancel(sellerId) {
  return transaction(async session => {
    const sub = await scopedSubscription(sellerId, session);
    if (sub.cancelledAt && !sub.safepayBilling.autoRenew && !sub.pendingDowngrade?.toPlan) return { msg: 'Renewal is already cancelled.', reused: true };
    const at = new Date();
    sub.cancelledAt = at; sub.pendingDowngrade = { toPlan: null };
    sub.safepayBilling.autoRenew = false; sub.safepayBilling.nextChargeAt = null; sub.safepayBilling.version += 1;
    let currentPaymentMayComplete = false;
    if (sub.safepayBilling.pendingOperation) {
      const op = await Operation.findById(sub.safepayBilling.pendingOperation).session(session);
      const payment = op?.payment && await Payment.findById(op.payment).session(session);
      if (payment?.chargeStartedAt || payment?.appliedAt) currentPaymentMayComplete = true;
      else if (op) {
        // Subscription trackers are server-only; no hosted payment URL was
        // exposed. A tracker whose authorization never started is safe to stop.
        if (payment) { payment.status = 'cancelled'; payment.cancelledAt = at; await payment.save({ session }); }
        op.status = 'cancelled'; await op.save({ session });
        sub.safepayBilling.pendingOperation = null;
        if (op.terms.founderReservationToken) await Promotion.updateOne({ code: 'FIRST100' },
          { $pull: { reservations: { seller: sub.seller, token: op.terms.founderReservationToken } } }, { session });
      }
    }
    await sub.save({ session });
    if (sub.safepayBilling.monthlyMinor !== null) await notify(sub, 'cancel_scheduled', at, 'Subscription renewal cancelled',
      `Renewal of your {{money.monthly}}/month plan is cancelled. Current funded access remains until its period ends.${currentPaymentMayComplete ? ' A payment already in progress may still complete; this cancellation stops subsequent renewals.' : ''}`, session);
    return { msg: 'Subscription renewal is cancelled. Current funded access remains until period end.', currentPaymentMayComplete };
  });
}

async function resume(sellerId) {
  return transaction(async session => {
    const sub = await scopedSubscription(sellerId, session);
    if (sub.paymentRisk?.suspended || sub.safepayBilling.pendingOperation || sub.pendingDowngrade?.toPlan) throw fail('Resolve the pending billing action before resuming.', 'SUBSCRIPTION_BILLING_PENDING');
    if (!['active', 'free_period'].includes(sub.status) || date(sub.currentPeriodEnd) <= new Date() || sub.safepayBilling.endedAt) {
      throw fail('This subscription already ended. Review a new subscription quote.', 'SUBSCRIPTION_ENDED');
    }
    if (sub.safepayBilling.autoRenew && !sub.cancelledAt) return { msg: 'Automatic renewal is already active.', reused: true };
    sub.cancelledAt = null; sub.safepayBilling.autoRenew = true; sub.safepayBilling.nextChargeAt = sub.currentPeriodEnd;
    sub.safepayBilling.version += 1;
    await sub.save({ session });
    await notify(sub, 'resumed', new Date(), 'Subscription renewal resumed', 'Automatic renewal of your {{money.monthly}}/month plan is active again.', session);
    return { msg: 'Subscription renewal resumed.' };
  });
}

async function scheduleDowngrade(sellerId) {
  return transaction(async session => {
    const sub = await scopedSubscription(sellerId, session);
    if (sub.pendingDowngrade?.toPlan === 'starter') return { msg: 'Starter is already scheduled for period end.', reused: true };
    if (sub.plan !== 'elite' || !['active', 'free_period'].includes(sub.status) || sub.paymentRisk?.suspended
      || sub.safepayBilling.pendingOperation || date(sub.currentPeriodEnd) <= new Date()) throw fail('An active Elite subscription is required.', 'DOWNGRADE_NOT_AVAILABLE');
    const price = buildPlanPricing('starter', false, sub.founderOffer?.active === true);
    const at = new Date();
    sub.pendingDowngrade = { toPlan: 'starter', scheduledAt: at, operationKey: crypto.randomUUID(),
      targetPlanName: price.planName, targetUnitAmountMinor: price.unitAmount, targetCurrency: 'usd',
      founderRateApplied: price.founderRate, founderDiscountPercent: sub.founderOffer?.active ? sub.founderOffer.discountPercent : 0,
      founderOfferCode: sub.founderOffer?.active ? sub.founderOffer.code : null,
      starterBonusEligible: !sub.starterBonusPeriodUsed && !sub.bonusFeaturesExpiredPermanently, quoteFrozenAt: at };
    sub.cancelledAt = at;
    sub.safepayBilling.autoRenew = true; sub.safepayBilling.nextChargeAt = sub.currentPeriodEnd; sub.safepayBilling.version += 1;
    await sub.save({ session });
    await notify(sub, 'downgrade_scheduled', at, 'Starter plan scheduled', 'Your current {{money.monthly}}/month Elite plan remains active through this period. The Starter price shown in your subscription settings will apply from the next period.', session);
    return { msg: 'Your plan will switch to Starter at the end of the current period.' };
  });
}

async function cancelDowngrade(sellerId) {
  return transaction(async session => {
    const sub = await scopedSubscription(sellerId, session);
    if (!sub.pendingDowngrade?.toPlan) return { msg: 'No downgrade is scheduled.', reused: true };
    if (sub.safepayBilling.pendingOperation) throw fail('The next billing period is already being processed.', 'SUBSCRIPTION_BILLING_PENDING');
    sub.pendingDowngrade = { toPlan: null }; sub.cancelledAt = null;
    sub.safepayBilling.autoRenew = true; sub.safepayBilling.nextChargeAt = sub.currentPeriodEnd; sub.safepayBilling.version += 1;
    await sub.save({ session });
    await notify(sub, 'downgrade_cancelled', new Date(), 'Scheduled downgrade cancelled', 'Your {{money.monthly}}/month plan will continue. No downgrade is scheduled.', session);
    return { msg: 'The scheduled downgrade was cancelled.' };
  });
}

async function queueRenewal(subscriptionId, at = new Date()) {
  const config = readSafepayConfig(process.env, { requireWebhook: true });
  return transaction(async session => {
    const sub = await Subscription.findOne({ _id: subscriptionId, billingProvider: 'safepay', 'safepayBilling.environment': config.environment }).select('+safepayBilling.cardId').session(session);
    if (!sub || !sub.safepayBilling.autoRenew || sub.paymentRisk?.suspended) return null;
    if (sub.safepayBilling.pendingOperation) return Operation.findById(sub.safepayBilling.pendingOperation).session(session);
    const period = renewalPeriod({ anchorAt: sub.safepayBilling.anchorAt, cycle: sub.safepayBilling.cycle, now: at });
    if (!period.due) {
      if (period.missed) {
        // Do not silently collect several months after an extended outage.
        sub.status = 'past_due'; sub.blockedAt = sub.blockedAt || period.start;
        sub.safepayBilling.nextChargeAt = null;
        sub.safepayBilling.lastFailureCode = 'SUBSCRIPTION_MISSED_PERIOD_REVIEW';
        await sub.save({ session });
        await Store.updateOne({ seller: sub.seller, isActive: true }, { $set: { isActive: false, blockedAt: sub.blockedAt } }, { session });
      }
      return null;
    }
    const downgrade = sub.pendingDowngrade?.toPlan === 'starter';
    const monthlyMinor = downgrade ? minor(sub.pendingDowngrade.targetUnitAmountMinor) : minor(sub.safepayBilling.monthlyMinor);
    const credit = applyBillingCredit(monthlyMinor, minor(sub.safepayBilling.creditMinor));
    const requestKey = `renewal:${sub.safepayBilling.contractId}:${sub.safepayBilling.cycle}`;
    const terms = { plan: downgrade ? 'starter' : sub.plan, planName: downgrade ? sub.pendingDowngrade.targetPlanName : sub.planName,
      includeMetaAds: downgrade ? false : sub.metaAdsIncluded, monthlyMinor, currency: 'USD', trialDays: 0,
      founderRate: sub.founderOffer?.active === true, sourceContractId: sub.safepayBilling.contractId,
      periodStart: period.start, periodEnd: period.end, cycle: sub.safepayBilling.cycle,
      grossMinor: monthlyMinor, dueMinor: credit.chargeMinor, appliedCreditMinor: credit.appliedCreditMinor,
      remainingCreditMinor: credit.remainingCreditMinor, creditMinor: 0 };
    const existing = await Operation.findOne({ seller: sub.seller, environment: config.environment, requestKey }).session(session);
    if (existing) return existing;
    const [op] = await Operation.create([{ seller: sub.seller, subscription: sub._id, environment: config.environment,
      kind: downgrade ? 'downgrade' : 'renewal', requestKey, fingerprint: payments.fingerprint(terms),
      sourceVersion: sub.safepayBilling.version, terms, acceptedAt: period.start, consentVersion: sub.safepayBilling.consentVersion,
      cardId: sub.safepayBilling.cardId, status: 'accepted' }], { session });
    sub.safepayBilling.pendingOperation = op._id;
    sub.status = 'past_due'; sub.blockedAt = sub.blockedAt || period.start;
    await Store.updateOne({ seller: sub.seller, isActive: true }, { $set: { isActive: false, blockedAt: sub.blockedAt } }, { session });
    if (terms.dueMinor > 0) {
      const payment = await payments.ensurePayment({ user: sub.seller, purpose: 'subscription', reference: `billing:${op._id}`, requestKey: `billing:${op._id}`,
        amountMinor: terms.dueMinor, currency: 'USD', customerId: sub.safepayBilling.customerId, cardId: sub.safepayBilling.cardId,
        terms: { billingOperationId: id(op), subscriptionId: id(sub), contractId: terms.sourceContractId } }, { session });
      op.payment = payment._id; op.status = 'awaiting_payment';
      await sub.save({ session }); await op.save({ session });
    } else { await sub.save({ session }); await billing.applyOperation(op, sub, session); }
    return op;
  });
}

async function closeEndedSubscription(subscriptionId, at = new Date()) {
  return transaction(async session => {
    const sub = await Subscription.findById(subscriptionId).session(session);
    if (!sub || sub.billingProvider !== 'safepay' || sub.safepayBilling.autoRenew || !sub.cancelledAt || sub.pendingDowngrade?.toPlan
      || sub.safepayBilling.pendingOperation || sub.safepayBilling.endedAt || !sub.currentPeriodEnd || date(sub.currentPeriodEnd) > at) return false;
    const endedAt = date(sub.currentPeriodEnd);
    sub.status = 'cancelled'; sub.blockedAt = endedAt; sub.blockedReason = 'Subscription period ended. Subscribe to reactivate your store.';
    sub.safepayBilling.endedAt = endedAt; sub.safepayBilling.nextChargeAt = null; sub.safepayBilling.version += 1;
    if (sub.founderOffer?.active) { sub.founderOffer.active = false; sub.founderOffer.forfeitedAt = endedAt; }
    sub.bonusGraceDeadline = new Date(endedAt.getTime() + 3 * 86400000);
    await sub.save({ session });
    const store = await Store.findOne({ seller: sub.seller }).session(session);
    if (store) {
      store.isActive = false; store.blockedAt = endedAt;
      if (!(store.subdomainPurchase?.isPurchased && store.subdomainPurchase.expiresAt && date(store.subdomainPurchase.expiresAt) > at)) {
        store.subdomainPurchase.removalScheduledAt = store.subdomainPurchase.removalScheduledAt || new Date(endedAt.getTime() + 7 * 86400000);
      }
      await store.save({ session });
    }
    await notify(sub, 'ended', endedAt, 'Subscription ended', 'Your {{money.monthly}}/month subscription has ended. Your seller data remains available in Rozare.', session);
    return true;
  });
}

async function refreshStatus(subscriptionId) {
  await closeEndedSubscription(subscriptionId);
  return transaction(async session => {
    const sub = await Subscription.findById(subscriptionId).session(session);
    if (sub?.billingProvider === 'safepay' && ['active', 'free_period'].includes(sub.status)
      && sub.currentPeriodEnd && date(sub.currentPeriodEnd) <= new Date() && !sub.safepayBilling.endedAt) {
      // Read paths never charge a card, but expired paid access and public
      // visibility must agree even before the scheduled worker wakes up.
      sub.status = 'past_due'; sub.blockedAt = sub.blockedAt || sub.currentPeriodEnd;
      await sub.save({ session });
      await Store.updateOne({ seller: sub.seller, isActive: true }, { $set: { isActive: false, blockedAt: sub.blockedAt } }, { session });
    }
    return sub;
  });
}

async function runBillingWorker() {
  if (running || process.env.SAFEPAY_MOBILE_ENABLED !== 'true' || mongoose.connection.readyState !== 1) return;
  running = true;
  try {
    const config = readSafepayConfig(process.env, { requireWebhook: true });
    await Promise.all([Operation.init(), Payment.init()]);
    // Accepted enrollment/upgrade invoices are durable work as well, including
    // a server crash before the first provider request was dispatched.
    const accepted = await Operation.find({ environment: config.environment, status: 'awaiting_payment', payment: { $ne: null } })
      .sort({ acceptedAt: 1 }).limit(20).select('payment');
    for (const op of accepted) {
      try { await payments.submitRecurringPayment(op.payment); }
      catch (error) { console.error('[safepay-billing] pending invoice:', error.code || 'BILLING_UNAVAILABLE'); }
    }
    const due = await Subscription.find({ billingProvider: 'safepay', 'safepayBilling.environment': config.environment,
      'paymentRisk.suspended': { $ne: true }, $or: [
        { 'safepayBilling.autoRenew': true, 'safepayBilling.nextChargeAt': { $ne: null, $lte: new Date() } },
        { 'safepayBilling.autoRenew': false, cancelledAt: { $ne: null }, currentPeriodEnd: { $lte: new Date() }, 'safepayBilling.endedAt': null },
      ] }).sort({ 'safepayBilling.nextChargeAt': 1 }).limit(25).select('_id');
    for (const row of due) {
      try {
        await closeEndedSubscription(row._id);
        const op = await queueRenewal(row._id);
        if (op?.payment && op.status === 'awaiting_payment') await payments.submitRecurringPayment(op.payment);
      } catch (error) { console.error('[safepay-billing] deferred:', error.code || 'BILLING_UNAVAILABLE'); }
    }
  } finally { running = false; }
}
function startBillingWorker() {
  if (workerTimer || process.env.SAFEPAY_MOBILE_ENABLED !== 'true') return;
  workerTimer = setInterval(() => runBillingWorker().catch(error => console.error('[safepay-billing] deferred:', error.code || 'BILLING_UNAVAILABLE')), 30000);
  workerTimer.unref?.();
  runBillingWorker().catch(() => {});
}
function stopBillingWorker() { if (workerTimer) clearInterval(workerTimer); workerTimer = null; }

module.exports = { cancel, resume, scheduleDowngrade, cancelDowngrade, queueRenewal, closeEndedSubscription,
  refreshStatus, runBillingWorker, startBillingWorker, stopBillingWorker };
