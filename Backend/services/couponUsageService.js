'use strict';

const mongoose = require('mongoose');
const Coupon = require('../models/Coupon');
const CouponRedemption = require('../models/CouponRedemption');
const Order = require('../models/Order');
const { validateAndPriceCoupons } = require('./checkoutPricingService');
const { couponTermsFingerprint } = require('./couponTermsService');
const { isSupportedCurrency, normalizeCurrency } = require('./currencyService');
const { roundMoney } = require('./moneyMath');
const { restoreOrderInventory } = require('./orderInventoryService');

const COUPON_USAGE_VERSION = 1;

const toId = value => value?._id?.toString?.() || value?.toString?.() || '';
const usageError = (message, code, statusCode = 409) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const persistedCouponError = label => usageError(
  `Stored ${label} is invalid.`,
  'COUPON_RESERVATION_INVALID',
);

const requireExactCouponMoney = (value, label, { positive = false } = {}) => {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || (positive && value <= 0)
  ) throw persistedCouponError(label);
  try {
    if (roundMoney(value) !== value) throw persistedCouponError(label);
  } catch (error) {
    if (error?.code === 'COUPON_RESERVATION_INVALID') throw error;
    throw persistedCouponError(label);
  }
  return value;
};

const requireCouponRate = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100) {
    throw persistedCouponError(label);
  }
  try {
    if (roundMoney(value, 6) !== value) throw persistedCouponError(label);
  } catch (error) {
    if (error?.code === 'COUPON_RESERVATION_INVALID') throw error;
    throw persistedCouponError(label);
  }
  return value;
};

const requireCanonicalCouponCurrency = (value, label) => {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value !== value.toUpperCase()
    || !isSupportedCurrency(value)
  ) throw persistedCouponError(label);
  return normalizeCurrency(value);
};

const requireCouponUsageVersion = order => {
  const version = order?.couponUsageVersion;
  if (version === null || version === undefined || version === 0) return 0;
  if (typeof version !== 'number' || version !== COUPON_USAGE_VERSION) {
    throw usageError('Coupon reservation version is malformed.', 'COUPON_RESERVATION_CONFLICT');
  }
  return version;
};

const requireUsageCount = (value, label, { minimum = 0 } = {}) => {
  if (!Number.isSafeInteger(value) || value < minimum) throw persistedCouponError(label);
  return value;
};

const incrementUsageCount = (value, label) => {
  const next = requireUsageCount(value, label) + 1;
  if (!Number.isSafeInteger(next)) throw persistedCouponError(label);
  return next;
};

const runInTransaction = async (work, existingSession = null) => {
  if (existingSession) return work(existingSession);
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = await work(session);
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
    return result;
  } finally {
    await session.endSession();
  }
};

const sortedAppliedCoupons = order => [...(order?.appliedCoupons || [])]
  .sort((left, right) => toId(left?.couponId).localeCompare(toId(right?.couponId)));

const canonicalAppliedCoupon = coupon => {
  const couponId = toId(coupon?.couponId);
  const seller = toId(coupon?.seller);
  const code = coupon?.code;
  const discountType = coupon?.discountType;
  const productIds = Array.isArray(coupon?.applicableProductIds)
    ? coupon.applicableProductIds.map(toId)
    : null;
  const fingerprint = coupon?.couponTermsFingerprint;
  if (
    !mongoose.isValidObjectId(couponId)
    || !mongoose.isValidObjectId(seller)
    || typeof code !== 'string'
    || code !== code.trim()
    || code !== code.toUpperCase()
    || !/^[A-Z0-9_-]{3,32}$/.test(code)
    || !['percentage', 'fixed'].includes(discountType)
    || !productIds
    || !productIds.length
    || productIds.some(id => !mongoose.isValidObjectId(id))
    || new Set(productIds).size !== productIds.length
    || typeof fingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(fingerprint)
  ) throw persistedCouponError('applied coupon snapshot');

  const discountValue = discountType === 'percentage'
    ? requireCouponRate(coupon.discountValue, 'applied coupon percentage')
    : requireExactCouponMoney(coupon.discountValue, 'applied coupon value', { positive: true });
  const sourceDiscountValue = discountType === 'percentage'
    ? requireCouponRate(coupon.sourceDiscountValue, 'applied coupon source percentage')
    : requireExactCouponMoney(coupon.sourceDiscountValue, 'applied coupon source value', { positive: true });

  return {
    couponId,
    seller,
    code,
    discountType,
    discountValue,
    appliedDiscountAmount: requireExactCouponMoney(
      coupon.appliedDiscountAmount,
      'applied coupon discount',
      { positive: true },
    ),
    currency: requireCanonicalCouponCurrency(coupon.currency, 'applied coupon currency'),
    sourceDiscountValue,
    sourceCurrency: requireCanonicalCouponCurrency(
      coupon.sourceCurrency,
      'applied coupon source currency',
    ),
    applicableProductIds: [...productIds].sort(),
    couponTermsFingerprint: fingerprint,
  };
};

const assertPersistedPricingMatches = (order, repriced) => {
  const persisted = sortedAppliedCoupons(order).map(canonicalAppliedCoupon);
  const current = [...(repriced?.appliedCoupons || [])]
    .sort((left, right) => toId(left?.couponId).localeCompare(toId(right?.couponId)))
    .map(canonicalAppliedCoupon);
  if (
    JSON.stringify(persisted) !== JSON.stringify(current)
    || requireExactCouponMoney(order?.orderSummary?.couponDiscount, 'order coupon discount')
      !== requireExactCouponMoney(repriced?.couponDiscount, 'repriced coupon discount')
  ) {
    throw usageError(
      'A coupon changed while checkout was being prepared. Refresh checkout and apply it again.',
      'COUPON_TERMS_CHANGED',
    );
  }
};

const assertAuthenticatedCouponBuyer = (order, requestedUserId) => {
  const orderUserId = toId(order?.user);
  if (!orderUserId) {
    throw usageError('Log in before applying a coupon.', 'COUPON_LOGIN_REQUIRED', 400);
  }
  if (requestedUserId && orderUserId !== toId(requestedUserId)) {
    throw usageError('Coupon reservation does not belong to this buyer.', 'COUPON_BUYER_MISMATCH', 403);
  }
  return orderUserId;
};

const redemptionMatches = (redemption, appliedCoupon, userId) => (
  toId(redemption?.coupon) === toId(appliedCoupon?.couponId)
  && toId(redemption?.user) === toId(userId)
  && redemption?.couponTermsFingerprint === appliedCoupon?.couponTermsFingerprint
  && ['reserved', 'consumed'].includes(redemption?.status)
);

const normalizeUsedBy = coupon => {
  if (!Array.isArray(coupon?.usedBy)) throw persistedCouponError('coupon usage history');
  const byUser = new Map();
  for (const entry of coupon.usedBy) {
    const id = toId(entry?.user);
    const count = requireUsageCount(entry?.count, 'coupon per-user usage count', { minimum: 1 });
    if (!id || !mongoose.isValidObjectId(id)) throw persistedCouponError('coupon usage owner');
    const current = byUser.get(id);
    if (current) {
      const combined = current.count + count;
      if (!Number.isSafeInteger(combined)) throw persistedCouponError('coupon per-user usage count');
      current.count = combined;
    }
    else byUser.set(id, { user: entry.user, count });
  }
  coupon.usedBy = [...byUser.values()];
};

const incrementCouponUsage = async (coupon, userId, session) => {
  normalizeUsedBy(coupon);
  const usedCount = requireUsageCount(coupon.usedCount, 'coupon used count');
  const maxUses = coupon.maxUses === null || coupon.maxUses === undefined
    ? null
    : requireUsageCount(coupon.maxUses, 'coupon maximum uses', { minimum: 1 });
  if (maxUses !== null && usedCount >= maxUses) {
    throw usageError(`Coupon ${coupon.code} has reached its usage limit.`, 'COUPON_USAGE_LIMIT');
  }

  const existingUser = (coupon.usedBy || []).find(entry => toId(entry.user) === toId(userId));
  const maxUsesPerUser = requireUsageCount(
    coupon.maxUsesPerUser,
    'coupon per-user maximum uses',
    { minimum: 1 },
  );
  if (existingUser && requireUsageCount(
    existingUser.count,
    'coupon per-user usage count',
    { minimum: 1 },
  ) >= maxUsesPerUser) {
    throw usageError(
      `Coupon ${coupon.code} has already been used the maximum number of times.`,
      'COUPON_USER_LIMIT',
    );
  }

  coupon.usedCount = incrementUsageCount(usedCount, 'coupon used count');
  if (existingUser) existingUser.count = incrementUsageCount(
    requireUsageCount(existingUser.count, 'coupon per-user usage count', { minimum: 1 }),
    'coupon per-user usage count',
  );
  else coupon.usedBy.push({ user: userId, count: 1 });
  await coupon.save({ session });
};

const decrementCouponUsage = async (couponId, userId, session) => {
  const coupon = await Coupon.findById(couponId).session(session);
  if (!coupon) return;
  normalizeUsedBy(coupon);
  coupon.usedCount = Math.max(0, requireUsageCount(coupon.usedCount, 'coupon used count') - 1);
  const index = (coupon.usedBy || []).findIndex(entry => toId(entry.user) === toId(userId));
  if (index >= 0) {
    const nextCount = Math.max(0, requireUsageCount(
      coupon.usedBy[index].count,
      'coupon per-user usage count',
      { minimum: 1 },
    ) - 1);
    if (nextCount === 0) coupon.usedBy.splice(index, 1);
    else coupon.usedBy[index].count = nextCount;
  }
  await coupon.save({ session });
};

const reserveOrderCoupons = async ({ orderId, userId = null, at = new Date(), session = null }) => (
  runInTransaction(async transactionSession => {
    const order = await Order.findById(orderId).session(transactionSession);
    if (!order) throw usageError('Order not found for coupon reservation.', 'COUPON_ORDER_NOT_FOUND', 404);
    const appliedCoupons = sortedAppliedCoupons(order);
    if (!appliedCoupons.length) return { reserved: 0, reused: false, order };
    const buyerId = assertAuthenticatedCouponBuyer(order, userId);

    const couponIds = appliedCoupons.map(coupon => toId(coupon.couponId));
    if (couponIds.some(id => !mongoose.isValidObjectId(id)) || new Set(couponIds).size !== couponIds.length) {
      throw usageError('Order contains an invalid or duplicate coupon.', 'COUPON_RESERVATION_INVALID', 400);
    }

    const existing = await CouponRedemption.find({ order: order._id })
      .sort({ coupon: 1 })
      .session(transactionSession);
    if (existing.length) {
      if (
        existing.length !== appliedCoupons.length
        || appliedCoupons.some(applied => !existing.some(redemption => redemptionMatches(redemption, applied, buyerId)))
      ) {
        throw usageError('Coupon reservation state is inconsistent.', 'COUPON_RESERVATION_CONFLICT');
      }
      return { reserved: existing.filter(entry => entry.status === 'reserved').length, reused: true, order };
    }
    if (requireCouponUsageVersion(order) >= COUPON_USAGE_VERSION) {
      throw usageError('Coupon reservation state is missing.', 'COUPON_RESERVATION_CONFLICT');
    }

    const ratesDocument = order.exchangeRateSnapshot?.rates;
    const exchangeRates = ratesDocument?.toObject
      ? ratesDocument.toObject()
      : (ratesDocument || null);
    const repriced = await validateAndPriceCoupons({
      requestedCoupons: appliedCoupons,
      orderItems: order.orderItems,
      userId: buyerId,
      orderCurrency: order.currency,
      exchangeRates,
      exchangeRatesFallback: order.exchangeRateSnapshot?.fallback === true,
      at,
      session: transactionSession,
    });
    assertPersistedPricingMatches(order, repriced);

    for (const appliedCoupon of sortedAppliedCoupons({ appliedCoupons: repriced.appliedCoupons })) {
      const coupon = await Coupon.findById(appliedCoupon.couponId).session(transactionSession);
      if (!coupon || couponTermsFingerprint(coupon) !== appliedCoupon.couponTermsFingerprint) {
        throw usageError(
          'A coupon changed while checkout was being prepared. Refresh checkout and apply it again.',
          'COUPON_TERMS_CHANGED',
        );
      }
      await incrementCouponUsage(coupon, buyerId, transactionSession);
      await new CouponRedemption({
        coupon: coupon._id,
        order: order._id,
        user: buyerId,
        status: 'reserved',
        couponTermsFingerprint: appliedCoupon.couponTermsFingerprint,
        couponCode: appliedCoupon.code,
        appliedDiscountAmount: appliedCoupon.appliedDiscountAmount,
        currency: appliedCoupon.currency,
        reservedAt: at,
      }).save({ session: transactionSession });
    }

    order.couponUsageVersion = COUPON_USAGE_VERSION;
    await order.save({ session: transactionSession });
    return { reserved: appliedCoupons.length, reused: false, order };
  }, session)
);

const consumeLegacyOrderCoupons = async (order, buyerId, session, at) => {
  // Already-charged orders created before version 1 must never have their
  // successful payment rejected because coupon capacity changed meanwhile.
  // Record those historical uses exactly once, even if that takes a legacy
  // coupon beyond its configured cap.
  for (const appliedCoupon of sortedAppliedCoupons(order)) {
    const existing = await CouponRedemption.findOne({
      order: order._id,
      coupon: appliedCoupon.couponId,
    }).session(session);
    if (existing) continue;
    const coupon = await Coupon.findById(appliedCoupon.couponId).session(session);
    const fingerprint = appliedCoupon.couponTermsFingerprint
      || couponTermsFingerprint(coupon || {
        _id: appliedCoupon.couponId,
        code: appliedCoupon.code,
        discountType: appliedCoupon.discountType,
        discountValue: appliedCoupon.sourceDiscountValue,
        currency: appliedCoupon.sourceCurrency,
      });
    if (coupon) {
      normalizeUsedBy(coupon);
      coupon.usedCount = incrementUsageCount(coupon.usedCount, 'coupon used count');
      const existingUser = (coupon.usedBy || []).find(entry => toId(entry.user) === buyerId);
      if (existingUser) existingUser.count = incrementUsageCount(
        requireUsageCount(existingUser.count, 'coupon per-user usage count', { minimum: 1 }),
        'coupon per-user usage count',
      );
      else coupon.usedBy.push({ user: buyerId, count: 1 });
      await coupon.save({ session });
    }
    await new CouponRedemption({
      coupon: appliedCoupon.couponId,
      order: order._id,
      user: buyerId,
      status: 'consumed',
      couponTermsFingerprint: fingerprint,
      couponCode: appliedCoupon.code || coupon?.code || 'LEGACY',
      appliedDiscountAmount: requireExactCouponMoney(
        appliedCoupon.appliedDiscountAmount,
        'legacy applied coupon discount',
        { positive: true },
      ),
      currency: requireCanonicalCouponCurrency(
        appliedCoupon.currency ?? order.currency,
        'legacy applied coupon currency',
      ),
      reservedAt: order.createdAt || at,
      consumedAt: at,
    }).save({ session });
  }
  order.couponUsageVersion = COUPON_USAGE_VERSION;
  await order.save({ session });
};

const consumeOrderCoupons = async ({ orderId, session = null, at = new Date() }) => (
  runInTransaction(async transactionSession => {
    const order = await Order.findById(orderId).session(transactionSession);
    if (!order) throw usageError('Order not found for coupon consumption.', 'COUPON_ORDER_NOT_FOUND', 404);
    const appliedCoupons = sortedAppliedCoupons(order);
    if (!appliedCoupons.length) return { consumed: 0, reused: false, order };
    const buyerId = assertAuthenticatedCouponBuyer(order, null);

    if (requireCouponUsageVersion(order) < COUPON_USAGE_VERSION) {
      await consumeLegacyOrderCoupons(order, buyerId, transactionSession, at);
      return { consumed: appliedCoupons.length, reused: false, legacy: true, order };
    }

    const redemptions = await CouponRedemption.find({ order: order._id })
      .sort({ coupon: 1 })
      .session(transactionSession);
    if (
      redemptions.length !== appliedCoupons.length
      || appliedCoupons.some(applied => !redemptions.some(redemption => (
        toId(redemption.coupon) === toId(applied.couponId)
        && toId(redemption.user) === buyerId
        && redemption.couponTermsFingerprint === applied.couponTermsFingerprint
      )))
    ) {
      throw usageError('Coupon reservation state is inconsistent.', 'COUPON_RESERVATION_CONFLICT');
    }
    if (redemptions.some(redemption => redemption.status === 'released')) {
      throw usageError('A released coupon reservation cannot be consumed.', 'COUPON_RESERVATION_RELEASED');
    }

    let consumed = 0;
    for (const redemption of redemptions) {
      if (redemption.status === 'consumed') continue;
      redemption.status = 'consumed';
      redemption.consumedAt = at;
      await redemption.save({ session: transactionSession });
      consumed += 1;
    }
    return { consumed, reused: consumed === 0, order };
  }, session)
);

const releaseOrderCouponsInSession = async (order, session, reason, at = new Date()) => {
  const redemptions = await CouponRedemption.find({ order: order._id, status: 'reserved' })
    .sort({ coupon: 1 })
    .session(session);
  for (const redemption of redemptions) {
    await decrementCouponUsage(redemption.coupon, redemption.user, session);
    redemption.status = 'released';
    redemption.releasedAt = at;
    redemption.releaseReason = String(reason || 'Checkout was closed before payment.').slice(0, 500);
    await redemption.save({ session });
  }
  return redemptions.length;
};

const releaseOrderCoupons = async ({ orderId, reason = '', session = null, at = new Date() }) => (
  runInTransaction(async transactionSession => {
    const order = await Order.findById(orderId).session(transactionSession);
    if (!order) return { released: 0, missingOrder: true };
    if (order.isPaid || !order.awaitingPayment) {
      throw usageError('Coupons cannot be released from a completed order.', 'COUPON_RELEASE_NOT_ALLOWED');
    }
    const released = await releaseOrderCouponsInSession(order, transactionSession, reason, at);
    return { released, reused: released === 0, order };
  }, session)
);

const deleteUnpaidOrderAndReleaseCoupons = async ({
  orderId,
  reason = '',
  requireAwaitingPayment = false,
  match = {},
  session = null,
}) => runInTransaction(async transactionSession => {
  const allowedMatchFields = new Set([
    'awaitingPayment',
    'inventoryCommitted',
    'orderStatus',
    'paymentSetupState',
    'stripeSessionId',
    'stripePaymentIntentId',
  ]);
  const safeMatch = Object.fromEntries(
    Object.entries(match || {}).filter(([key]) => allowedMatchFields.has(key)),
  );
  // Never delete an order after the signed Stripe webhook has claimed it for
  // fulfillment. `{ field: null }` also matches legacy documents where the
  // lease field does not exist.
  const filter = {
    _id: orderId,
    isPaid: false,
    ...safeMatch,
    paymentProcessingStartedAt: null,
  };
  if (requireAwaitingPayment) filter.awaitingPayment = true;
  const order = await Order.findOne(filter).session(transactionSession);
  if (!order) return { deleted: false, released: 0 };
  await restoreOrderInventory(order._id, { session: transactionSession });
  const released = await releaseOrderCouponsInSession(order, transactionSession, reason);
  // Inventory restoration intentionally changes `inventoryCommitted`, so the
  // caller's initial match must not be reused for the final delete. Keep only
  // lifecycle guards that remain true throughout cleanup. MongoDB transaction
  // conflicts protect concurrent payment/setup writes between read and delete.
  const deletion = await Order.deleteOne({
    _id: order._id,
    isPaid: false,
    paymentProcessingStartedAt: null,
    ...(requireAwaitingPayment ? { awaitingPayment: true } : {}),
  }).session(transactionSession);
  if (deletion.deletedCount !== 1) {
    throw usageError('Order changed while its checkout was being closed.', 'ORDER_DELETE_CONFLICT');
  }
  return { deleted: true, released };
}, session);

const deleteCouponIfUnreserved = async ({ couponId, sellerId, session = null }) => (
  runInTransaction(async transactionSession => {
    const coupon = await Coupon.findOne({ _id: couponId, seller: sellerId }).session(transactionSession);
    if (!coupon) return { deleted: false, notFound: true, coupon: null };
    const activeReservations = await CouponRedemption.countDocuments({
      coupon: coupon._id,
      status: 'reserved',
    }).session(transactionSession);
    if (activeReservations > 0) {
      throw usageError(
        'This coupon is reserved by a pending checkout. Deactivate it now and delete it after those payment attempts close.',
        'COUPON_HAS_ACTIVE_RESERVATIONS',
      );
    }
    const deletion = await Coupon.deleteOne({ _id: coupon._id, seller: sellerId }).session(transactionSession);
    return { deleted: deletion.deletedCount === 1, notFound: false, coupon };
  }, session)
);

module.exports = {
  COUPON_USAGE_VERSION,
  reserveOrderCoupons,
  consumeOrderCoupons,
  releaseOrderCoupons,
  deleteUnpaidOrderAndReleaseCoupons,
  deleteCouponIfUnreserved,
  // Exported only for focused lifecycle tests and callers that already own a
  // MongoDB transaction.
  releaseOrderCouponsInSession,
};
