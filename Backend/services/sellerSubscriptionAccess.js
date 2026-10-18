'use strict';

const { hasGraceAccess } = require('./safepayRenewalPolicy');
const timestamp = value => value ? new Date(value).getTime() : NaN;

function hasSellerPlanAccess(sub, { now = new Date(), allowLegacyPastDue = false } = {}) {
  if (!sub || sub.paymentRisk?.suspended) return false;
  if (sub.status === 'trial') {
    const end = sub.trialEndDate || (sub.trialStartDate
      ? new Date(timestamp(sub.trialStartDate) + 15 * 86400000) : null);
    return end ? timestamp(now) < timestamp(end) : true;
  }
  if (!['active', 'free_period'].includes(sub.status)) {
    return allowLegacyPastDue && sub.billingProvider !== 'safepay' && sub.status === 'past_due';
  }
  if (sub.billingProvider !== 'safepay') return true;
  // Preserved bonus time is not a payment entitlement. Safepay access ends at
  // the funded period or the exact unpaid-renewal deadline, even if a worker
  // has not yet changed the stored subscription status.
  return timestamp(now) < timestamp(sub.currentPeriodEnd) || hasGraceAccess(sub, now);
}

function hasSellerBonusAccess(sub, { now = new Date() } = {}) {
  if (!hasSellerPlanAccess(sub, { now })) return false;
  if (sub.status === 'trial' || sub.plan === 'elite') return true;
  return Boolean(sub.bonusFeaturesActive && !sub.bonusFeaturesExpiredPermanently
    && (!sub.bonusExpiryDate || timestamp(now) < timestamp(sub.bonusExpiryDate)));
}

module.exports = { hasSellerPlanAccess, hasSellerBonusAccess };
