'use strict';

const { buildPlanPricing, getPricingCatalog } = require('./subscriptionPricingService');
const { FEATURED_LIMITS, TRIAL_PRODUCT_LIMIT } = require('./sellerProductQuotaService');
const { FOUNDER_PROMOTION } = require('./founderPromotionService');

const TRIAL_DAYS = 15;
const STARTER_BONUS_MONTHS = 6;
const BONUS_GRACE_DAYS = 3;

const SUBSCRIPTION_FEATURES = Object.freeze({
  trial: Object.freeze([
    'Store and products visible to all customers',
    `Up to ${TRIAL_PRODUCT_LIMIT} product listings during the free trial`,
    'Secure payment processing',
    'Custom subdomain for your store',
    'Order management and customer insights',
    'Unlimited seller AI chat',
    'Manage your store, orders and products from WhatsApp by chatting with AI',
    'WhatsApp notifications for new orders',
    'Rozare WhatsApp order confirmation automation',
    `Featured product highlighting (${FEATURED_LIMITS.free_trial} products)`,
  ]),
  starter: Object.freeze([
    'Store and products visible to all customers',
    'Unlimited product listings',
    'Secure payment processing',
    'Custom subdomain for your store',
    'Order management and customer insights',
    'Unlimited seller AI chat',
    'Manage your store, orders and products from WhatsApp by chatting with AI',
    'WhatsApp notifications for new orders',
    'Rozare WhatsApp order confirmation automation',
    `Featured product highlighting (${FEATURED_LIMITS.starter} products)`,
  ]),
  bonus: Object.freeze([
    'Smart description generator with AI',
    'Advanced analytics and growth insights',
    'Smart tag AI generator for products',
    'Priority support and early access to new features',
    'Coupon and discount management system',
    'Bulk discount and promotional tools',
  ]),
  eliteOnly: Object.freeze([
    'Rozare-run TikTok ads for your store and featured products',
    'Customizable store themes with your own colors and layouts',
  ]),
});

const cloneFeatures = () => Object.fromEntries(
  Object.entries(SUBSCRIPTION_FEATURES).map(([key, values]) => [key, [...values]]),
);

function getSubscriptionCatalog() {
  return {
    schemaVersion: 1,
    pricing: getPricingCatalog(),
    trial: {
      days: TRIAL_DAYS,
      productListingLimit: TRIAL_PRODUCT_LIMIT,
      featuredProductLimit: FEATURED_LIMITS.free_trial,
      creditCardRequired: false,
      includesStarterFeatures: true,
      includesBonusFeatures: true,
    },
    starter: {
      productListingLimit: null,
      featuredProductLimit: FEATURED_LIMITS.starter,
      bonusFeaturesMonths: STARTER_BONUS_MONTHS,
      bonusPeriodIsOneTime: true,
    },
    elite: {
      productListingLimit: null,
      featuredProductLimit: FEATURED_LIMITS.elite,
      bonusFeaturesPermanent: true,
    },
    bonusGraceDays: BONUS_GRACE_DAYS,
    founderPromotion: {
      code: FOUNDER_PROMOTION.code,
      discountPercent: FOUNDER_PROMOTION.discountPercent,
      maxRedemptions: FOUNDER_PROMOTION.maxRedemptions,
      checkoutReservationMinutes: FOUNDER_PROMOTION.checkoutReservationMinutes,
      claimTiming: 'stripe_checkout_completed',
      entitlementPersistence: 'while_subscription_remains_uninterrupted',
    },
    features: cloneFeatures(),
    billing: {
      checkoutProvider: 'Stripe',
      upgradeTiming: 'immediate',
      downgradeTiming: 'period_end',
      cancellationTiming: 'period_end',
      planChangesMayProrate: true,
      introductoryPeriodIsOneTime: true,
    },
    afterAccessEnds: {
      publicStoreVisible: false,
      productsVisible: false,
      sellerDashboardAccessible: true,
      sellerDataPreserved: true,
    },
  };
}

const validDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

const remainingCalendarDays = (value, now = new Date()) => {
  const end = validDate(value);
  if (!end) return 0;
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86400000));
};

const isoDate = value => validDate(value)?.toISOString() || null;

function buildSubscriptionStatusPresentation(subscription, {
  founderPromotion = null,
  founderDiscountPercent = null,
  now = new Date(),
} = {}) {
  if (!subscription) return null;

  const status = subscription.status;
  const plan = subscription.plan;
  const trialStartDate = validDate(subscription.trialStartDate);
  const trialEndDate = validDate(subscription.trialEndDate)
    || (trialStartDate
      ? new Date(trialStartDate.getTime() + TRIAL_DAYS * 86400000)
      : null);
  const trialDaysRemaining = status === 'trial'
    ? remainingCalendarDays(trialEndDate, now)
    : 0;
  const bonusGraceDeadline = validDate(subscription.bonusGraceDeadline);
  const hasGracePeriod = status === 'blocked'
    && bonusGraceDeadline
    && bonusGraceDeadline > now
    && !subscription.bonusFeaturesExpiredPermanently;
  const hasRecurringPlan = ['active', 'free_period', 'past_due'].includes(status)
    && ['starter', 'elite'].includes(plan);
  const currentPricing = hasRecurringPlan
    ? buildPlanPricing(
      plan,
      Boolean(subscription.metaAdsIncluded),
      Boolean(subscription.founderOffer?.active),
    )
    : null;

  return {
    status,
    plan,
    planName: status === 'trial' || plan === 'free_trial'
      ? 'Rozare Free Trial'
      : subscription.planName || (plan === 'elite' ? 'Rozare Elite' : 'Rozare Starter'),
    trialStartDate,
    trialEndDate,
    trialDaysRemaining,
    isTrialExpiringSoon: status === 'trial' && trialDaysRemaining > 0 && trialDaysRemaining <= 3,
    isBlocked: status === 'blocked',
    subscribedAt: subscription.subscribedAt || null,
    freePeriodEndDate: subscription.freePeriodEndDate || null,
    currentPeriodStart: subscription.currentPeriodStart || null,
    currentPeriodEnd: subscription.currentPeriodEnd || null,
    aiMessageLimit: -1,
    aiMessagesUnlimited: true,
    metaAdsIncluded: Boolean(subscription.metaAdsIncluded),
    metaAdsAddonCents: getPricingCatalog().metaAdsAddonCents,
    currentMonthlyAmountCents: currentPricing?.unitAmount ?? null,
    cancelledAt: subscription.cancelledAt || null,
    blockedReason: subscription.blockedReason || null,
    bonusFeaturesActive: Boolean(subscription.bonusFeaturesActive),
    bonusExpiryDate: subscription.bonusExpiryDate || null,
    bonusFeaturesExpiredPermanently: Boolean(subscription.bonusFeaturesExpiredPermanently),
    starterBonusPeriodUsed: Boolean(subscription.starterBonusPeriodUsed),
    bonusGraceDeadline: bonusGraceDeadline || null,
    bonusGraceDaysRemaining: hasGracePeriod
      ? remainingCalendarDays(bonusGraceDeadline, now)
      : 0,
    pendingDowngrade: subscription.pendingDowngrade?.toPlan || null,
    hasUsedFreePeriod: Boolean(subscription.hasUsedFreePeriod),
    pricing: getPricingCatalog(),
    catalog: getSubscriptionCatalog(),
    founderOffer: {
      active: Boolean(subscription.founderOffer?.active),
      code: subscription.founderOffer?.code || null,
      discountPercent: Number.isSafeInteger(founderDiscountPercent)
        ? founderDiscountPercent
        : null,
      claimedAt: subscription.founderOffer?.claimedAt || null,
      forfeitedAt: subscription.founderOffer?.forfeitedAt || null,
      source: subscription.founderOffer?.source || null,
    },
    founderPromotion,
  };
}

function buildSubscriptionStatusMessage(subscription) {
  if (!subscription) return 'No subscription was found for this seller.';
  const parts = [`Current subscription: ${subscription.planName} (${subscription.status}).`];
  if (subscription.status === 'trial') {
    parts.push(`${subscription.trialDaysRemaining} trial day${subscription.trialDaysRemaining === 1 ? '' : 's'} remaining${isoDate(subscription.trialEndDate) ? `, through ${isoDate(subscription.trialEndDate)}` : ''}.`);
  }
  if (subscription.status === 'free_period') {
    parts.push(`The one-time introductory period is active${isoDate(subscription.freePeriodEndDate) ? ` through ${isoDate(subscription.freePeriodEndDate)}` : ''}.`);
  } else {
    parts.push(subscription.hasUsedFreePeriod
      ? 'The one-time introductory period has already been used.'
      : 'The account remains eligible for its one-time introductory period.');
  }
  if (Number.isSafeInteger(subscription.currentMonthlyAmountCents)) {
    const cents = BigInt(subscription.currentMonthlyAmountCents);
    const amount = `$${cents / 100n}.${String(cents % 100n).padStart(2, '0')} USD per month`;
    parts.push(subscription.status === 'free_period'
      ? `Recurring price after the introductory period: ${amount}${subscription.metaAdsIncluded ? ', including the Meta ads add-on' : ''}.`
      : `Current recurring price: ${amount}${subscription.metaAdsIncluded ? ', including the Meta ads add-on' : ''}.`);
    parts.push(`Meta ads add-on: ${subscription.metaAdsIncluded ? 'included' : 'not included'}.`);
  }
  if (subscription.cancelledAt) {
    parts.push(`Cancellation is scheduled for the end of the current period${isoDate(subscription.currentPeriodEnd) ? ` on ${isoDate(subscription.currentPeriodEnd)}` : ''}.`);
  } else if (isoDate(subscription.currentPeriodEnd)) {
    parts.push(`The current billing period ends on ${isoDate(subscription.currentPeriodEnd)}.`);
  }
  if (subscription.pendingDowngrade) parts.push(`A switch to ${subscription.pendingDowngrade} is scheduled for period end.`);
  if (subscription.bonusFeaturesExpiredPermanently) {
    parts.push('Starter bonus features have expired permanently for this account; Elite restores them while active.');
  } else if (subscription.bonusFeaturesActive) {
    parts.push(subscription.isBlocked
      ? `Unused Starter bonus time is preserved during the grace period but is unavailable until the seller re-subscribes${isoDate(subscription.bonusExpiryDate) ? `; its saved expiry is ${isoDate(subscription.bonusExpiryDate)}` : ''}.`
      : `Starter bonus features are active${isoDate(subscription.bonusExpiryDate) ? ` through ${isoDate(subscription.bonusExpiryDate)}` : ''}.`);
  }
  if (subscription.bonusGraceDaysRemaining > 0) {
    parts.push(`${subscription.bonusGraceDaysRemaining} day${subscription.bonusGraceDaysRemaining === 1 ? '' : 's'} remain in the Starter bonus re-subscription grace period.`);
  }
  if (subscription.founderOffer?.active) {
    parts.push(`${subscription.founderOffer.code || 'Founder'} pricing${Number.isSafeInteger(subscription.founderOffer.discountPercent) ? ` at an extra ${subscription.founderOffer.discountPercent}% discount` : ''} is locked while this subscription remains uninterrupted.`);
  } else if (subscription.founderPromotion?.forfeited) {
    parts.push('Founder pricing was forfeited and cannot be reclaimed for this account.');
  } else if (subscription.founderPromotion?.sellerEligible) {
    parts.push(subscription.founderPromotion.available
      ? `${subscription.founderPromotion.code} is currently available to this seller; ${subscription.founderPromotion.remaining} of ${subscription.founderPromotion.maxRedemptions} places remain.`
      : `${subscription.founderPromotion.code} is not currently available because all places are allocated.`);
  }
  if (subscription.isBlocked && subscription.blockedReason) parts.push(subscription.blockedReason);
  return parts.join(' ');
}

module.exports = {
  BONUS_GRACE_DAYS,
  STARTER_BONUS_MONTHS,
  SUBSCRIPTION_FEATURES,
  TRIAL_DAYS,
  buildSubscriptionStatusMessage,
  buildSubscriptionStatusPresentation,
  getSubscriptionCatalog,
  remainingCalendarDays,
};
