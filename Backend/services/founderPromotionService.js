const crypto = require('crypto');
const mongoose = require('mongoose');
const SubscriptionPromotion = require('../models/SubscriptionPromotion');
const SellerSubscription = require('../models/SellerSubscription');

const FOUNDER_PROMOTION = Object.freeze({
    code: 'FIRST100',
    name: 'First 100 Sellers',
    discountPercent: 40,
    maxRedemptions: 100,
    checkoutReservationMinutes: 35,
    attachedReservationDays: 7,
});

function normalizePromotionCode(value) {
    return String(value || '').trim().toUpperCase();
}

function toObjectId(value) {
    return value instanceof mongoose.Types.ObjectId
        ? value
        : new mongoose.Types.ObjectId(String(value));
}

async function ensureFounderPromotion() {
    try {
        return await SubscriptionPromotion.findOneAndUpdate(
            { code: FOUNDER_PROMOTION.code },
            {
                $setOnInsert: {
                    code: FOUNDER_PROMOTION.code,
                    name: FOUNDER_PROMOTION.name,
                    discountPercent: FOUNDER_PROMOTION.discountPercent,
                    maxRedemptions: FOUNDER_PROMOTION.maxRedemptions,
                    claims: [],
                    reservations: [],
                },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
        );
    } catch (error) {
        if (error?.code === 11000) {
            return SubscriptionPromotion.findOne({ code: FOUNDER_PROMOTION.code });
        }
        throw error;
    }
}

async function removeExpiredReservations(now = new Date()) {
    await ensureFounderPromotion();
    await SubscriptionPromotion.updateOne(
        {
            code: FOUNDER_PROMOTION.code,
            'reservations.expiresAt': { $lte: now },
        },
        { $pull: { reservations: { expiresAt: { $lte: now } } } }
    );
}

function buildCapacityExpression() {
    return {
        $lt: [
            {
                $add: [
                    { $size: { $ifNull: ['$claims', []] } },
                    { $size: { $ifNull: ['$reservations', []] } },
                ],
            },
            '$maxRedemptions',
        ],
    };
}

function promotionCounts(promotion) {
    const claimedCount = promotion?.claims?.length || 0;
    const reservedCount = promotion?.reservations?.length || 0;
    const maxRedemptions = promotion?.maxRedemptions || FOUNDER_PROMOTION.maxRedemptions;
    return {
        claimedCount,
        reservedCount,
        maxRedemptions,
        remaining: Math.max(0, maxRedemptions - claimedCount - reservedCount),
    };
}

async function getFounderPromotionStatus(subscription = null) {
    await removeExpiredReservations();
    const promotion = await SubscriptionPromotion.findOne({ code: FOUNDER_PROMOTION.code }).lean();
    const counts = promotionCounts(promotion);
    const founderOffer = subscription?.founderOffer || {};
    const sellerHasClaimed = Boolean(founderOffer.claimedAt);
    const sellerId = subscription?.seller ? String(subscription.seller) : '';
    const sellerReservation = sellerId
        ? promotion?.reservations?.find(reservation => String(reservation.seller) === sellerId)
        : null;
    const sellerEligible = !sellerHasClaimed
        && !founderOffer.forfeitedAt
        && !['active', 'free_period', 'past_due'].includes(subscription?.status);

    return {
        code: FOUNDER_PROMOTION.code,
        name: FOUNDER_PROMOTION.name,
        discountPercent: FOUNDER_PROMOTION.discountPercent,
        checkoutReservationMinutes: FOUNDER_PROMOTION.checkoutReservationMinutes,
        ...counts,
        available: counts.remaining > 0 || Boolean(sellerReservation),
        sellerEligible,
        sellerHasClaimed,
        sellerHasReservation: Boolean(sellerReservation),
        sellerReservationExpiresAt: sellerReservation?.expiresAt || null,
        entitlementActive: Boolean(founderOffer.active),
        forfeited: Boolean(founderOffer.forfeitedAt),
    };
}

async function reserveFounderSlot(sellerId) {
    const sellerObjectId = toObjectId(sellerId);
    const now = new Date();
    const token = crypto.randomUUID();
    const expiresAt = new Date(
        now.getTime() + FOUNDER_PROMOTION.checkoutReservationMinutes * 60 * 1000
    );

    await removeExpiredReservations(now);

    // Only replace a reservation that never reached Stripe. Attached reservations
    // are released after the controller expires an open Session. A completed
    // Session awaiting its webhook must remain protected.
    await SubscriptionPromotion.updateOne(
        { code: FOUNDER_PROMOTION.code },
        { $pull: { reservations: { seller: sellerObjectId, checkoutSessionId: null } } }
    );

    const promotion = await SubscriptionPromotion.findOneAndUpdate(
        {
            code: FOUNDER_PROMOTION.code,
            'claims.seller': { $ne: sellerObjectId },
            'reservations.seller': { $ne: sellerObjectId },
            $expr: buildCapacityExpression(),
        },
        {
            $push: {
                reservations: {
                    seller: sellerObjectId,
                    token,
                    checkoutSessionId: null,
                    createdAt: now,
                    expiresAt,
                },
            },
        },
        { new: true, runValidators: true }
    );

    if (!promotion) {
        const existingClaim = await SubscriptionPromotion.exists({
            code: FOUNDER_PROMOTION.code,
            'claims.seller': sellerObjectId,
        });
        const existingReservation = !existingClaim && await SubscriptionPromotion.exists({
            code: FOUNDER_PROMOTION.code,
            'reservations.seller': sellerObjectId,
        });
        const error = new Error(existingClaim
            ? 'This seller account has already used the founder coupon.'
            : existingReservation
                ? 'Your previous FIRST100 Checkout is still processing. Please wait a moment and refresh your subscription status.'
                : 'The FIRST100 founder offer has reached its 100-seller limit.');
        error.code = existingClaim
            ? 'FOUNDER_COUPON_ALREADY_USED'
            : existingReservation
                ? 'FOUNDER_CHECKOUT_PENDING'
                : 'FOUNDER_COUPON_FULL';
        throw error;
    }

    return { token, expiresAt, ...promotionCounts(promotion) };
}

async function attachCheckoutSessionToReservation(sellerId, token, checkoutSessionId) {
    if (!token || !checkoutSessionId) return;
    const webhookSafetyExpiry = new Date(
        Date.now() + FOUNDER_PROMOTION.attachedReservationDays * 24 * 60 * 60 * 1000
    );
    const result = await SubscriptionPromotion.updateOne(
        {
            code: FOUNDER_PROMOTION.code,
            reservations: {
                $elemMatch: {
                    seller: toObjectId(sellerId),
                    token,
                },
            },
        },
        {
            $set: {
                'reservations.$.checkoutSessionId': checkoutSessionId,
                'reservations.$.expiresAt': webhookSafetyExpiry,
            },
        },
        { runValidators: true }
    );
    if (result.matchedCount !== 1) {
        const error = new Error('The founder reservation could not be attached to Checkout.');
        error.code = 'FOUNDER_RESERVATION_ATTACH_FAILED';
        throw error;
    }
}

async function releaseFounderReservation({ sellerId, token, checkoutSessionId } = {}) {
    if (!token && !checkoutSessionId) return;
    const reservationFilter = {};
    if (sellerId) reservationFilter.seller = toObjectId(sellerId);
    if (token) reservationFilter.token = token;
    if (checkoutSessionId) reservationFilter.checkoutSessionId = checkoutSessionId;

    await SubscriptionPromotion.updateOne(
        { code: FOUNDER_PROMOTION.code },
        { $pull: { reservations: reservationFilter } }
    );
}

async function claimFounderReservation({ sellerId, token, checkoutSessionId }) {
    const sellerObjectId = toObjectId(sellerId);
    if (!token || !checkoutSessionId) {
        const error = new Error('The founder coupon reservation details are incomplete.');
        error.code = 'FOUNDER_RESERVATION_INVALID';
        throw error;
    }

    const promotionWithClaim = await SubscriptionPromotion.findOne({
        code: FOUNDER_PROMOTION.code,
        'claims.seller': sellerObjectId,
    }).lean();
    const existingClaim = promotionWithClaim?.claims?.find(
        claim => String(claim.seller) === String(sellerObjectId)
    );

    if (existingClaim) {
        await releaseFounderReservation({ sellerId, token, checkoutSessionId });
        if (existingClaim.checkoutSessionId === checkoutSessionId) {
            return {
                claimed: true,
                alreadyClaimed: true,
                claimedAt: existingClaim.claimedAt,
            };
        }

        const error = new Error('This seller account has already used the founder coupon.');
        error.code = 'FOUNDER_COUPON_ALREADY_USED';
        throw error;
    }

    const now = new Date();
    const promotion = await SubscriptionPromotion.findOneAndUpdate(
        {
            code: FOUNDER_PROMOTION.code,
            reservations: {
                $elemMatch: {
                    seller: sellerObjectId,
                    token,
                    checkoutSessionId,
                    expiresAt: { $gt: now },
                },
            },
            'claims.seller': { $ne: sellerObjectId },
        },
        {
            $pull: { reservations: { seller: sellerObjectId, token } },
            $push: {
                claims: {
                    seller: sellerObjectId,
                    claimedAt: now,
                    source: 'coupon',
                    checkoutSessionId: checkoutSessionId || null,
                },
            },
        },
        { new: true, runValidators: true }
    );

    if (!promotion) {
        // Stripe can deliver the same event more than once or concurrently. If
        // another delivery already converted this exact reservation to a claim,
        // treat this call as idempotently successful.
        const completedClaim = await SubscriptionPromotion.findOne({
            code: FOUNDER_PROMOTION.code,
            claims: {
                $elemMatch: {
                    seller: sellerObjectId,
                    checkoutSessionId: checkoutSessionId || null,
                },
            },
        }).lean();
        if (completedClaim) {
            return { claimed: true, alreadyClaimed: true };
        }

        const error = new Error('The founder coupon reservation is no longer valid.');
        error.code = 'FOUNDER_RESERVATION_INVALID';
        throw error;
    }

    return { claimed: true, alreadyClaimed: false, claimedAt: now };
}

async function grantLegacyFounderEntitlement(subscription) {
    if (!subscription || subscription.founderOffer?.claimedAt) return false;

    const sellerObjectId = toObjectId(subscription.seller);
    await removeExpiredReservations();
    let promotion = await SubscriptionPromotion.findOne({
        code: FOUNDER_PROMOTION.code,
        'claims.seller': sellerObjectId,
    });

    const claimedAt = subscription.subscribedAt || new Date();
    if (!promotion) {
        promotion = await SubscriptionPromotion.findOneAndUpdate(
            {
                code: FOUNDER_PROMOTION.code,
                'claims.seller': { $ne: sellerObjectId },
                $expr: buildCapacityExpression(),
            },
            {
                $push: {
                    claims: {
                        seller: sellerObjectId,
                        claimedAt,
                        source: 'legacy',
                        checkoutSessionId: null,
                    },
                },
            },
            { new: true, runValidators: true }
        );
    }

    if (!promotion) return false;

    subscription.founderOffer = {
        active: true,
        code: FOUNDER_PROMOTION.code,
        discountPercent: FOUNDER_PROMOTION.discountPercent,
        claimedAt,
        forfeitedAt: null,
        source: 'legacy',
    };
    await subscription.save();
    return true;
}

async function migrateLegacyFounderSubscribers() {
    const promotion = await ensureFounderPromotion();
    if (promotion.legacyMigrationCompletedAt) return { migrated: 0, alreadyCompleted: true };
    const legacyEligibilityCutoff = promotion.createdAt || new Date();

    const existingSubscribers = await SellerSubscription.find({
        status: { $in: ['active', 'free_period', 'past_due'] },
        plan: { $in: ['starter', 'elite'] },
        stripeSubscriptionId: { $exists: true, $ne: null },
        subscribedAt: { $lte: legacyEligibilityCutoff },
        'founderOffer.claimedAt': null,
    }).sort({ subscribedAt: 1, createdAt: 1 });

    let migrated = 0;
    for (const subscription of existingSubscribers) {
        if (await grantLegacyFounderEntitlement(subscription)) migrated += 1;
    }

    await SubscriptionPromotion.updateOne(
        {
            code: FOUNDER_PROMOTION.code,
            legacyMigrationCompletedAt: null,
        },
        { $set: { legacyMigrationCompletedAt: new Date() } },
        { runValidators: true }
    );

    return { migrated, alreadyCompleted: false };
}

module.exports = {
    FOUNDER_PROMOTION,
    normalizePromotionCode,
    ensureFounderPromotion,
    getFounderPromotionStatus,
    reserveFounderSlot,
    attachCheckoutSessionToReservation,
    releaseFounderReservation,
    claimFounderReservation,
    grantLegacyFounderEntitlement,
    migrateLegacyFounderSubscribers,
};
