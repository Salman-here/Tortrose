'use strict';

const Product = require('../models/Product');
const SellerSubscription = require('../models/SellerSubscription');

const FEATURED_LIMITS = Object.freeze({ free_trial: 6, starter: 6, elite: 12 });
const TRIAL_PRODUCT_LIMIT = 15;

const withSession = (query, session) => (session ? query.session(session) : query);

const quotaError = (message, code, details) => {
  const error = new Error(message);
  error.code = code;
  error.status = 403;
  error.statusCode = 403;
  error.quota = details;
  return error;
};

async function getSellerProductCreationQuota(sellerId, { requestedCount = 1, session = null } = {}) {
  const requested = Number(requestedCount);
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new TypeError('requestedCount must be a positive safe integer.');
  }
  const subscription = await withSession(
    SellerSubscription.findOne({ seller: sellerId }).select('status').lean(),
    session,
  );
  if (!subscription || subscription.status !== 'trial') {
    return { allowed: true, current: 0, max: null, remaining: null, reason: null };
  }
  const current = await withSession(Product.countDocuments({ seller: sellerId }), session);
  const remaining = Math.max(0, TRIAL_PRODUCT_LIMIT - current);
  return {
    allowed: requested <= remaining,
    current,
    max: TRIAL_PRODUCT_LIMIT,
    remaining,
    reason: requested <= remaining ? null : 'trial_limit_reached',
  };
}

async function getSellerFeaturedProductQuota(sellerId, {
  excludeProductId = null,
  session = null,
} = {}) {
  const subscription = await withSession(
    SellerSubscription.findOne({ seller: sellerId }).lean(),
    session,
  );
  let plan = 'free_trial';
  let entitled = false;
  const now = new Date();

  if (!subscription || subscription.status === 'trial') {
    entitled = true;
  } else if (subscription.plan === 'elite' && ['active', 'free_period'].includes(subscription.status)) {
    plan = 'elite';
    entitled = true;
  } else if (['active', 'free_period'].includes(subscription.status)) {
    plan = subscription.plan || 'starter';
    entitled = true;
  } else if (
    subscription.bonusFeaturesActive
    && (!subscription.bonusExpiryDate || now < subscription.bonusExpiryDate)
  ) {
    plan = subscription.plan || 'starter';
    entitled = true;
  } else {
    plan = subscription.plan || 'free_trial';
  }

  if (!entitled) {
    return { allowed: false, current: 0, max: 0, plan, reason: 'not_entitled' };
  }
  const max = FEATURED_LIMITS[plan] || FEATURED_LIMITS.free_trial;
  // Count every reserved featured slot, including a temporarily moderated
  // listing. Otherwise sellers can feature hidden products concurrently and
  // exceed the plan when those listings become public later.
  const filter = { seller: sellerId, isFeatured: true };
  if (excludeProductId) filter._id = { $ne: excludeProductId };
  const current = await withSession(Product.countDocuments(filter), session);
  return {
    allowed: current < max,
    current,
    max,
    plan,
    reason: current < max ? null : 'limit_reached',
  };
}

async function assertSellerCanCreateProducts(sellerId, options = {}) {
  const quota = await getSellerProductCreationQuota(sellerId, options);
  if (!quota.allowed) {
    throw quotaError(
      `You have reached the maximum of ${quota.max} product listings during your free trial. Subscribe to add unlimited products.`,
      'TRIAL_PRODUCT_LIMIT_REACHED',
      quota,
    );
  }
  return quota;
}

async function assertSellerCanFeatureProduct(sellerId, options = {}) {
  const quota = await getSellerFeaturedProductQuota(sellerId, options);
  if (!quota.allowed) {
    const message = quota.reason === 'limit_reached'
      ? `You've reached your featured product limit (${quota.max}). Unfeature another product or upgrade your plan.`
      : 'Your current subscription does not allow featuring products right now.';
    throw quotaError(message, 'FEATURED_PRODUCT_LIMIT_REACHED', quota);
  }
  return quota;
}

module.exports = {
  FEATURED_LIMITS,
  TRIAL_PRODUCT_LIMIT,
  getSellerProductCreationQuota,
  getSellerFeaturedProductQuota,
  assertSellerCanCreateProducts,
  assertSellerCanFeatureProduct,
};
