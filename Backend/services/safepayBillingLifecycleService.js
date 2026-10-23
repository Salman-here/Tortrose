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
const { safepayWorkersEnabled } = require('./safepayFeatureFlags');
const { buildPlanPricing } = require('./subscriptionPricingService');
const { applyBillingCredit, renewalPeriod } = require('./safepayBillingMath');
const { requireOwnedReusableCard } = require('./safepayCustomerService');
const renewalPolicy = require('./safepayRenewalPolicy');
const billingTest = require('./subscriptionBillingTestPolicy');
const testClocks = require('./subscriptionBillingTestClockService');
const { snapshotMinorMoney } = require('./notificationMoneySnapshotService');
const { enqueueNotificationEvent } = require('./notificationOutboxService');
const { id, fail, minor, date, transaction } = billing;
let workerTimer = null;
const WORKER_LEASE_MS = 180000;
const WORKER_RETRY_BASE_MS = 30000;
const WORKER_RETRY_MAX_MS = 15 * 60000;

const eligibleAt = (nextPath, leasePath, at) => ({ $and: [
  { $or: [{ [nextPath]: null }, { [nextPath]: { $lte: at } }] },
  { $or: [{ [leasePath]: null }, { [leasePath]: { $lte: at } }] },
] });
const retryDelay = attempts => Math.min(WORKER_RETRY_MAX_MS,
  WORKER_RETRY_BASE_MS * 2 ** Math.min(10, Math.max(0, (attempts || 1) - 1)));

async function submitQueuedOperation(operationId, environment) {
  const at = new Date(), token = crypto.randomUUID();
  const op = await Operation.findOneAndUpdate({ _id: operationId, environment,
    status: 'awaiting_payment', payment: { $ne: null },
    ...eligibleAt('workerNextAttemptAt', 'workerLeaseUntil', at) }, {
    $set: { workerLeaseToken: token, workerLeaseUntil: new Date(at.getTime() + WORKER_LEASE_MS),
      workerLastAttemptAt: at, workerNextAttemptAt: new Date(at.getTime() + WORKER_LEASE_MS) },
    $inc: { workerAttempts: 1 },
  }, { new: true });
  if (!op) return;
  try {
    // Unknown provider outcomes are reconciled by the payment service, never
    // blindly replayed. This scheduling lease cannot authorize a new invoice.
    await payments.submitRecurringPayment(op.payment);
  } finally {
    await Operation.updateOne({ _id: op._id, workerLeaseToken: token }, { $set: {
      workerNextAttemptAt: new Date(Date.now() + retryDelay(op.workerAttempts)),
      workerLeaseToken: null, workerLeaseUntil: null,
    } });
  }
}

async function notify(sub, kind, at, title, message, session) {
  const value = minor(sub.safepayBilling.monthlyMinor);
  if (sub.safepayBilling.testClock && !sub.safepayBilling.testClock.restoredAt) message = message.replace(/per month/g,'per 20 minutes');
  // Lifecycle notices describe current state. Freeze their authority with the
  // transition, so a queued cancellation cannot be delivered after a resume.
  sub.safepayBilling.notification = { kind, occurredAt: date(at),
    contractId: sub.safepayBilling.contractId, version: sub.safepayBilling.version, monthlyMinor: value };
  await sub.save({ session });
  return enqueueNotificationEvent({ eventKey: `safepay-sub:${sub._id}:${sub.safepayBilling.contractId}:${kind}:${date(at).getTime()}`,
    eventType: kind === 'ended' || kind === 'cancel_scheduled' ? 'subscription.cancelled' : 'subscription.payment_received',
    aggregateType: 'SellerSubscription', aggregateId: sub._id, occurredAt: at, financial: true,
    recipient: { kind: 'user', audienceRole: 'seller', user: sub.seller, destinationPolicy: 'current_user', allowBlocked: true },
    channels: ['inapp', 'push', 'email', 'whatsapp'],
    templates: { inapp: { title, body: message }, push: { title, body: message }, email: { subject: title, text: message }, whatsapp: { message: `*${title}*\n\n${message}` } },
    money: [snapshotMinorMoney({ key: 'monthly', label: 'Monthly subscription rate', amountMinor: value, currency: 'USD',
      sourceModel: 'SellerSubscription', sourceDocumentId: sub._id, sourcePath: 'safepayBilling.notification.monthlyMinor' })],
    metadata: { category: 'subscription', channelId: 'seller', whatsappCategory: kind === 'downgrade_scheduled' ? 'downgrade_scheduled'
      : ['ended', 'cancel_scheduled'].includes(kind) ? 'subscription_ending' : 'subscription_activated',
      linkTo: '/seller-dashboard/subscription', data: { type: 'subscription_updated', subscriptionId: id(sub),
        contractId: sub.safepayBilling.contractId, billingVersion: sub.safepayBilling.version, lifecycleKind: kind } }, session });
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
    sub.cancelledAt = at; sub.pendingDowngrade = { toPlan: null }; sub.warningEmailSent = false;
    sub.safepayBilling.autoRenew = false; sub.safepayBilling.nextChargeAt = null; sub.safepayBilling.version += 1;
    const protectedEnd = sub.safepayBilling.testClock?.origin === 'operator' && sub.safepayBilling.testClock.original?.subscription?.currentPeriodEnd;
    if (protectedEnd && date(protectedEnd) > date(sub.currentPeriodEnd)) sub.currentPeriodEnd = date(protectedEnd);
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
    if (renewalPolicy.ownsRecovery(sub) && !currentPaymentMayComplete && !sub.safepayBilling.pendingOperation
      && sub.currentPeriodEnd && date(sub.currentPeriodEnd) <= at) {
      sub.safepayBilling.recovery.nextRetryAt = null;
      await finishSubscription(sub, at, at, session);
      return { msg: 'Your subscription was cancelled. No further renewal attempts will be started.', currentPaymentMayComplete: false };
    }
    if (sub.safepayBilling.monthlyMinor !== null) await notify(sub, 'cancel_scheduled', at, 'Subscription renewal cancelled',
      `Automatic renewal of your plan ({{money.monthly}} per month) is turned off.${['active', 'free_period'].includes(sub.status) && sub.currentPeriodEnd && Number.isFinite(new Date(sub.currentPeriodEnd).getTime()) ? ` You can use your current plan until ${date(sub.currentPeriodEnd).toISOString().slice(0, 10)}.` : ''}${currentPaymentMayComplete ? ' A payment already in progress may still complete. No further renewals will be started.' : ''} Review your subscription details if you want to resume.`, session);
    return { msg: 'Subscription renewal is cancelled. Current funded access remains until period end.', currentPaymentMayComplete };
  });
}

async function resume(sellerId) {
  return transaction(async session => {
    const sub = await scopedSubscription(sellerId, session);
    if (sub.safepayBilling.testClock && !sub.safepayBilling.testClock.restoredAt && !billingTest.authorized(sub.safepayBilling.testClock)) {
      throw fail('The temporary test agreement ended. Review normal subscription pricing before starting a new agreement.', 'BILLING_TEST_ENDED');
    }
    if (sub.paymentRisk?.suspended || sub.safepayBilling.pendingOperation || sub.pendingDowngrade?.toPlan) throw fail('Resolve the pending billing action before resuming.', 'SUBSCRIPTION_BILLING_PENDING');
    if (!['active', 'free_period'].includes(sub.status) || date(sub.currentPeriodEnd) <= new Date() || sub.safepayBilling.endedAt) {
      throw fail('This subscription already ended. Review a new subscription quote.', 'SUBSCRIPTION_ENDED');
    }
    if (sub.safepayBilling.autoRenew && !sub.cancelledAt) return { msg: 'Automatic renewal is already active.', reused: true };
    sub.cancelledAt = null; sub.warningEmailSent = false;
    sub.safepayBilling.autoRenew = true; sub.safepayBilling.nextChargeAt = sub.currentPeriodEnd;
    sub.safepayBilling.version += 1;
    await sub.save({ session });
    await notify(sub, 'resumed', new Date(), 'Automatic renewal resumed', 'Automatic renewal of your plan ({{money.monthly}} per month) is turned on again. Review your next billing date and payment method in Subscription.', session);
    return { msg: 'Subscription renewal resumed.' };
  });
}

async function scheduleDowngrade(sellerId) {
  return transaction(async session => {
    const sub = await scopedSubscription(sellerId, session);
    if (sub.safepayBilling.testClock?.origin === 'operator' && !sub.safepayBilling.testClock.restoredAt) throw fail('The original plan is preserved during the global billing test. Schedule a plan change after this test ends.', 'BILLING_TEST_EXISTING_PLAN_CHANGE_HELD');
    if (sub.pendingDowngrade?.toPlan === 'starter') return { msg: 'Starter is already scheduled for period end.', reused: true };
    if (sub.plan !== 'elite' || !['active', 'free_period'].includes(sub.status) || sub.paymentRisk?.suspended
      || sub.safepayBilling.pendingOperation || date(sub.currentPeriodEnd) <= new Date()) throw fail('An active Elite subscription is required.', 'DOWNGRADE_NOT_AVAILABLE');
    const price = buildPlanPricing('starter', false, sub.founderOffer?.active === true, {ignoreTest:false});
    const at = new Date();
    sub.pendingDowngrade = { toPlan: 'starter', scheduledAt: at, operationKey: crypto.randomUUID(),
      targetPlanName: price.planName, targetUnitAmountMinor: price.unitAmount, targetCurrency: 'usd',
      founderRateApplied: price.founderRate, founderDiscountPercent: sub.founderOffer?.active ? sub.founderOffer.discountPercent : 0,
      founderOfferCode: sub.founderOffer?.active ? sub.founderOffer.code : null,
      starterBonusEligible: !sub.starterBonusPeriodUsed && !sub.bonusFeaturesExpiredPermanently, quoteFrozenAt: at };
    sub.cancelledAt = at;
    sub.safepayBilling.autoRenew = true; sub.safepayBilling.nextChargeAt = sub.currentPeriodEnd; sub.safepayBilling.version += 1;
    await sub.save({ session });
    await notify(sub, 'downgrade_scheduled', at, 'Downgrade to Starter scheduled', 'Your current Elite plan at {{money.monthly}} per month remains active until this billing period ends. Your plan will then switch to Starter after its payment is completed. Review the new price or cancel this change in Subscription.', session);
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
    await notify(sub, 'downgrade_cancelled', new Date(), 'Scheduled downgrade cancelled', 'Your downgrade to Starter has been cancelled. Automatic renewal of your current plan ({{money.monthly}} per month) will continue.', session);
    return { msg: 'The scheduled downgrade was cancelled.' };
  });
}

async function queueRenewal(subscriptionId, at = new Date()) {
  const config = readSafepayConfig(process.env, { requireWebhook: true });
  return transaction(async session => {
    const sub = await Subscription.findOne({ _id: subscriptionId, billingProvider: 'safepay', 'safepayBilling.environment': config.environment }).select('+safepayBilling.cardId').session(session);
    if (!sub || !sub.safepayBilling.autoRenew || sub.paymentRisk?.suspended) return null;
    const clock = sub.safepayBilling.testClock;
    const test = clock && !clock.restoredAt ? billingTest.validateStamp(clock) : null;
    if (test && !billingTest.authorized(test,at)) {
      if (testClocks.stop(sub,at)) { sub.markModified('safepayBilling.testClock'); await sub.save({session}); }
      return null;
    }
    if (!test && billingTest.readWindow(process.env,at)) return null;
    if (sub.safepayBilling.pendingOperation) return Operation.findById(sub.safepayBilling.pendingOperation).session(session);
    if (renewalPolicy.ownsRecovery(sub)) return queueRecoveryAttempt(sub, at, config, session);
    const period = renewalPeriod({ anchorAt: sub.safepayBilling.anchorAt, cycle: sub.safepayBilling.cycle, now: at, billingTest:test });
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
    if (renewalPolicy.cancellationDeadline(period.start) <= at) {
      // An extended scheduling outage is not authorization to collect an old
      // month or to bunch missed issuer attempts together.
      sub.status = 'past_due'; sub.blockedAt = sub.blockedAt || period.start;
      sub.safepayBilling.nextChargeAt = null;
      sub.safepayBilling.lastFailureCode = 'SUBSCRIPTION_MISSED_PERIOD_REVIEW';
      await sub.save({ session });
      await Store.updateOne({ seller: sub.seller, isActive: true }, { $set: { isActive: false, blockedAt: sub.blockedAt } }, { session });
      return null;
    }
    const downgrade = sub.pendingDowngrade?.toPlan === 'starter';
    const monthlyMinor = test ? 100 : downgrade ? minor(sub.pendingDowngrade.targetUnitAmountMinor) : minor(sub.safepayBilling.monthlyMinor);
    const credit = test ? {chargeMinor:100,appliedCreditMinor:0,remainingCreditMinor:minor(sub.safepayBilling.creditMinor)}
      : applyBillingCredit(monthlyMinor, minor(sub.safepayBilling.creditMinor));
    const requestKey = `${test ? `test-renewal:${test.id}` : 'renewal'}:${sub.safepayBilling.contractId}:${sub.safepayBilling.cycle}`;
    const metaAddonMinor = !test && !downgrade && sub.metaAdsIncluded
      ? (await require('./safepayMetaCreditService').currentMetaFunding(sub, config.environment, session)).addonMonthlyMinor : 0;
    const terms = { plan: downgrade ? 'starter' : sub.plan, planName: downgrade ? sub.pendingDowngrade.targetPlanName : sub.planName,
      metaAddonMinor,
      includeMetaAds: downgrade ? false : sub.metaAdsIncluded, monthlyMinor, currency: 'USD', trialDays: 0,
      ...(test ? {billingTest:{id:test.id,startsAt:test.startsAt,expiresAt:test.expiresAt,amountMinor:100,currency:'USD',starterIntroMinutes:10,eliteIntroMinutes:15,renewalMinutes:20}} : {}),
      founderRate: sub.founderOffer?.active === true, sourceContractId: sub.safepayBilling.contractId,
      periodStart: period.start, periodEnd: period.end, cycle: sub.safepayBilling.cycle,
      grossMinor: monthlyMinor, dueMinor: credit.chargeMinor, appliedCreditMinor: credit.appliedCreditMinor,
      remainingCreditMinor: credit.remainingCreditMinor, creditMinor: 0,
      renewalAttempt: 1, automaticRetry: true, recoveryPolicyVersion: renewalPolicy.POLICY_VERSION };
    const existing = await Operation.findOne({ seller: sub.seller, environment: config.environment, requestKey }).session(session);
    if (existing) return existing;
    const [op] = await Operation.create([{ seller: sub.seller, subscription: sub._id, environment: config.environment,
      kind: downgrade ? 'downgrade' : 'renewal', requestKey, fingerprint: payments.fingerprint(terms),
      sourceVersion: sub.safepayBilling.version, terms, acceptedAt: period.start, consentVersion: sub.safepayBilling.consentVersion,
      cardId: sub.safepayBilling.cardId, status: 'accepted' }], { session });
    sub.safepayBilling.pendingOperation = op._id;
    sub.safepayBilling.recovery = { rootOperation: op._id, contractId: sub.safepayBilling.contractId,
      cycle: sub.safepayBilling.cycle, policyVersion: renewalPolicy.POLICY_VERSION,
      startedAt: period.start, cancelAt: renewalPolicy.cancellationDeadline(period.start),
      attempts: 1, nextRetryAt: null, lastFailureAt: null, cancelledAt: null };
    sub.status = 'active';
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

async function queueRecoveryAttempt(sub, at, config, session) {
  const r = sub.safepayBilling.recovery;
  if (!r.nextRetryAt || date(r.nextRetryAt) > at || date(r.cancelAt) <= at || r.attempts >= renewalPolicy.ATTEMPT_DAYS.length) return null;
  const previous = await Operation.findOne({ _id: sub.safepayBilling.lastFailedOperation, subscription: sub._id,
    seller: sub.seller, environment: config.environment, status: 'failed', kind: { $in: ['renewal', 'downgrade'] } }).session(session);
  const failed = previous?.payment && await Payment.findById(previous.payment).session(session);
  if (!previous || previous.terms.sourceContractId !== sub.safepayBilling.contractId
    || previous.terms.cycle !== sub.safepayBilling.cycle || date(previous.terms.periodEnd) <= at
    || failed?.status !== 'failed' || failed.chargeOutcome !== 'declined' || failed.appliedAt || failed.capturedMinor !== 0) return null;
  const attempt = r.attempts + 1;
  const requestKey = `renewal-retry:${sub.safepayBilling.contractId}:${sub.safepayBilling.cycle}:${attempt}`;
  const existing = await Operation.findOne({ seller: sub.seller, environment: config.environment, requestKey }).session(session);
  if (existing) return existing;
  // Reuse the frozen unpaid invoice's price, credit and exact period. Only a
  // definitively failed authorization permits a fresh payment/tracker.
  const terms = { ...previous.terms, trialDays: 0, retryOf: id(previous), automaticRetry: true, renewalAttempt: attempt };
  delete terms.checkoutClaimToken;
  const [op] = await Operation.create([{ seller: sub.seller, subscription: sub._id, environment: config.environment,
    kind: previous.kind, requestKey, fingerprint: payments.fingerprint(terms), sourceVersion: sub.safepayBilling.version,
    terms, acceptedAt: at, consentVersion: sub.safepayBilling.consentVersion,
    cardId: sub.safepayBilling.cardId, status: 'accepted' }], { session });
  const payment = await payments.ensurePayment({ user: sub.seller, purpose: 'subscription',
    reference: `billing:${op._id}`, requestKey: `billing:${op._id}`, amountMinor: terms.dueMinor, currency: 'USD',
    customerId: sub.safepayBilling.customerId, cardId: sub.safepayBilling.cardId,
    terms: { billingOperationId: id(op), subscriptionId: id(sub), contractId: terms.sourceContractId } }, { session });
  op.payment = payment._id; op.status = 'awaiting_payment';
  sub.safepayBilling.pendingOperation = op._id;
  r.attempts = attempt; r.nextRetryAt = null;
  await sub.save({ session }); await op.save({ session });
  return op;
}

async function finishSubscription(sub, endedAt, at, session, unpaid = false) {
  sub.status = 'cancelled'; sub.blockedAt = endedAt;
  sub.blockedReason = unpaid ? 'Subscription cancelled because the renewal remained unpaid. Subscribe to reactivate your store.'
    : 'Subscription period ended. Subscribe to reactivate your store.';
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
  await notify(sub, 'ended', endedAt, unpaid ? 'Subscription cancelled — renewal payment unsuccessful' : 'Your subscription has ended',
    unpaid ? 'Your subscription ({{money.monthly}} per month) was cancelled because its renewal remained unpaid at the end of the seven-day recovery period. Your store is now hidden from customers. Your seller data is preserved. Choose a plan in Subscription to reactivate your store.'
      : 'Your subscription ({{money.monthly}} per month) has ended and your store is hidden from customers. Your seller data remains available. Choose a plan in Subscription to reactivate your store.', session);
  return true;
}

async function closeUnpaidRenewal(subscriptionId, at = new Date()) {
  const config = readSafepayConfig(process.env, { requireWebhook: true });
  return transaction(async session => {
    const sub = await Subscription.findOne({ _id: subscriptionId, billingProvider: 'safepay',
      'safepayBilling.environment': config.environment }).session(session);
    if (!sub || !renewalPolicy.ownsRecovery(sub) || !sub.safepayBilling.autoRenew || sub.safepayBilling.endedAt
      || sub.paymentRisk?.suspended || date(sub.safepayBilling.recovery.cancelAt) > at) return false;
    if (sub.safepayBilling.pendingOperation) {
      const op = await Operation.findById(sub.safepayBilling.pendingOperation).session(session);
      const payment = op?.payment && await Payment.findById(op.payment).session(session);
      if (!op || payment?.chargeStartedAt || payment?.appliedAt) {
        // An unknown/in-flight result is never a decline and cannot authorize
        // another charge or a false final cancellation. Pause expired grace
        // access while the original invoice is reconciled read-only.
        sub.status = 'past_due'; sub.blockedAt = sub.blockedAt || date(sub.safepayBilling.recovery.cancelAt);
        sub.safepayBilling.recovery.reviewNextAt = new Date(at.getTime() + 15 * 60000);
        await sub.save({ session });
        await Store.updateOne({ seller: sub.seller, isActive: true }, { $set: { isActive: false, blockedAt: sub.blockedAt } }, { session });
        return false;
      }
      if (payment) { payment.status = 'cancelled'; payment.cancelledAt = at; await payment.save({ session }); }
      op.status = 'cancelled'; await op.save({ session });
      sub.safepayBilling.pendingOperation = null;
    }
    const endedAt = date(sub.safepayBilling.recovery.cancelAt);
    sub.safepayBilling.autoRenew = false; sub.cancelledAt = endedAt;
    sub.safepayBilling.recovery.cancelledAt = endedAt; sub.safepayBilling.recovery.nextRetryAt = null;
    sub.pendingDowngrade = { toPlan: null };
    return finishSubscription(sub, endedAt, at, session, true);
  });
}

async function closeEndedSubscription(subscriptionId, at = new Date()) {
  return transaction(async session => {
    const sub = await Subscription.findById(subscriptionId).session(session);
    if (!sub || sub.billingProvider !== 'safepay' || sub.safepayBilling.autoRenew || !sub.cancelledAt || sub.pendingDowngrade?.toPlan
      || sub.safepayBilling.pendingOperation || sub.safepayBilling.endedAt || !sub.currentPeriodEnd || date(sub.currentPeriodEnd) > at) return false;
    const endedAt = date(sub.currentPeriodEnd);
    return finishSubscription(sub, endedAt, at, session);
  });
}

async function refreshStatus(subscriptionId) {
  if (process.env.SAFEPAY_SUBSCRIPTION_TEST_WINDOW) {
    const config = readSafepayConfig(process.env, {requireWebhook:true});
    await testClocks.reconcileOne(subscriptionId,config.environment);
  }
  await closeUnpaidRenewal(subscriptionId);
  await closeEndedSubscription(subscriptionId);
  return transaction(async session => {
    const sub = await Subscription.findById(subscriptionId).session(session);
    if (sub?.billingProvider === 'safepay' && ['active', 'free_period'].includes(sub.status)
      && sub.currentPeriodEnd && date(sub.currentPeriodEnd) <= new Date() && !sub.safepayBilling.endedAt) {
      if (renewalPolicy.hasGraceAccess(sub)) {
        if (sub.status !== 'active') { sub.status = 'active'; await sub.save({ session }); }
        return sub;
      }
      // Read paths never charge a card, but expired paid access and public
      // visibility must agree even before the scheduled worker wakes up.
      sub.status = 'past_due'; sub.blockedAt = sub.blockedAt || sub.currentPeriodEnd;
      await sub.save({ session });
      await Store.updateOne({ seller: sub.seller, isActive: true }, { $set: { isActive: false, blockedAt: sub.blockedAt } }, { session });
    }
    return sub;
  });
}

// A local re-entry fence avoids overlapping timers. Database claims also fence
// independent processes and survive a restart without resetting retry history.
function createBillingWorker() {
  let running = false;
  return async function runBillingWorker() {
    if (running || !safepayWorkersEnabled() || mongoose.connection.readyState !== 1) return;
    running = true;
    try {
      const config = readSafepayConfig(process.env, { requireWebhook: true });
      await Promise.all([Operation.init(), Payment.init(), Subscription.init()]);
      const at = new Date();
      await testClocks.reconcileWindow(config.environment,at);
      const expiredGrace = await Subscription.find({ billingProvider: 'safepay', 'safepayBilling.environment': config.environment,
        'safepayBilling.autoRenew': true, 'safepayBilling.endedAt': null,
        'safepayBilling.recovery.rootOperation': { $ne: null }, 'safepayBilling.recovery.cancelAt': { $lte: at, $ne: null },
        $or: [{ 'safepayBilling.recovery.reviewNextAt': null }, { 'safepayBilling.recovery.reviewNextAt': { $lte: at } }],
        'paymentRisk.suspended': { $ne: true } }).select('_id').sort({ 'safepayBilling.recovery.cancelAt': 1, _id: 1 }).limit(25);
      for (const row of expiredGrace) {
        try { await closeUnpaidRenewal(row._id, at); }
        catch (error) { console.error('[safepay-billing] recovery deadline:', error.code || 'BILLING_UNAVAILABLE'); }
      }
      // A pending invoice owns its renewal; it must not permanently consume
      // BOTH batches while later sellers wait for their first billing attempt.
      const acceptedFilter = { environment: config.environment,
        status: 'awaiting_payment', payment: { $ne: null },
        ...eligibleAt('workerNextAttemptAt', 'workerLeaseUntil', at) };
      const accepted = await Operation.aggregate([
        { $match: acceptedFilter },
        // Missing scheduling fields use the original durable acceptance time,
        // not "always first" null sorting that could starve overdue retries.
        { $set: { workerQueueAt: { $ifNull: ['$workerNextAttemptAt', { $ifNull: ['$acceptedAt', '$createdAt'] }] } } },
        { $sort: { workerQueueAt: 1, workerLastAttemptAt: 1, acceptedAt: 1, _id: 1 } },
        { $limit: 20 }, { $project: { _id: 1 } },
      ]);
      for (const op of accepted) {
        try { await submitQueuedOperation(op._id, config.environment); }
        catch (error) { console.error('[safepay-billing] pending invoice:', error.code || 'BILLING_UNAVAILABLE'); }
      }
      const dueFilter = { billingProvider: 'safepay', 'safepayBilling.environment': config.environment,
        'paymentRisk.suspended': { $ne: true }, 'safepayBilling.pendingOperation': null,
        $and: [...eligibleAt('safepayBilling.workerNextAttemptAt', 'safepayBilling.workerLeaseUntil', at).$and,
          { $or: [
            { 'safepayBilling.autoRenew': true, 'safepayBilling.nextChargeAt': { $ne: null, $lte: at } },
            { 'safepayBilling.autoRenew': true, 'safepayBilling.recovery.nextRetryAt': { $ne: null, $lte: at } },
            { 'safepayBilling.autoRenew': false, cancelledAt: { $ne: null }, currentPeriodEnd: { $lte: at }, 'safepayBilling.endedAt': null },
          ] }],
      };
      const due = await Subscription.aggregate([
        { $match: dueFilter },
        { $set: { workerQueueAt: { $ifNull: ['$safepayBilling.workerNextAttemptAt', {
          $ifNull: ['$safepayBilling.nextChargeAt', '$currentPeriodEnd'],
        }] } } },
        { $sort: { workerQueueAt: 1, 'safepayBilling.workerLastAttemptAt': 1, _id: 1 } },
        { $limit: 25 }, { $project: { _id: 1 } },
      ]);
      for (const row of due) {
        const token = crypto.randomUUID(), claimedAt = new Date();
        const sub = await Subscription.findOneAndUpdate({ ...dueFilter, _id: row._id,
          $and: [...eligibleAt('safepayBilling.workerNextAttemptAt', 'safepayBilling.workerLeaseUntil', claimedAt).$and,
            dueFilter.$and.at(-1)] }, { $set: {
            'safepayBilling.workerLeaseToken': token,
            'safepayBilling.workerLeaseUntil': new Date(claimedAt.getTime() + WORKER_LEASE_MS),
            'safepayBilling.workerNextAttemptAt': new Date(claimedAt.getTime() + WORKER_LEASE_MS),
            'safepayBilling.workerLastAttemptAt': claimedAt,
          }, $inc: { 'safepayBilling.workerAttempts': 1 } }, { new: true });
        if (!sub) continue;
        let completed = false;
        try {
          completed = await closeEndedSubscription(row._id);
          if (!completed) {
            const op = await queueRenewal(row._id);
            if (op?.payment && op.status === 'awaiting_payment') await submitQueuedOperation(op._id, config.environment);
            completed = !!op;
          }
        } catch (error) { console.error('[safepay-billing] deferred:', error.code || 'BILLING_UNAVAILABLE'); }
        finally {
          await Subscription.updateOne({ _id: row._id, 'safepayBilling.workerLeaseToken': token }, { $set: {
            'safepayBilling.workerNextAttemptAt': completed ? null : new Date(Date.now() + retryDelay(sub.safepayBilling.workerAttempts)),
            'safepayBilling.workerAttempts': completed ? 0 : sub.safepayBilling.workerAttempts,
            'safepayBilling.workerLeaseToken': null, 'safepayBilling.workerLeaseUntil': null,
          } });
        }
      }
    } finally { running = false; }
  };
}
const runBillingWorker = createBillingWorker();
function startBillingWorker() {
  if (workerTimer || !safepayWorkersEnabled()) return;
  workerTimer = setInterval(() => runBillingWorker().catch(error => console.error('[safepay-billing] deferred:', error.code || 'BILLING_UNAVAILABLE')), 30000);
  workerTimer.unref?.();
  runBillingWorker().catch(() => {});
}
function stopBillingWorker() { if (workerTimer) clearInterval(workerTimer); workerTimer = null; }

module.exports = { cancel, resume, scheduleDowngrade, cancelDowngrade, queueRenewal, closeEndedSubscription,
  closeUnpaidRenewal, refreshStatus, createBillingWorker, runBillingWorker, startBillingWorker, stopBillingWorker };
