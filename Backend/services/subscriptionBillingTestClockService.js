'use strict';
const mongoose = require('mongoose');
const Subscription = require('../models/SellerSubscription');
const Operation = require('../models/SafepayBillingOperation');
const Payment = require('../models/SafepayPayment');
const User = require('../models/User');
const policy = require('./subscriptionBillingTestPolicy');
const clone = value => JSON.parse(JSON.stringify(value));
const normalFields = ['status','plan','metaAdsIncluded','currentPeriodStart','currentPeriodEnd','freePeriodEndDate','cancelledAt'];
const billingFields = ['anchorAt','cycle','nextChargeAt','monthlyMinor','autoRenew'];

function eligible(sub, at = new Date()) {
  const b = sub?.safepayBilling;
  return sub?.billingProvider === 'safepay' && ['active','free_period'].includes(sub.status)
    && ['starter','elite'].includes(sub.plan) && b?.autoRenew && b.contractId && b.cardId
    && b.consentVersion === 'rozare-safepay-recurring-v1' && b.consentedAt && !b.endedAt
    && !sub.cancelledAt && !sub.pendingDowngrade?.toPlan && !sub.paymentRisk?.suspended
    && !b.pendingOperation && !b.lastFailedOperation && !b.recovery?.rootOperation && (!b.testClock || b.testClock.restoredAt)
    && Number.isSafeInteger(b.monthlyMinor) && b.monthlyMinor > 0
    && policy.timestamp(sub.currentPeriodEnd) > new Date(at).getTime();
}
function adopt(sub, window, at = new Date()) {
  policy.validateStamp(window);
  if (!eligible(sub, at)) return false;
  if (sub.safepayBilling.testClock?.id === window.id) return false;
  const b = sub.safepayBilling, intro = sub.status === 'free_period';
  const original = { subscription: Object.fromEntries(normalFields.map(key=>[key, sub[key] ?? null])),
    billing: Object.fromEntries(billingFields.map(key=>[key,b[key] ?? null])), contractId: b.contractId };
  const first = new Date(new Date(at).getTime() + (intro ? policy.introMinutes(window, sub.plan) : 20) * policy.MINUTE);
  b.testClock = { ...clone(window), origin:'operator', original: clone(original), adoptedAt: new Date(at), stoppedAt:null, restoredAt:null };
  sub.currentPeriodStart = new Date(at); sub.currentPeriodEnd = first;
  if (intro) sub.freePeriodEndDate = first;
  b.anchorAt = first; b.cycle = 0; b.nextChargeAt = first; b.monthlyMinor = 100; b.version += 1;
  b.workerNextAttemptAt = null; b.workerAttempts = 0;
  return true;
}
function stop(sub, at = new Date()) {
  const b = sub?.safepayBilling, clock = b?.testClock;
  if (!clock) return false;
  policy.validateStamp(clock);
  if (policy.authorized(clock, at) || clock.restoredAt || clock.finalizedAt || clock.stoppedAt && clock.origin !== 'operator') return false;
  const autoRenew = b.autoRenew, cancelledAt = sub.cancelledAt;
  b.autoRenew = false; b.nextChargeAt = null;
  if (b.recovery) b.recovery.nextRetryAt = null;
  b.testClock = { ...clock, stoppedAt: clock.stoppedAt || new Date(at) };
  if (b.pendingOperation) {
    if (clock.stoppedAt && clock.restoreBlockedByInFlight) return false;
    b.testClock.restoreBlockedByInFlight = true; b.version += 1; return true;
  }
  const original = clock.original;
  if (clock.origin === 'operator' && original?.contractId === b.contractId && original.subscription?.plan === sub.plan
    && Boolean(original.subscription?.metaAdsIncluded) === Boolean(sub.metaAdsIncluded) && !sub.paymentRisk?.suspended
    && !clock.restoreBlockedByInFlight && !sub.pendingDowngrade?.toPlan) {
    // Restore only the pre-test agreement, never a recalculated or higher price.
    // A cancelled subscription stays cancelled, and an overdue old invoice is
    // not collected as a catch-up charge when the QA window ends.
    if (!Number.isSafeInteger(original.billing?.monthlyMinor) || original.billing.monthlyMinor <= 0) throw Error('Invalid original billing snapshot');
    for (const field of normalFields) sub[field] = original.subscription[field] && ['currentPeriodStart','currentPeriodEnd','freePeriodEndDate','cancelledAt'].includes(field) ? new Date(original.subscription[field]) : original.subscription[field];
    for (const field of billingFields) b[field] = original.billing[field] && ['anchorAt','nextChargeAt'].includes(field) ? new Date(original.billing[field]) : original.billing[field];
    b.autoRenew = Boolean(autoRenew && !cancelledAt && original.billing.autoRenew && policy.timestamp(original.billing.nextChargeAt) > new Date(at).getTime());
    if (!b.autoRenew) { b.nextChargeAt = null; sub.cancelledAt = cancelledAt || new Date(at); }
    b.lastFailedOperation = null; b.lastFailureCode = '';
    b.recovery = { rootOperation:null, contractId:null, cycle:null, policyVersion:null, startedAt:null, cancelAt:null,
      attempts:0, nextRetryAt:null, lastFailureAt:null, cancelledAt:null };
    b.testClock = { ...b.testClock, restoredAt:new Date(at) };
  } else {
    // Newly accepted $1 test agreements never silently become full-price plans.
    sub.cancelledAt = cancelledAt || new Date(at);
    sub.pendingDowngrade = { toPlan:null };
    b.testClock.finalizedAt = new Date(at);
    if (policy.timestamp(original?.subscription?.currentPeriodEnd) > policy.timestamp(sub.currentPeriodEnd)) {
      sub.currentPeriodEnd = new Date(original.subscription.currentPeriodEnd);
    }
  }
  b.version += 1; b.workerNextAttemptAt = null; b.workerAttempts = 0;
  return true;
}

async function reconcileOne(subscriptionId, environment, at = new Date()) {
  let changed = false;
  const window = policy.readWindow(process.env, at);
  await mongoose.connection.transaction(async session => {
    const sub = await Subscription.findOne({ _id:subscriptionId, billingProvider:'safepay', 'safepayBilling.environment':environment })
      .select('+safepayBilling.cardId +safepayBilling.workerLeaseToken').session(session);
    if (!sub) return;
    if (sub.safepayBilling.testClock && !policy.authorized(sub.safepayBilling.testClock, at)) {
      const pending = sub.safepayBilling.pendingOperation;
      if (pending) {
        const op = await Operation.findById(pending).session(session);
        const payment = op?.payment && await Payment.findById(op.payment).session(session);
        if (op?.terms?.billingTest && payment?.status === 'ready' && !payment.chargeStartedAt && !payment.appliedAt) {
          payment.status='cancelled'; payment.cancelledAt=at; op.status='cancelled';
          await payment.save({session}); await op.save({session}); sub.safepayBilling.pendingOperation=null;
        }
      }
      changed = stop(sub, at);
    }
    if (window && eligible(sub, at)) {
      const owner = await User.findOne({_id:sub.seller,role:'seller',status:'active'}).select('_id').session(session);
      if (owner) changed = adopt(sub, window, at) || changed;
    }
    if (changed) { sub.markModified('safepayBilling.testClock'); await sub.save({session}); }
  },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'}});
  return changed;
}
async function reconcileWindow(environment, at = new Date()) {
  const window = policy.readWindow(process.env, at);
  const candidates = Subscription.find({billingProvider:'safepay','safepayBilling.environment':environment,
    $or:[{'safepayBilling.testClock':{$ne:null}},...(window?[{status:{$in:['active','free_period']},'safepayBilling.autoRenew':true}]:[])]})
    .select('_id').sort({_id:1}).cursor({batchSize:50});
  for await(const sub of candidates) await reconcileOne(sub._id,environment,at);
}
module.exports={eligible,adopt,stop,reconcileOne,reconcileWindow};
