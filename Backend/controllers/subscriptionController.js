const SellerSubscription = require('../models/SellerSubscription');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Store = require('../models/Store');
const User = require('../models/User');
const Notification = require('../models/Notification');
const StripeEntitlementPayment = require('../models/StripeEntitlementPayment');
const { stripe, STRIPE_MODE } = require('../config/stripe');
const { ensureStripeCustomerForUser } = require('../services/stripeCustomerService');
const {
    META_ADS_ADDON_CENTS,
    buildPlanPricing,
    getPricingCatalog,
} = require('../services/subscriptionPricingService');
const { getHostedCheckoutReturnUrls } = require('../utils/hostedCheckoutReturnUrls');
const {
    fingerprintCheckoutRequest,
    claimSellerCheckout,
    attachSellerCheckoutSession,
    setSellerCheckoutClaimContext,
    markSellerCheckoutClaimRecoverable,
    releaseSellerCheckoutClaim,
    checkoutClaimRetryAfterSeconds,
} = require('../services/sellerCheckoutClaimService');
const { isDefinitiveStripeCreationError } = require('../services/stripePaymentIntentFactory');
const {
    FOUNDER_PROMOTION,
    normalizePromotionCode,
    getFounderPromotionStatus,
    reserveFounderSlot,
    attachCheckoutSessionToReservation,
    releaseFounderReservation,
    claimFounderReservation,
    migrateLegacyFounderSubscribers,
} = require('../services/founderPromotionService');
const {
    recomputeSubscriptionEntitlement,
    recordSubscriptionInvoiceFailure,
    recordSubscriptionInvoicePayment,
} = require('../services/stripeEntitlementPaymentService');
const {
    enqueueSubscriptionCancellationNotification,
} = require('../services/financialNotificationOutboxService');
const {
    enqueueBonusLifecycleNotification,
    enqueuePlanChangeNotification,
    enqueueSubscriptionActivationNotification,
    enqueueSubscriptionDowngradeScheduledNotification,
    enqueueSubscriptionEndingNotification,
    enqueueSubscriptionPaymentFailureNotification,
    enqueueTrialBlockedNotification,
    enqueueTrialExpiringNotification,
} = require('../services/subscriptionLifecycleNotificationService');
const { addUtcCalendarMonths } = require('../services/utcCalendarService');
const { isExactDecimalAtScale } = require('../services/moneyMath');
const {
    ensureStripeSubscriptionCleanup,
    processStripeSubscriptionCleanupById,
} = require('../services/stripeSubscriptionCleanupService');

function formatUsdMinorExact(amountMinor) {
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
        const error = new Error('USD money must be a non-negative safe minor-unit integer.');
        error.code = 'SUBSCRIPTION_MONEY_SNAPSHOT_INVALID';
        throw error;
    }
    const value = BigInt(amountMinor);
    return `$${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

const lifecyclePricingDate = (value, field) => {
    const date = value instanceof Date ? value : new Date(value);
    if (!value || !Number.isFinite(date.getTime())) {
        const error = new Error(`${field} is invalid.`);
        error.code = 'SUBSCRIPTION_LIFECYCLE_PRICE_SNAPSHOT_INVALID';
        throw error;
    }
    return date;
};

async function ensureTrialExpiringPricingSnapshot(subscription) {
    const eventAt = lifecyclePricingDate(subscription?.trialEndDate, 'Trial warning date');
    const standardPricing = buildPlanPricing('starter');
    const standardAmountMinor = standardPricing.unitAmount;
    const founderAmountMinor = buildPlanPricing('starter', false, true).unitAmount;
    const freePeriodDays = standardPricing.freePeriodDays;
    const snapshotPath = 'lifecyclePricing.trialExpiring';
    const current = await SellerSubscription.findOneAndUpdate({
        _id: subscription?._id,
        status: 'trial',
        trialEndDate: eventAt,
        warningEmailSent: { $ne: true },
        $or: [
            { [`${snapshotPath}.eventAt`]: { $ne: eventAt } },
            { [`${snapshotPath}.starterStandardAmountMinor`]: null },
            { [`${snapshotPath}.starterFounderAmountMinor`]: null },
            { [`${snapshotPath}.starterFreePeriodDays`]: null },
        ],
    }, {
        $set: {
            [`${snapshotPath}.eventAt`]: eventAt,
            [`${snapshotPath}.starterStandardAmountMinor`]: standardAmountMinor,
            [`${snapshotPath}.starterFounderAmountMinor`]: founderAmountMinor,
            [`${snapshotPath}.starterFreePeriodDays`]: freePeriodDays,
        },
    }, { new: true, runValidators: true });
    return current || SellerSubscription.findById(subscription?._id);
}

const bonusLifecyclePricingConfig = Object.freeze({
    expiring: Object.freeze({
        snapshotKey: 'bonusExpiring',
        eventPath: 'bonusExpiryDate',
        enqueuedPath: 'bonusExpiryWarningEmailSent',
        requiredPlan: { $ne: 'elite' },
        requireBonusActive: true,
        enqueuedQuery: { $ne: true },
    }),
    expired: Object.freeze({
        snapshotKey: 'bonusExpired',
        eventPath: 'bonusExpiredNotificationEventAt',
        enqueuedPath: 'bonusExpiredNotificationEnqueuedAt',
        requiredPlan: { $ne: 'elite' },
        enqueuedQuery: null,
    }),
    removed: Object.freeze({
        snapshotKey: 'bonusRemoved',
        eventPath: 'bonusGraceExpiredNotificationEventAt',
        enqueuedPath: 'bonusGraceExpiredNotificationEnqueuedAt',
        requiredPlan: 'starter',
        enqueuedQuery: null,
    }),
});

async function ensureBonusLifecyclePricingSnapshot(subscription, { kind, sourceDate }) {
    const config = bonusLifecyclePricingConfig[kind];
    if (!config) {
        const error = new Error('Bonus lifecycle pricing kind is invalid.');
        error.code = 'SUBSCRIPTION_LIFECYCLE_PRICE_SNAPSHOT_INVALID';
        throw error;
    }
    const eventAt = lifecyclePricingDate(sourceDate, 'Bonus lifecycle date');
    const pricing = buildPlanPricing(
        'elite',
        false,
        Boolean(subscription?.founderOffer?.active),
    );
    const amountMinor = pricing.unitAmount;
    const freePeriodDays = pricing.freePeriodDays;
    const snapshotPath = `lifecyclePricing.${config.snapshotKey}`;
    const query = {
        _id: subscription?._id,
        plan: config.requiredPlan,
        [config.eventPath]: eventAt,
        [config.enqueuedPath]: config.enqueuedQuery,
        $or: [
            { [`${snapshotPath}.eventAt`]: { $ne: eventAt } },
            { [`${snapshotPath}.eliteAmountMinor`]: null },
            { [`${snapshotPath}.eliteFreePeriodDays`]: null },
        ],
    };
    if (config.requireBonusActive) query.bonusFeaturesActive = true;
    const current = await SellerSubscription.findOneAndUpdate(query, {
        $set: {
            [`${snapshotPath}.eventAt`]: eventAt,
            [`${snapshotPath}.eliteAmountMinor`]: amountMinor,
            [`${snapshotPath}.eliteFreePeriodDays`]: freePeriodDays,
        },
    }, { new: true, runValidators: true });
    return current || SellerSubscription.findById(subscription?._id);
}

function resetSubscriptionInvoiceOrdering(subscription) {
    subscription.paymentRisk.latestFailureInvoiceId = '';
    subscription.paymentRisk.latestFailurePeriodStart = null;
    subscription.paymentRisk.latestFailureEventCreated = 0;
    subscription.paymentRisk.latestSuccessfulInvoiceId = '';
    subscription.paymentRisk.latestSuccessfulPeriodStart = null;
    subscription.paymentRisk.latestSuccessfulEventCreated = 0;
}

function activateStarterBonusForPaidDowngrade(subscription, grantStart = new Date()) {
    if (!subscription.starterBonusPeriodUsed) {
        subscription.bonusFeaturesActive = true;
        subscription.bonusExpiryDate = addUtcCalendarMonths(grantStart, 6);
        subscription.bonusFeaturesExpiredPermanently = false;
        subscription.bonusExpiryWarningEmailSent = false;
        subscription.starterBonusPeriodUsed = true;
    } else {
        subscription.bonusFeaturesActive = false;
        subscription.bonusFeaturesExpiredPermanently = true;
        subscription.bonusExpiryDate = null;
    }
    subscription.bonusGraceDeadline = null;
}

const PLAN_CHANGE_LEASE_MS = 10 * 60 * 1000;
const ENTITLEMENT_PLAN_SYNC_TOKEN_PREFIX = 'entitlement-plan-sync:';
const ENTITLEMENT_PLAN_SYNC_TOKEN_PATTERN = /^entitlement-plan-sync:v1:(applied|none):(\d{13}):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function parseEntitlementPlanSyncLease(processingToken) {
    if (typeof processingToken !== 'string') return null;
    const match = processingToken.match(ENTITLEMENT_PLAN_SYNC_TOKEN_PATTERN);
    if (!match) return null;
    const acquiredAtMs = Number(match[2]);
    if (!Number.isSafeInteger(acquiredAtMs) || acquiredAtMs <= 0) return null;
    return {
        previousState: match[1] === 'applied' ? 'applied' : null,
        acquiredAtMs,
    };
}
const PLAN_CHANGE_NOTIFICATION_LEASE_MS = 10 * 60 * 1000;
const SUBSCRIPTION_PAYMENT_NOTIFICATION_LEASE_MS = 10 * 60 * 1000;

const OUTBOXED_NOTIFICATION_CHANNELS = Object.freeze({
    notificationEmailState: 'outboxed',
    notificationWhatsAppState: 'outboxed',
    notificationInAppState: 'outboxed',
    notificationPushState: 'outboxed',
});

async function ensurePlanChangeCompletionNotificationOutboxed(subscriptionId, attemptToken) {
    const subscription = await SellerSubscription.findOne({
        _id: subscriptionId,
        'planChangeAttempt.idempotencyToken': attemptToken,
        'planChangeAttempt.state': 'applied',
    });
    if (!subscription) return false;
    if (['outboxed', 'sent'].includes(subscription.planChangeAttempt?.notificationState)) return true;

    await enqueuePlanChangeNotification(subscription, {
        kind: 'completed',
        attemptToken,
    });

    const completedAt = new Date();
    await SellerSubscription.updateOne({
        _id: subscriptionId,
        'planChangeAttempt.idempotencyToken': attemptToken,
        'planChangeAttempt.state': 'applied',
        'planChangeAttempt.notificationState': { $in: ['pending', 'partial', 'processing', null] },
    }, {
        $set: {
            'planChangeAttempt.notificationState': 'outboxed',
            'planChangeAttempt.notificationToken': null,
            'planChangeAttempt.notificationCompletedAt': completedAt,
            'planChangeAttempt.notificationLastError': '',
            ...Object.fromEntries(Object.entries(OUTBOXED_NOTIFICATION_CHANNELS).map(
                ([field, value]) => [`planChangeAttempt.${field}`, value]
            )),
        },
    });

    // An authentication-required in-app alert may already have been delivered
    // before the successful invoice arrived. It is an action, not a receipt,
    // so remove it once the exact attempt is complete.
    const staleActionRows = [{
        eventType: 'subscription.plan_change_action_required',
        aggregateId: String(subscription._id),
    }];
    if (subscription.planChangeAttempt?.stripeInvoiceId) {
        staleActionRows.push({
            dedupeKey: `subscription-plan-change-action:${String(subscription._id)}:${String(attemptToken)}:${String(subscription.planChangeAttempt.stripeInvoiceId)}`,
        });
    }
    await Notification.deleteMany({
        user: subscription.seller,
        $or: staleActionRows,
    });
    return true;
}

async function ensurePlanChangeActionNotificationOutboxed(subscriptionId, attemptToken, invoiceId) {
    const subscription = await SellerSubscription.findOne({
        _id: subscriptionId,
        'planChangeAttempt.idempotencyToken': attemptToken,
        'planChangeAttempt.stripeInvoiceId': invoiceId,
        'planChangeAttempt.state': 'pending_payment',
    });
    if (!subscription) return false;
    if (['outboxed', 'sent'].includes(subscription.planChangeAttempt?.notificationState)) return true;

    await enqueuePlanChangeNotification(subscription, {
        kind: 'action_required',
        attemptToken,
        invoiceId,
    });
    await SellerSubscription.updateOne({
        _id: subscriptionId,
        'planChangeAttempt.idempotencyToken': attemptToken,
        'planChangeAttempt.stripeInvoiceId': invoiceId,
        'planChangeAttempt.state': 'pending_payment',
        'planChangeAttempt.notificationState': { $in: ['pending', 'partial', 'processing', null] },
    }, {
        $set: {
            'planChangeAttempt.notificationState': 'outboxed',
            'planChangeAttempt.notificationToken': null,
            'planChangeAttempt.notificationCompletedAt': new Date(),
            'planChangeAttempt.notificationLastError': '',
            ...Object.fromEntries(Object.entries(OUTBOXED_NOTIFICATION_CHANNELS).map(
                ([field, value]) => [`planChangeAttempt.${field}`, value]
            )),
        },
    });
    return true;
}

async function ensurePaymentFailureNotificationOutboxed(subscriptionId, invoiceId) {
    const subscription = await SellerSubscription.findOne({
        _id: subscriptionId,
        'paymentRisk.failureNotification.invoiceId': invoiceId,
        'paymentRisk.failureNotification.state': { $in: ['pending', 'partial', 'processing'] },
    });
    if (!subscription) {
        return Boolean(await SellerSubscription.exists({
            _id: subscriptionId,
            'paymentRisk.failureNotification.invoiceId': invoiceId,
            'paymentRisk.failureNotification.state': { $in: ['outboxed', 'sent', 'superseded'] },
        }));
    }

    await enqueueSubscriptionPaymentFailureNotification(subscription, { invoiceId });
    await SellerSubscription.updateOne({
        _id: subscriptionId,
        'paymentRisk.failureNotification.invoiceId': invoiceId,
        'paymentRisk.failureNotification.state': { $in: ['pending', 'partial', 'processing'] },
    }, {
        $set: {
            'paymentRisk.failureNotification.state': 'outboxed',
            'paymentRisk.failureNotification.token': null,
            'paymentRisk.failureNotification.completedAt': new Date(),
            'paymentRisk.failureNotification.lastError': '',
            'paymentRisk.failureNotification.emailState': 'outboxed',
            'paymentRisk.failureNotification.whatsAppState': 'outboxed',
            'paymentRisk.failureNotification.inAppState': 'outboxed',
            'paymentRisk.failureNotification.pushState': 'outboxed',
        },
    });
    return true;
}

const isPrecisePercentage = value => (
    isExactDecimalAtScale(value, { scale: 2, min: 0, max: 100 })
);

async function founderDiscountPercentForPresentation(subscription) {
    const raw = await SellerSubscription.collection.findOne(
        { _id: subscription?._id },
        { projection: { founderOffer: 1 } },
    );
    if (!raw) {
        const error = new Error('The subscription disappeared while its founder offer was being verified.');
        error.code = 'SUBSCRIPTION_FOUNDER_OFFER_INVALID';
        error.statusCode = 503;
        throw error;
    }

    const founderOffer = raw.founderOffer;
    if (founderOffer === null || founderOffer === undefined) {
        return subscription?.founderOffer?.active
            ? FOUNDER_PROMOTION.discountPercent
            : 0;
    }
    if (typeof founderOffer !== 'object' || Array.isArray(founderOffer)) {
        const error = new Error('The stored founder offer is malformed and requires recovery.');
        error.code = 'SUBSCRIPTION_FOUNDER_OFFER_INVALID';
        error.statusCode = 503;
        throw error;
    }
    if (!Object.prototype.hasOwnProperty.call(founderOffer, 'discountPercent')) {
        // Pre-founder documents legitimately have no percentage snapshot. An
        // already-active legacy entitlement still uses the one canonical
        // founder rate; an inactive legacy record has no discount.
        return subscription?.founderOffer?.active
            ? FOUNDER_PROMOTION.discountPercent
            : 0;
    }
    if (!isPrecisePercentage(founderOffer.discountPercent)) {
        const error = new Error('The stored founder discount is malformed and requires recovery.');
        error.code = 'SUBSCRIPTION_FOUNDER_OFFER_INVALID';
        error.statusCode = 503;
        throw error;
    }
    return founderOffer.discountPercent;
}

const pendingDowngradeError = (message, code = 'PENDING_DOWNGRADE_QUOTE_INVALID') => {
    const error = new Error(message);
    error.code = code;
    error.statusCode = 409;
    return error;
};

const validPendingDowngradeDate = value => {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
};

function buildPendingDowngradeQuote(subscription, {
    scheduledAt,
    operationKey = crypto.randomUUID(),
} = {}) {
    const scheduled = validPendingDowngradeDate(scheduledAt);
    if (!scheduled || !subscription?.stripeSubscriptionId) {
        throw pendingDowngradeError('The downgrade schedule cannot freeze an invalid source subscription or timestamp.');
    }
    const founderRateApplied = Boolean(subscription?.founderOffer?.active);
    const pricing = buildPlanPricing('starter', false, founderRateApplied);
    const founderDiscountPercent = founderRateApplied
        ? FOUNDER_PROMOTION.discountPercent
        : 0;
    return {
        toPlan: 'starter',
        scheduledAt: scheduled,
        operationKey: String(operationKey),
        sourceStripeSubscriptionId: String(subscription.stripeSubscriptionId),
        targetPlanName: pricing.planName,
        targetUnitAmountMinor: pricing.unitAmount,
        targetCurrency: 'usd',
        founderRateApplied,
        founderDiscountPercent,
        founderOfferCode: founderRateApplied
            ? String(subscription?.founderOffer?.code || FOUNDER_PROMOTION.code)
            : null,
        starterBonusEligible: !subscription.starterBonusPeriodUsed,
        quoteFrozenAt: scheduled,
        stripeScheduledAt: null,
        notificationEnqueuedAt: null,
        notificationCompletedAt: null,
        activationPending: false,
    };
}

function requirePendingDowngradeQuote(subscription) {
    const pending = subscription?.pendingDowngrade;
    const scheduledAt = validPendingDowngradeDate(pending?.scheduledAt);
    const quoteFrozenAt = validPendingDowngradeDate(pending?.quoteFrozenAt);
    if (
        pending?.toPlan !== 'starter'
        || !scheduledAt
        || !quoteFrozenAt
        || !String(pending?.operationKey || '').trim()
        || !String(pending?.sourceStripeSubscriptionId || '').trim()
        || String(pending.sourceStripeSubscriptionId) !== String(subscription?.stripeSubscriptionId || '')
        || !String(pending?.targetPlanName || '').trim()
        || !Number.isSafeInteger(pending?.targetUnitAmountMinor)
        || pending.targetUnitAmountMinor <= 0
        || pending?.targetCurrency !== 'usd'
        || typeof pending?.founderRateApplied !== 'boolean'
        || !isPrecisePercentage(pending?.founderDiscountPercent)
        || (pending.founderRateApplied
            && pending.founderDiscountPercent !== FOUNDER_PROMOTION.discountPercent)
        || (pending.founderRateApplied && !String(pending?.founderOfferCode || '').trim())
        || (!pending.founderRateApplied && (
            pending.founderDiscountPercent !== 0
            || Boolean(String(pending?.founderOfferCode || '').trim())
        ))
        || typeof pending?.starterBonusEligible !== 'boolean'
    ) {
        throw pendingDowngradeError('The scheduled downgrade does not contain one complete immutable Starter quote.');
    }
    return pending;
}

const pendingDowngradeHasPartialQuote = pending => [
    pending?.operationKey,
    pending?.sourceStripeSubscriptionId,
    pending?.targetPlanName,
    pending?.targetUnitAmountMinor,
    pending?.targetCurrency,
    pending?.founderRateApplied,
    pending?.founderDiscountPercent,
    pending?.founderOfferCode,
    pending?.starterBonusEligible,
    pending?.quoteFrozenAt,
].some(value => value !== null && value !== undefined && value !== '');

async function ensurePendingDowngradeQuoteFrozen(subscription) {
    try {
        requirePendingDowngradeQuote(subscription);
        return subscription;
    } catch (error) {
        if (error?.code !== 'PENDING_DOWNGRADE_QUOTE_INVALID') throw error;
    }
    if (subscription?.pendingDowngrade?.toPlan !== 'starter') {
        throw pendingDowngradeError('There is no Starter downgrade quote to freeze.');
    }
    if (pendingDowngradeHasPartialQuote(subscription.pendingDowngrade)) {
        throw pendingDowngradeError('The saved Starter downgrade quote is partial or corrupt and cannot be reinterpreted.');
    }

    // Compatibility repair for pre-deployment pending downgrades. This compare-
    // and-set happens before any later catalog can be used by the webhook. New
    // schedules always persist the complete quote in their first write.
    const scheduledAt = validPendingDowngradeDate(subscription.pendingDowngrade.scheduledAt);
    const operationKey = crypto.createHash('sha256').update([
        'legacy-downgrade-v1',
        String(subscription._id),
        String(subscription.stripeSubscriptionId || ''),
        scheduledAt?.toISOString?.() || '',
    ].join(':')).digest('hex');
    const quote = buildPendingDowngradeQuote(subscription, { scheduledAt, operationKey });
    const set = {};
    for (const [key, value] of Object.entries(quote)) {
        if (['toPlan', 'scheduledAt', 'activationPending'].includes(key)) continue;
        set[`pendingDowngrade.${key}`] = value;
    }
    const frozen = await SellerSubscription.findOneAndUpdate({
        _id: subscription._id,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        'pendingDowngrade.toPlan': 'starter',
        'pendingDowngrade.scheduledAt': scheduledAt,
        $or: [
            { 'pendingDowngrade.operationKey': null },
            { 'pendingDowngrade.operationKey': { $exists: false } },
        ],
    }, { $set: set }, { new: true });
    const current = frozen || await SellerSubscription.findById(subscription._id);
    requirePendingDowngradeQuote(current);
    return current;
}

async function finalizePendingDowngradeScheduleNotification(subscription, operationKey) {
    const subscriptionId = subscription?._id || subscription;
    const operation = String(operationKey || '');
    if (!subscriptionId || !operation) return subscription;

    const dbSession = await mongoose.startSession();
    try {
        await dbSession.withTransaction(async () => {
            const current = await SellerSubscription.findById(subscriptionId).session(dbSession);
            if (
                !current
                || current.pendingDowngrade?.operationKey !== operation
                || current.pendingDowngrade?.toPlan !== 'starter'
                || current.pendingDowngrade?.notificationCompletedAt
            ) return;
            requirePendingDowngradeQuote(current);
            if (!validPendingDowngradeDate(current.pendingDowngrade.stripeScheduledAt)) {
                throw pendingDowngradeError('Stripe has not durably confirmed this downgrade schedule.');
            }
            await enqueueSubscriptionDowngradeScheduledNotification(current, { session: dbSession });
            const completedAt = new Date();
            const marked = await SellerSubscription.updateOne({
                _id: current._id,
                stripeSubscriptionId: current.pendingDowngrade.sourceStripeSubscriptionId,
                'pendingDowngrade.toPlan': 'starter',
                'pendingDowngrade.operationKey': operation,
                'pendingDowngrade.notificationCompletedAt': null,
            }, {
                $set: {
                    'pendingDowngrade.notificationEnqueuedAt': completedAt,
                    'pendingDowngrade.notificationCompletedAt': completedAt,
                },
            }, { session: dbSession });
            if (marked.modifiedCount !== 1) {
                throw pendingDowngradeError(
                    'The downgrade schedule changed while its notification was being finalized.',
                    'PENDING_DOWNGRADE_NOTIFICATION_CONFLICT'
                );
            }
        });
    } finally {
        await dbSession.endSession();
    }
    return SellerSubscription.findById(subscriptionId);
}

const activePlanChangeStates = ['processing', 'pending_payment', 'recoverable'];

function isDefinitiveStripeMutationRejection(error) {
    const type = String(error?.type || '');
    const statusCode = Number(error?.statusCode);
    if ([
        'StripeAPIError',
        'StripeConnectionError',
        'StripeUnknownError',
        'StripeIdempotencyError',
        'StripeRateLimitError',
    ].includes(type)) return false;
    if (['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN'].includes(error?.code)) return false;
    // A timeout/conflict/rate-limit response does not prove whether Stripe
    // accepted an earlier write under this idempotency key. Keep the durable
    // intent so the exact request can be replayed.
    if ([408, 409, 425, 429].includes(statusCode) || statusCode >= 500) return false;
    return type.startsWith('Stripe') && (
        [
            'StripeInvalidRequestError',
            'StripeAuthenticationError',
            'StripePermissionError',
            'StripeCardError',
        ].includes(type)
        || (statusCode >= 400 && statusCode < 500)
    );
}

const stripeObjectId = value => (
    typeof value === 'string' ? value : String(value?.id || '')
);

const stripePriceProductId = price => stripeObjectId(price?.product);

const stripeIntegerDecimal = value => {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
};

const stripeHasDiscounts = value => {
    if (!value) return false;
    if (value.discount) return true;
    if (Array.isArray(value.discounts)) return value.discounts.length > 0;
    if (Array.isArray(value.discounts?.data)) return value.discounts.data.length > 0;
    return false;
};

function exactStripeSubscriptionItem(stripeSubscription, {
    expectedItemId = null,
    expectedPriceId = null,
    expectedProductId = null,
    expectedUnitAmount = null,
} = {}) {
    const itemList = stripeSubscription?.items;
    const items = itemList?.data;
    if (!Array.isArray(items) || itemList?.has_more !== false || items.length !== 1) {
        return { ok: false, reason: 'Stripe subscription must contain one complete plan item.' };
    }
    if (stripeHasDiscounts(stripeSubscription)) {
        return { ok: false, reason: 'Stripe subscription discounts do not match the exact saved plan Price.' };
    }
    const item = items[0];
    const quantity = item?.quantity;
    const price = item?.price;
    const itemId = stripeObjectId(item);
    const priceId = stripeObjectId(price);
    const productId = stripePriceProductId(price);
    if (
        !itemId
        || !Number.isSafeInteger(quantity)
        || quantity !== 1
        || stripeHasDiscounts(item)
        || !price
        || typeof price !== 'object'
        || !priceId
        || !productId
        || String(price.currency || '').toLowerCase() !== 'usd'
        || !Number.isSafeInteger(price.unit_amount)
        || price.unit_amount <= 0
        || price.recurring?.interval !== 'month'
        || price.active === false
        || (expectedItemId && itemId !== String(expectedItemId))
        || (expectedPriceId && priceId !== String(expectedPriceId))
        || (expectedProductId && productId !== String(expectedProductId))
        || (
            expectedUnitAmount !== null
            && price.unit_amount !== expectedUnitAmount
        )
    ) {
        return { ok: false, reason: 'Stripe plan item, Product, Price, quantity, or billing terms do not match.' };
    }
    return {
        ok: true,
        item,
        itemId,
        price,
        priceId,
        productId,
        unitAmount: price.unit_amount,
    };
}

const stripeEpochDate = (value, field, code = 'STRIPE_SUBSCRIPTION_PERIOD_INVALID') => {
    if (!Number.isSafeInteger(value) || value <= 0) {
        const error = new Error(`Stripe ${field} must be a positive whole Unix timestamp.`);
        error.code = code;
        throw error;
    }
    const milliseconds = value * 1000;
    const date = new Date(milliseconds);
    if (!Number.isSafeInteger(milliseconds) || !Number.isFinite(date.getTime())) {
        const error = new Error(`Stripe ${field} is outside the supported date range.`);
        error.code = code;
        throw error;
    }
    return date;
};

const stripePendingUpdateExpiryDate = value => (
    value === null || value === undefined
        ? null
        : stripeEpochDate(
            value,
            'pending_update expires_at',
            'STRIPE_PLAN_CHANGE_EXPIRY_INVALID'
        )
);

function exactStripeSubscriptionBillingPeriod(stripeSubscription, {
    introductoryPeriodDays = 0,
} = {}) {
    if (
        !Number.isSafeInteger(introductoryPeriodDays)
        || introductoryPeriodDays < 0
        || introductoryPeriodDays > 365
    ) {
        const error = new Error('The introductory-period snapshot must be a safe whole-day count.');
        error.code = 'STRIPE_SUBSCRIPTION_TRIAL_INVALID';
        throw error;
    }
    const items = stripeSubscription?.items?.data;
    if (
        !Array.isArray(items)
        || stripeSubscription?.items?.has_more !== false
        || items.length !== 1
    ) {
        const error = new Error('Stripe subscription billing periods require one complete subscription item.');
        error.code = 'STRIPE_SUBSCRIPTION_PERIOD_INVALID';
        throw error;
    }
    const currentPeriodStart = stripeEpochDate(
        items[0]?.current_period_start,
        'subscription item current_period_start',
    );
    const currentPeriodEnd = stripeEpochDate(
        items[0]?.current_period_end,
        'subscription item current_period_end',
    );
    if (currentPeriodEnd <= currentPeriodStart) {
        const error = new Error('Stripe subscription item period end must be after its start.');
        error.code = 'STRIPE_SUBSCRIPTION_PERIOD_INVALID';
        throw error;
    }
    const subscriptionStartedAt = stripeEpochDate(
        stripeSubscription?.start_date,
        'subscription start_date',
    );
    if (subscriptionStartedAt > currentPeriodStart) {
        const error = new Error('Stripe subscription start_date is after the current item period start.');
        error.code = 'STRIPE_SUBSCRIPTION_PERIOD_INVALID';
        throw error;
    }
    const status = String(stripeSubscription?.status || '');
    const hasIntroductoryPeriod = introductoryPeriodDays > 0;
    const maximumPeriodDays = status === 'trialing' && hasIntroductoryPeriod
        ? introductoryPeriodDays
        : 32;
    if (
        currentPeriodEnd.getTime() - currentPeriodStart.getTime()
        > maximumPeriodDays * 24 * 60 * 60 * 1000
    ) {
        const error = new Error('Stripe subscription item period exceeds its monthly billing boundary.');
        error.code = 'STRIPE_SUBSCRIPTION_PERIOD_INVALID';
        throw error;
    }
    let trialStart = null;
    let trialEnd = null;
    let trialActive = false;
    if (hasIntroductoryPeriod) {
        if (!['trialing', 'active'].includes(status)) {
            const error = new Error('The completed introductory Checkout is neither trialing nor active on Stripe.');
            error.code = 'STRIPE_SUBSCRIPTION_TRIAL_INVALID';
            throw error;
        }
        trialStart = stripeEpochDate(
            stripeSubscription?.trial_start,
            'subscription trial_start',
            'STRIPE_SUBSCRIPTION_TRIAL_INVALID',
        );
        trialEnd = stripeEpochDate(
            stripeSubscription?.trial_end,
            'subscription trial_end',
            'STRIPE_SUBSCRIPTION_TRIAL_INVALID',
        );
        const requestedTrialMs = introductoryPeriodDays * 24 * 60 * 60 * 1000;
        if (
            trialStart < subscriptionStartedAt
            || trialEnd <= trialStart
            || trialEnd.getTime() - trialStart.getTime() !== requestedTrialMs
        ) {
            const error = new Error('Stripe trial_start/trial_end do not match the frozen introductory period.');
            error.code = 'STRIPE_SUBSCRIPTION_TRIAL_INVALID';
            throw error;
        }
        trialActive = status === 'trialing';
        if (
            trialActive
            && (trialStart < currentPeriodStart || trialEnd > currentPeriodEnd)
        ) {
            const error = new Error('The active Stripe trial is outside the authoritative subscription item period.');
            error.code = 'STRIPE_SUBSCRIPTION_TRIAL_INVALID';
            throw error;
        }
        if (!trialActive && trialEnd > currentPeriodStart) {
            const error = new Error('The ended Stripe trial is after the active item period start.');
            error.code = 'STRIPE_SUBSCRIPTION_TRIAL_INVALID';
            throw error;
        }
    } else if (status !== 'active') {
        const error = new Error('A paid subscription activation must be active on Stripe.');
        error.code = 'STRIPE_SUBSCRIPTION_PERIOD_INVALID';
        throw error;
    }
    return {
        subscriptionStartedAt,
        currentPeriodStart,
        currentPeriodEnd,
        trialStart,
        trialEnd,
        trialActive,
    };
}

function checkoutIntroductoryPeriodDays(session, { stripeSubscription, legacyEligible }) {
    const raw = session?.metadata?.introductoryPeriodDays;
    const hasMetadataSnapshot = raw !== undefined && raw !== null && raw !== '';
    const stripeStatus = String(stripeSubscription?.status || '');
    const hasStripeTrialEvidence = (
        stripeStatus === 'trialing'
        || stripeSubscription?.trial_start !== null
            && stripeSubscription?.trial_start !== undefined
        || stripeSubscription?.trial_end !== null
            && stripeSubscription?.trial_end !== undefined
    );
    let days;

    if (hasMetadataSnapshot) {
        days = stripeIntegerDecimal(raw);
        if (!Number.isSafeInteger(days) || days < 0 || days > 365) {
            const error = new Error('Completed Checkout has an invalid introductory-period snapshot.');
            error.code = 'CHECKOUT_SUBSCRIPTION_TRIAL_SNAPSHOT_INVALID';
            throw error;
        }
        // A zero-day snapshot and provider-side trial cannot both be true. Do
        // not silently ignore Stripe trial evidence or leave local eligibility
        // reusable after Stripe already funded an introductory period.
        if (days === 0 && hasStripeTrialEvidence) {
            const error = new Error('Completed Checkout trial evidence does not match its introductory-period snapshot.');
            error.code = 'CHECKOUT_SUBSCRIPTION_TRIAL_SNAPSHOT_INVALID';
            throw error;
        }
    } else if (!hasStripeTrialEvidence) {
        // Legacy paid Checkouts predate the snapshot metadata. The complete
        // Stripe subscription is the immutable authority; today's catalog is
        // never a valid substitute for a historical Checkout.
        days = 0;
    } else {
        const trialStart = stripeIntegerDecimal(stripeSubscription?.trial_start);
        const trialEnd = stripeIntegerDecimal(stripeSubscription?.trial_end);
        const trialDurationSeconds = Number.isSafeInteger(trialStart)
            && Number.isSafeInteger(trialEnd)
            ? trialEnd - trialStart
            : null;
        const daySeconds = 24 * 60 * 60;
        if (
            !Number.isSafeInteger(trialDurationSeconds)
            || trialDurationSeconds <= 0
            || trialDurationSeconds % daySeconds !== 0
        ) {
            const error = new Error('Legacy Checkout has incomplete or non-whole-day Stripe trial evidence.');
            error.code = 'CHECKOUT_SUBSCRIPTION_TRIAL_SNAPSHOT_INVALID';
            throw error;
        }
        days = trialDurationSeconds / daySeconds;
        if (!Number.isSafeInteger(days) || days <= 0 || days > 365) {
            const error = new Error('Legacy Checkout has an unsupported Stripe introductory period.');
            error.code = 'CHECKOUT_SUBSCRIPTION_TRIAL_SNAPSHOT_INVALID';
            throw error;
        }
    }

    if (days > 0 && !legacyEligible) {
        const error = new Error('This seller already used the one-time introductory period.');
        error.code = 'CHECKOUT_SUBSCRIPTION_TRIAL_ALREADY_USED';
        throw error;
    }
    return days;
}

function exactStripePlanChangeSource(stripeSubscription, options = {}) {
    if (!['active', 'trialing'].includes(String(stripeSubscription?.status || ''))) {
        return { ok: false, reason: `Stripe subscription status is ${stripeSubscription?.status || 'unknown'}.` };
    }
    if (String(stripeSubscription?.collection_method || '') !== 'charge_automatically') {
        return { ok: false, reason: 'Stripe subscription is not configured for automatic card collection.' };
    }
    if (stripeSubscription?.pause_collection) {
        return { ok: false, reason: 'Stripe subscription billing is paused.' };
    }
    if (stripeSubscription?.cancel_at_period_end) {
        return { ok: false, reason: 'Stripe subscription cancellation is already scheduled.' };
    }
    return exactStripeSubscriptionItem(stripeSubscription, options);
}

function emptyPendingStoreSync() {
    return {
        kind: null,
        eventId: null,
        stripeSubscriptionId: null,
        previousStripeSubscriptionId: null,
        blockedAt: null,
    };
}

async function synchronizePendingSubscriptionStore(subscription) {
    const current = subscription?._id
        ? await SellerSubscription.findById(subscription._id)
        : null;
    if (!current) return false;
    const sync = current.pendingStoreSync;
    const kind = sync?.kind;
    if (!kind) return false;
    const currentStripeSubscriptionId = String(current.stripeSubscriptionId || '');
    const syncStripeSubscriptionId = String(sync.stripeSubscriptionId || '');
    const accessCurrentlyFunded = ['active', 'free_period'].includes(current.status)
        && !current.paymentRisk?.suspended
        && currentStripeSubscriptionId === syncStripeSubscriptionId;

    if (kind === 'checkout_activation') {
        if (accessCurrentlyFunded) {
            const previousStripeSubscriptionId = String(sync.previousStripeSubscriptionId || '');
            await Store.findOneAndUpdate({
                seller: current.seller,
                // Never let a delayed Checkout event erase a risk lock raised
                // later for the newly-bound subscription (or another owner).
                $or: [
                    { subscriptionPaymentRiskLock: { $exists: false } },
                    { 'subscriptionPaymentRiskLock.stripeSubscriptionId': { $in: ['', null] } },
                    ...(previousStripeSubscriptionId
                        ? [{ 'subscriptionPaymentRiskLock.stripeSubscriptionId': previousStripeSubscriptionId }]
                        : []),
                ],
            }, {
                $set: {
                    isActive: true,
                    blockedAt: null,
                    'subdomainPurchase.removalScheduledAt': null,
                },
                $unset: { subscriptionPaymentRiskLock: 1 },
            });
        }
    } else if (kind === 'downgrade_block') {
        if (
            currentStripeSubscriptionId === syncStripeSubscriptionId
            && (current.status === 'past_due' || current.paymentRisk?.suspended)
        ) {
            const blockedAt = sync.blockedAt || new Date();
            const blockedStore = await Store.findOneAndUpdate({
                seller: current.seller,
                isActive: true,
                blockedAt: null,
            }, {
                $set: {
                    isActive: false,
                    blockedAt,
                    'subscriptionPaymentRiskLock.stripeSubscriptionId': sync.stripeSubscriptionId,
                    'subscriptionPaymentRiskLock.lockedAt': blockedAt,
                },
            });
            if (blockedStore) {
                // Close the remaining cross-document race: if payment recovery
                // became authoritative while the Store write was in flight,
                // undo only the exact block owned by this transition. If the
                // payment succeeds later, its normal risk recovery owns it.
                const afterBlock = await SellerSubscription.findById(current._id)
                    .select('status stripeSubscriptionId paymentRisk')
                    .lean();
                const recoveredWhileBlocking = afterBlock
                    && String(afterBlock.stripeSubscriptionId || '') === syncStripeSubscriptionId
                    && ['active', 'free_period'].includes(afterBlock.status)
                    && !afterBlock.paymentRisk?.suspended;
                if (recoveredWhileBlocking) {
                    await Store.updateOne({
                        _id: blockedStore._id,
                        isActive: false,
                        blockedAt,
                        'subscriptionPaymentRiskLock.stripeSubscriptionId': sync.stripeSubscriptionId,
                        'subscriptionPaymentRiskLock.lockedAt': blockedAt,
                    }, {
                        $set: { isActive: true, blockedAt: null },
                        $unset: { subscriptionPaymentRiskLock: 1 },
                    });
                }
            }
        }
    } else if (kind === 'downgrade_activation') {
        const previousStripeSubscriptionId = String(sync.previousStripeSubscriptionId || '');
        const riskLockedStore = accessCurrentlyFunded && previousStripeSubscriptionId
            ? await Store.findOne({
                seller: current.seller,
                'subscriptionPaymentRiskLock.stripeSubscriptionId': previousStripeSubscriptionId,
            }).select('isActive blockedAt subscriptionPaymentRiskLock')
            : null;
        if (riskLockedStore) {
            const lockTime = riskLockedStore.subscriptionPaymentRiskLock?.lockedAt?.getTime();
            const blockTime = riskLockedStore.blockedAt?.getTime();
            await Store.updateOne({
                _id: riskLockedStore._id,
                'subscriptionPaymentRiskLock.stripeSubscriptionId': previousStripeSubscriptionId,
                'subscriptionPaymentRiskLock.lockedAt': riskLockedStore.subscriptionPaymentRiskLock.lockedAt,
            }, {
                ...(riskLockedStore.isActive === false && lockTime && lockTime === blockTime
                    ? { $set: { isActive: true, blockedAt: null } }
                    : {}),
                $unset: { subscriptionPaymentRiskLock: 1 },
            });
        }
    } else {
        const error = new Error(`Unsupported subscription Store synchronization kind: ${kind}`);
        error.code = 'SUBSCRIPTION_STORE_SYNC_INVALID';
        throw error;
    }

    await SellerSubscription.updateOne({
        _id: current._id,
        'pendingStoreSync.kind': kind,
        'pendingStoreSync.eventId': sync.eventId,
    }, {
        $set: {
            pendingStoreSync: emptyPendingStoreSync(),
        },
    });
    return true;
}

function planChangeFingerprint(subscription, target) {
    return crypto.createHash('sha256').update(JSON.stringify({
        sellerId: String(subscription.seller),
        stripeSubscriptionId: String(subscription.stripeSubscriptionId),
        sourcePlan: String(subscription.plan || ''),
        sourceIncludeMetaAds: Boolean(subscription.metaAdsIncluded),
        changeKind: target.changeKind,
        targetPlan: target.plan,
        targetPlanName: target.planName,
        includeMetaAds: Boolean(target.includeMetaAds),
        unitAmountMinor: target.unitAmount,
    })).digest('hex');
}

async function claimPlanChangeAttempt(subscription, requestFingerprint, target) {
    let current = subscription.planChangeAttempt || {};
    if (
        activePlanChangeStates.includes(current.state)
        && current.stripeSubscriptionId
        && String(current.stripeSubscriptionId) !== String(subscription.stripeSubscriptionId)
    ) {
        await clearTerminalPlanChangeAttempt(
            subscription._id,
            current.idempotencyToken,
            'The Stripe subscription changed before this plan change completed.',
        );
        subscription = await SellerSubscription.findById(subscription._id);
        current = subscription?.planChangeAttempt || {};
    }
    if (current.state === 'applied' && current.requestFingerprint === requestFingerprint) {
        return { applied: true, subscription };
    }

    const now = new Date();
    const staleBefore = new Date(now.getTime() - PLAN_CHANGE_LEASE_MS);
    const processingToken = crypto.randomUUID();
    let idempotencyToken;
    let claimFilter;
    let isNewAttempt = false;

    if (
        current.state === 'processing'
        && String(current.processingToken || '').startsWith(ENTITLEMENT_PLAN_SYNC_TOKEN_PREFIX)
    ) {
        const fundedSyncLease = parseEntitlementPlanSyncLease(current.processingToken);
        if (!fundedSyncLease) {
            return {
                pending: true,
                code: 'PLAN_CHANGE_ENTITLEMENT_SYNC_RECOVERY_REQUIRED',
                msg: 'A funded-plan reconciliation lease has an invalid durable identity. No new Stripe plan change was started.',
                retryAfterSeconds: 30,
            };
        }
        const remainingMs = (fundedSyncLease.acquiredAtMs + PLAN_CHANGE_LEASE_MS) - now.getTime();
        if (remainingMs > 0) {
            return {
                pending: true,
                code: 'PLAN_CHANGE_ENTITLEMENT_SYNC_IN_PROGRESS',
                msg: 'Stripe funding is being reconciled for this subscription. No new plan change was started; retry shortly.',
                retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
            };
        }

        // A crashed refund/dispute reconciliation may have changed Stripe's
        // recurring Price before local persistence. Never steal that stale
        // lease as a user plan-change claim. Ask the entitlement ledger to
        // finish its exact CAS-protected projection, then require a fresh HTTP
        // retry so source plan/fingerprint/Price are rebuilt from the result.
        try {
            await recomputeSubscriptionEntitlement(subscription._id, {
                allowRestore: true,
                syncFundedPlan: true,
            });
        } catch (error) {
            return {
                pending: true,
                code: 'PLAN_CHANGE_ENTITLEMENT_SYNC_RETRY',
                msg: 'Stripe funding reconciliation is not yet complete. No new plan change was started; retry shortly.',
                retryAfterSeconds: 15,
            };
        }
        const reconciled = await SellerSubscription.findById(subscription._id);
        if (
            reconciled?.planChangeAttempt?.state === 'processing'
            && reconciled.planChangeAttempt.processingToken === current.processingToken
        ) {
            return {
                pending: true,
                code: 'PLAN_CHANGE_ENTITLEMENT_SYNC_RETRY',
                msg: 'Stripe funding reconciliation still owns this subscription. No new plan change was started; retry shortly.',
                retryAfterSeconds: 15,
            };
        }
        return {
            pending: true,
            code: 'PLAN_CHANGE_ENTITLEMENT_SYNC_RECONCILED',
            msg: 'Stripe funding reconciliation completed. Retry the plan change so it uses the refreshed funded plan and Price.',
            retryAfterSeconds: 1,
        };
    }

    const stalePreMutationAttempt = (
        ['processing', 'recoverable'].includes(current.state)
        && current.requestFingerprint !== requestFingerprint
        && current.startedAt
        && current.startedAt <= staleBefore
        // The subscription update is invoked only after the target Price ID is
        // durably stored. Without that identity, a crashed generation may have
        // orphaned a Product/Price creation request, but it cannot have mutated
        // the recurring subscription. A different seller request can therefore
        // supersede this generation without guessing at a Stripe outcome.
        && !current.stripePriceId
    );
    if (stalePreMutationAttempt) {
        const terminalized = await SellerSubscription.findOneAndUpdate({
            _id: subscription._id,
            stripeSubscriptionId: subscription.stripeSubscriptionId,
            'planChangeAttempt.idempotencyToken': current.idempotencyToken,
            'planChangeAttempt.requestFingerprint': current.requestFingerprint,
            'planChangeAttempt.state': current.state,
            'planChangeAttempt.processingToken': current.processingToken || null,
            'planChangeAttempt.startedAt': { $lte: staleBefore },
            $or: [
                { 'planChangeAttempt.stripePriceId': null },
                { 'planChangeAttempt.stripePriceId': { $exists: false } },
            ],
        }, {
            $set: {
                'planChangeAttempt.state': null,
                'planChangeAttempt.processingToken': null,
                'planChangeAttempt.completedAt': now,
                'planChangeAttempt.lastError': 'A stale pre-mutation plan change was replaced by a newer seller request.',
            },
        }, { new: true });
        if (!terminalized) return { pending: true };
        subscription = terminalized;
        current = subscription.planChangeAttempt || {};
    }

    if (
        current.requestFingerprint === requestFingerprint
        && current.idempotencyToken
        && (
            current.state === 'recoverable'
            || current.state === 'pending_payment'
            || (current.state === 'processing' && current.startedAt && current.startedAt <= staleBefore)
        )
    ) {
        idempotencyToken = current.idempotencyToken;
        claimFilter = {
            _id: subscription._id,
            stripeSubscriptionId: subscription.stripeSubscriptionId,
            'planChangeAttempt.idempotencyToken': idempotencyToken,
            'planChangeAttempt.requestFingerprint': requestFingerprint,
            'planChangeAttempt.state': current.state,
        };
    } else if (!current.state || current.state === 'applied') {
        idempotencyToken = crypto.randomUUID();
        isNewAttempt = true;
        claimFilter = {
            _id: subscription._id,
            stripeSubscriptionId: subscription.stripeSubscriptionId,
            ...(current.state === 'applied'
                ? {
                    'planChangeAttempt.state': 'applied',
                    'planChangeAttempt.idempotencyToken': current.idempotencyToken,
                }
                : {
                    $or: [
                        { 'planChangeAttempt.state': null },
                        { 'planChangeAttempt.state': { $exists: false } },
                    ],
                }),
        };
    } else {
        return { pending: true };
    }

    const claimed = await SellerSubscription.findOneAndUpdate(claimFilter, {
        $set: {
            'planChangeAttempt.idempotencyToken': idempotencyToken,
            'planChangeAttempt.requestFingerprint': requestFingerprint,
            'planChangeAttempt.changeKind': target.changeKind,
            'planChangeAttempt.stripeSubscriptionId': subscription.stripeSubscriptionId,
            'planChangeAttempt.targetPlan': target.plan,
            'planChangeAttempt.targetPlanName': target.planName,
            'planChangeAttempt.targetIncludeMetaAds': target.includeMetaAds,
            'planChangeAttempt.targetUnitAmountMinor': target.unitAmount,
            'planChangeAttempt.state': 'processing',
            'planChangeAttempt.processingToken': processingToken,
            'planChangeAttempt.startedAt': now,
            'planChangeAttempt.completedAt': null,
            'planChangeAttempt.lastError': '',
            ...(isNewAttempt ? {
                'planChangeAttempt.stripeSubscriptionItemId': null,
                'planChangeAttempt.stripeProductId': null,
                'planChangeAttempt.stripePriceId': null,
                'planChangeAttempt.stripeInvoiceId': null,
                'planChangeAttempt.sourcePlan': subscription.plan,
                'planChangeAttempt.sourcePlanName': subscription.planName,
                'planChangeAttempt.sourceIncludeMetaAds': Boolean(subscription.metaAdsIncluded),
                'planChangeAttempt.sourceUnitAmountMinor': null,
                'planChangeAttempt.sourceStripeProductId': subscription.stripeProductId || null,
                'planChangeAttempt.sourceStripePriceId': subscription.stripePriceId || null,
                'planChangeAttempt.sourceBonusFeaturesActive': Boolean(subscription.bonusFeaturesActive),
                'planChangeAttempt.sourceBonusExpiryDate': subscription.bonusExpiryDate || null,
                'planChangeAttempt.sourceBonusFeaturesExpiredPermanently': Boolean(subscription.bonusFeaturesExpiredPermanently),
                'planChangeAttempt.sourceBonusGraceDeadline': subscription.bonusGraceDeadline || null,
                'planChangeAttempt.pendingUpdateExpiresAt': null,
                'planChangeAttempt.notificationState': null,
                'planChangeAttempt.notificationToken': null,
                'planChangeAttempt.notificationStartedAt': null,
                'planChangeAttempt.notificationCompletedAt': null,
                'planChangeAttempt.notificationLastError': '',
                'planChangeAttempt.notificationEmailState': null,
                'planChangeAttempt.notificationWhatsAppState': null,
                'planChangeAttempt.notificationInAppState': null,
                'planChangeAttempt.notificationPushState': null,
            } : {}),
        },
    }, { new: true });

    if (claimed) {
        return {
            subscription: claimed,
            idempotencyToken,
            processingToken,
            resumed: !isNewAttempt,
            previousState: current.state || null,
        };
    }

    const latest = await SellerSubscription.findById(subscription._id);
    if (
        latest?.planChangeAttempt?.state === 'applied'
        && latest.planChangeAttempt.requestFingerprint === requestFingerprint
    ) {
        return { applied: true, subscription: latest };
    }
    return { pending: true };
}

const stripeInvoiceObject = stripeSubscription => (
    stripeSubscription && typeof stripeSubscription.latest_invoice === 'object'
        ? stripeSubscription.latest_invoice
        : null
);

const pendingUpdateMatchesTarget = (stripeSubscription, {
    priceId,
    subscriptionItemId,
    invoiceId = null,
}) => {
    const pendingItems = stripeSubscription?.pending_update?.subscription_items;
    if (
        !Array.isArray(pendingItems)
        || pendingItems.length !== 1
        || stripeHasDiscounts(stripeSubscription.pending_update)
    ) return false;
    const pendingItem = pendingItems[0];
    const quantity = pendingItem?.quantity;
    const latestInvoiceId = stripeObjectId(stripeSubscription.latest_invoice);
    return (
        stripeObjectId(pendingItem?.price) === String(priceId || '')
        && stripeObjectId(pendingItem?.id) === String(subscriptionItemId || '')
        && Number.isSafeInteger(quantity)
        && quantity === 1
        && !stripeHasDiscounts(pendingItem)
        && (!invoiceId || latestInvoiceId === String(invoiceId))
    );
};

async function persistPlanChangeAttemptFields(subscriptionId, attempt, fields) {
    const updates = Object.fromEntries(Object.entries(fields).map(([key, value]) => (
        [`planChangeAttempt.${key}`, value]
    )));
    const result = await SellerSubscription.updateOne({
        _id: subscriptionId,
        'planChangeAttempt.idempotencyToken': attempt.idempotencyToken,
        'planChangeAttempt.processingToken': attempt.processingToken,
        'planChangeAttempt.state': 'processing',
    }, { $set: updates });
    if (Number(result.matchedCount ?? result.n ?? 0) !== 1) {
        const error = new Error('The durable plan-change claim was lost while Stripe identities were being saved.');
        error.code = 'PLAN_CHANGE_CLAIM_LOST';
        throw error;
    }
}

async function bindPlanChangeSourceSnapshot(subscription, attempt, snapshot) {
    const current = subscription.planChangeAttempt || {};
    const immutablePairs = [
        ['stripeSubscriptionItemId', snapshot.itemId],
        ['sourceStripePriceId', snapshot.priceId],
        ['sourceStripeProductId', snapshot.productId],
        ['sourceUnitAmountMinor', snapshot.unitAmount],
    ];
    for (const [key, value] of immutablePairs) {
        if (current[key] !== null && current[key] !== undefined && String(current[key]) !== String(value)) {
            const error = new Error(`Stripe changed the immutable plan-change source ${key}.`);
            error.code = 'PLAN_CHANGE_SOURCE_CHANGED';
            throw error;
        }
    }
    const result = await SellerSubscription.updateOne({
        _id: subscription._id,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        'planChangeAttempt.idempotencyToken': attempt.idempotencyToken,
        'planChangeAttempt.processingToken': attempt.processingToken,
        'planChangeAttempt.state': 'processing',
    }, {
        $set: {
            stripeProductId: snapshot.productId,
            stripePriceId: snapshot.priceId,
            'planChangeAttempt.stripeSubscriptionItemId': snapshot.itemId,
            'planChangeAttempt.sourceStripeProductId': snapshot.productId,
            'planChangeAttempt.sourceStripePriceId': snapshot.priceId,
            'planChangeAttempt.sourceUnitAmountMinor': snapshot.unitAmount,
        },
    });
    if (Number(result.matchedCount ?? result.n ?? 0) !== 1) {
        const error = new Error('The durable plan-change source snapshot could not be saved.');
        error.code = 'PLAN_CHANGE_CLAIM_LOST';
        throw error;
    }
    subscription.stripeProductId = snapshot.productId;
    subscription.stripePriceId = snapshot.priceId;
    Object.assign(subscription.planChangeAttempt, {
        stripeSubscriptionItemId: snapshot.itemId,
        sourceStripeProductId: snapshot.productId,
        sourceStripePriceId: snapshot.priceId,
        sourceUnitAmountMinor: snapshot.unitAmount,
    });
}

async function markPlanChangeRecoverable(subscriptionId, attempt, error) {
    await SellerSubscription.updateOne({
        _id: subscriptionId,
        'planChangeAttempt.idempotencyToken': attempt.idempotencyToken,
        'planChangeAttempt.processingToken': attempt.processingToken,
    }, {
        $set: {
            'planChangeAttempt.state': 'recoverable',
            'planChangeAttempt.processingToken': null,
            'planChangeAttempt.lastError': String(error?.message || 'Stripe plan change outcome is uncertain.'),
        },
    });
}

async function markPlanChangePendingPayment(subscriptionId, attempt, {
    invoiceId = null,
    expiresAt = null,
    reason = 'Stripe is waiting for the plan-change payment.',
} = {}) {
    if (!invoiceId) {
        const error = new Error('Stripe did not return the exact pending-update invoice.');
        error.code = 'PLAN_CHANGE_INVOICE_MISSING';
        throw error;
    }
    const result = await SellerSubscription.updateOne({
        _id: subscriptionId,
        'planChangeAttempt.idempotencyToken': attempt.idempotencyToken,
        'planChangeAttempt.processingToken': attempt.processingToken,
        'planChangeAttempt.state': 'processing',
        $or: [
            { 'planChangeAttempt.stripeInvoiceId': null },
            { 'planChangeAttempt.stripeInvoiceId': { $exists: false } },
            { 'planChangeAttempt.stripeInvoiceId': invoiceId },
        ],
    }, {
        $set: {
            'planChangeAttempt.state': 'pending_payment',
            'planChangeAttempt.processingToken': null,
            ...(invoiceId ? { 'planChangeAttempt.stripeInvoiceId': invoiceId } : {}),
            ...(expiresAt ? { 'planChangeAttempt.pendingUpdateExpiresAt': expiresAt } : {}),
            'planChangeAttempt.lastError': reason,
        },
    });
    if (Number(result.matchedCount ?? result.n ?? 0) === 1) return;

    // An exact action-required webhook can bind and transition the generation
    // while the originating HTTP request is still awaiting Stripe. Treat that
    // same terminal pending state as idempotent, and preserve the webhook's
    // more specific authentication message.
    const alreadyPending = await SellerSubscription.updateOne({
        _id: subscriptionId,
        'planChangeAttempt.idempotencyToken': attempt.idempotencyToken,
        'planChangeAttempt.processingToken': null,
        'planChangeAttempt.state': 'pending_payment',
        'planChangeAttempt.stripeInvoiceId': invoiceId,
    }, {
        $set: {
            'planChangeAttempt.state': 'pending_payment',
            ...(expiresAt ? { 'planChangeAttempt.pendingUpdateExpiresAt': expiresAt } : {}),
        },
    });
    if (Number(alreadyPending.matchedCount ?? alreadyPending.n ?? 0) === 1) return;

    const error = new Error('Stripe replaced the immutable pending-update invoice generation.');
    error.code = 'PLAN_CHANGE_SUPERSEDED';
    throw error;
}

async function clearDefinitivePlanChangeAttempt(subscriptionId, attempt, error) {
    await SellerSubscription.updateOne({
        _id: subscriptionId,
        'planChangeAttempt.idempotencyToken': attempt.idempotencyToken,
        'planChangeAttempt.processingToken': attempt.processingToken,
    }, {
        $set: {
            'planChangeAttempt.state': null,
            'planChangeAttempt.processingToken': null,
            'planChangeAttempt.completedAt': new Date(),
            'planChangeAttempt.lastError': String(error?.message || 'Stripe declined the plan change.'),
        },
    });
}

const invoiceSubscriptionId = invoice => stripeObjectId(
    invoice?.subscription || invoice?.parent?.subscription_details?.subscription,
);

const invoiceLineSubscriptionItemId = line => stripeObjectId(
    line?.parent?.subscription_item_details?.subscription_item
    || line?.subscription_item,
);

const invoiceLinePriceId = line => stripeObjectId(
    line?.pricing?.price_details?.price || line?.price,
);

const invoiceLineProductId = line => stripeObjectId(
    line?.pricing?.price_details?.product || line?.price?.product,
);

async function loadCompletePlanChangeInvoice(invoice) {
    if (!invoice || invoice?.lines?.has_more !== true) return invoice;
    if (!stripe?.invoices?.listLineItems || !stripeObjectId(invoice)) return null;
    const lines = [];
    let startingAfter;
    for (let page = 0; page < 100; page += 1) {
        const response = await stripe.invoices.listLineItems(stripeObjectId(invoice), {
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
        });
        const data = Array.isArray(response?.data) ? response.data : [];
        lines.push(...data);
        if (!response?.has_more) {
            return { ...invoice, lines: { data: lines, has_more: false } };
        }
        startingAfter = stripeObjectId(data.at(-1));
        if (!startingAfter) break;
    }
    return null;
}

function exactPlanChangeInvoiceLines(invoice, {
    expectedSubscriptionId,
    expectedSubscriptionItemId,
    expectedPriceId,
    expectedProductId,
    expectedUnitAmount,
    expectedSourcePriceId = null,
    expectedSourceProductId = null,
    expectedSourceUnitAmount = null,
}) {
    const lineList = invoice?.lines;
    const lines = lineList?.data;
    if (
        !Array.isArray(lines)
        || lineList?.has_more !== false
        || stripeHasDiscounts(invoice)
        || (Array.isArray(invoice?.total_discount_amounts) && invoice.total_discount_amounts.length > 0)
    ) return false;
    let targetLines = 0;
    for (const line of lines) {
        const amount = line?.amount;
        if (!Number.isSafeInteger(amount)) return false;
        const quantity = line?.quantity;
        const lineSubscriptionId = stripeObjectId(
            line?.parent?.subscription_item_details?.subscription || line?.subscription,
        );
        const lineItemId = invoiceLineSubscriptionItemId(line);
        const linePriceId = invoiceLinePriceId(line);
        const lineProductId = invoiceLineProductId(line);
        const unitAmountDecimal = stripeIntegerDecimal(line?.pricing?.unit_amount_decimal);
        if (
            lineSubscriptionId !== String(expectedSubscriptionId)
            || lineItemId !== String(expectedSubscriptionItemId)
            || !Number.isSafeInteger(quantity)
            || quantity !== 1
            || String(line?.currency || invoice.currency || '').toLowerCase() !== 'usd'
            || stripeHasDiscounts(line)
            || (Array.isArray(line?.discount_amounts) && line.discount_amounts.length > 0)
        ) return false;
        if (amount < 0) {
            if (
                !expectedSourcePriceId
                || !expectedSourceProductId
                || linePriceId !== String(expectedSourcePriceId)
                || lineProductId !== String(expectedSourceProductId)
                || !Number.isSafeInteger(expectedSourceUnitAmount)
                || unitAmountDecimal !== expectedSourceUnitAmount
            ) return false;
            continue;
        }
        if (
            linePriceId !== String(expectedPriceId)
            || lineProductId !== String(expectedProductId)
            || !Number.isSafeInteger(expectedUnitAmount)
            || unitAmountDecimal !== expectedUnitAmount
        ) return false;
        targetLines += 1;
    }
    return targetLines === 1;
}

async function exactPendingPlanChangeInvoice(stripeSubscription, subscription, attempt) {
    const invoiceId = stripeObjectId(stripeSubscription?.latest_invoice);
    let invoice = stripeInvoiceObject(stripeSubscription);
    if (!invoiceId) return { ok: false, reason: 'Stripe did not return a pending-update invoice.' };
    if (!invoice || stripeObjectId(invoice) !== invoiceId) {
        if (!stripe?.invoices?.retrieve) {
            return { ok: false, reason: 'Stripe invoice retrieval is unavailable.' };
        }
        invoice = await stripe.invoices.retrieve(invoiceId);
    }
    invoice = await loadCompletePlanChangeInvoice(invoice);
    if (
        !invoice
        || !['draft', 'open', 'uncollectible'].includes(String(invoice.status || ''))
        || stripeObjectId(invoice.customer) !== String(subscription.stripeCustomerId)
        || invoiceSubscriptionId(invoice) !== String(subscription.stripeSubscriptionId)
        || String(invoice.billing_reason || '') !== 'subscription_update'
        || String(invoice.currency || '').toLowerCase() !== 'usd'
        || !Number.isSafeInteger(invoice.amount_remaining)
        || invoice.amount_remaining < 0
        || !exactPlanChangeInvoiceLines(invoice, {
            expectedSubscriptionId: subscription.stripeSubscriptionId,
            expectedSubscriptionItemId: attempt.stripeSubscriptionItemId,
            expectedPriceId: attempt.stripePriceId,
            expectedProductId: attempt.stripeProductId,
            expectedUnitAmount: attempt.targetUnitAmountMinor,
            expectedSourcePriceId: attempt.sourceStripePriceId,
            expectedSourceProductId: attempt.sourceStripeProductId,
            expectedSourceUnitAmount: attempt.sourceUnitAmountMinor,
        })
    ) {
        return { ok: false, reason: 'Stripe pending invoice does not match the exact durable plan-change generation.' };
    }
    return { ok: true, invoice, invoiceId };
}

async function bindIncomingPlanChangeInvoiceIfExact(invoice) {
    const invoiceId = stripeObjectId(invoice);
    const subscriptionId = invoiceSubscriptionId(invoice);
    if (
        !invoiceId
        || !subscriptionId
        || String(invoice?.billing_reason || '') !== 'subscription_update'
    ) return null;
    const subscription = await SellerSubscription.findOne({ stripeSubscriptionId: subscriptionId });
    const attempt = subscription?.planChangeAttempt || {};
    if (
        !subscription
        || !activePlanChangeStates.includes(attempt.state)
        || attempt.changeKind === 'meta_removal'
        || !attempt.idempotencyToken
        || !attempt.stripeSubscriptionItemId
        || !attempt.stripeProductId
        || !attempt.stripePriceId
        || (attempt.stripeInvoiceId && String(attempt.stripeInvoiceId) !== invoiceId)
    ) return subscription;

    const completeInvoice = await loadCompletePlanChangeInvoice(invoice);
    if (
        !completeInvoice
        || stripeObjectId(completeInvoice.customer) !== String(subscription.stripeCustomerId)
        || invoiceSubscriptionId(completeInvoice) !== String(subscription.stripeSubscriptionId)
        || String(completeInvoice.currency || '').toLowerCase() !== 'usd'
        || !exactPlanChangeInvoiceLines(completeInvoice, {
            expectedSubscriptionId: subscription.stripeSubscriptionId,
            expectedSubscriptionItemId: attempt.stripeSubscriptionItemId,
            expectedPriceId: attempt.stripePriceId,
            expectedProductId: attempt.stripeProductId,
            expectedUnitAmount: attempt.targetUnitAmountMinor,
            expectedSourcePriceId: attempt.sourceStripePriceId,
            expectedSourceProductId: attempt.sourceStripeProductId,
            expectedSourceUnitAmount: attempt.sourceUnitAmountMinor,
        })
    ) return subscription;

    const stripeSubscription = await retrievePlanChangeStripeSubscription(subscription.stripeSubscriptionId);
    const exactPending = stripeSubscription.pending_update
        && pendingUpdateMatchesTarget(stripeSubscription, {
            priceId: attempt.stripePriceId,
            subscriptionItemId: attempt.stripeSubscriptionItemId,
            invoiceId,
        });
    const exactPaid = !stripeSubscription.pending_update
        && (await stripePlanChangeIsAuthoritative(stripeSubscription, {
            expectedSubscriptionId: subscription.stripeSubscriptionId,
            expectedCustomerId: subscription.stripeCustomerId,
            expectedUnitAmount: attempt.targetUnitAmountMinor,
            expectedPriceId: attempt.stripePriceId,
            expectedProductId: attempt.stripeProductId,
            expectedSubscriptionItemId: attempt.stripeSubscriptionItemId,
            expectedInvoiceId: invoiceId,
            expectedSourcePriceId: attempt.sourceStripePriceId,
            expectedSourceProductId: attempt.sourceStripeProductId,
            expectedSourceUnitAmount: attempt.sourceUnitAmountMinor,
            invoiceOverride: completeInvoice,
        })).ok;
    if (!exactPending && !exactPaid) return subscription;

    const bound = await bindPlanChangeInvoice(
        subscription._id,
        attempt.idempotencyToken,
        invoiceId,
        stripePendingUpdateExpiryDate(stripeSubscription.pending_update?.expires_at),
    );
    return bound ? SellerSubscription.findById(subscription._id) : subscription;
}

async function stripePlanChangeIsAuthoritative(stripeSubscription, {
    expectedSubscriptionId,
    expectedCustomerId,
    expectedUnitAmount,
    expectedPriceId = null,
    expectedProductId = null,
    expectedSubscriptionItemId = null,
    expectedInvoiceId = null,
    expectedSourcePriceId = null,
    expectedSourceProductId = null,
    expectedSourceUnitAmount = null,
    invoiceOverride = null,
    allowUnpaidRemoval = false,
}) {
    if (!stripeSubscription || String(stripeSubscription.id || '') !== String(expectedSubscriptionId)) {
        return { ok: false, reason: 'Stripe returned a different subscription.' };
    }
    if (stripeObjectId(stripeSubscription.customer) !== String(expectedCustomerId)) {
        return { ok: false, reason: 'Stripe returned a subscription for a different customer.' };
    }
    if (stripeSubscription.pending_update) {
        return { ok: false, reason: 'Stripe is still waiting for the plan-change payment.' };
    }

    const itemAuthority = exactStripeSubscriptionItem(stripeSubscription, {
        expectedItemId: expectedSubscriptionItemId,
        expectedPriceId,
        expectedProductId,
        expectedUnitAmount,
    });
    if (!itemAuthority.ok) return itemAuthority;

    if (stripeSubscription.status === 'trialing' && allowUnpaidRemoval) {
        return { ok: true, trialing: true };
    }
    if (stripeSubscription.status !== 'active') {
        return { ok: false, reason: `Stripe subscription status is ${stripeSubscription.status || 'unknown'}.` };
    }

    if (allowUnpaidRemoval) return { ok: true, trialing: false, item: itemAuthority };

    if (!expectedInvoiceId) {
        return { ok: false, reason: 'The durable plan-change invoice generation is not bound.' };
    }
    const invoice = await loadCompletePlanChangeInvoice(
        invoiceOverride || stripeInvoiceObject(stripeSubscription),
    );
    if (
        !invoice
        || stripeObjectId(invoice) !== String(expectedInvoiceId)
        || invoice.status !== 'paid'
        || !Number.isSafeInteger(invoice.amount_paid)
        || invoice.amount_paid < 0
        || !Number.isSafeInteger(invoice.amount_remaining)
        || invoice.amount_remaining !== 0
        || String(invoice.currency || '').toLowerCase() !== 'usd'
        || String(invoice.billing_reason || '') !== 'subscription_update'
    ) {
        return { ok: false, reason: 'Stripe has not confirmed the immediate plan-change invoice as paid.' };
    }
    if (stripeObjectId(invoice.customer) !== String(expectedCustomerId)) {
        return { ok: false, reason: 'Stripe returned an invoice for a different customer.' };
    }
    if (invoiceSubscriptionId(invoice) !== String(expectedSubscriptionId)) {
        return { ok: false, reason: 'Stripe returned an invoice for a different subscription.' };
    }
    if (!exactPlanChangeInvoiceLines(invoice, {
        expectedSubscriptionId,
        expectedSubscriptionItemId,
        expectedPriceId,
        expectedProductId,
        expectedUnitAmount,
        expectedSourcePriceId,
        expectedSourceProductId,
        expectedSourceUnitAmount,
    })) {
        return { ok: false, reason: 'Stripe invoice lines do not match the exact durable plan-change generation.' };
    }
    return { ok: true, trialing: false, invoice, item: itemAuthority };
}

const PLAN_CHANGE_STRIPE_EXPAND = [
    'items.data.price.product',
    'latest_invoice.confirmation_secret',
];

async function retrievePlanChangeStripeSubscription(stripeSubscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId, {
        expand: PLAN_CHANGE_STRIPE_EXPAND,
    });
    if (
        typeof subscription?.latest_invoice === 'string'
        && stripe?.invoices?.retrieve
    ) {
        subscription.latest_invoice = await stripe.invoices.retrieve(
            subscription.latest_invoice,
            { expand: ['confirmation_secret', 'payments.data.payment.payment_intent'] },
        );
    }
    const item = subscription?.items?.data?.[0];
    if (typeof item?.price === 'string' && stripe?.prices?.retrieve) {
        item.price = await stripe.prices.retrieve(item.price, { expand: ['product'] });
    }
    return subscription;
}

function durablePlanChangeMetadataMatches(metadata, subscription, attempt, target) {
    return (
        String(metadata?.sellerId || '') === String(subscription.seller)
        && String(metadata?.stripeSubscriptionId || '') === String(subscription.stripeSubscriptionId)
        && String(metadata?.planChangeToken || '') === String(attempt.idempotencyToken)
        && String(metadata?.plan || '') === String(target.plan)
        && String(metadata?.includeMetaAds || '') === String(Boolean(target.includeMetaAds))
    );
}

async function ensureDurablePlanChangePrice(subscription, attempt, target, subscriptionItemId) {
    if (
        !stripe?.products?.create
        || !stripe?.products?.retrieve
        || !stripe?.prices?.create
        || !stripe?.prices?.retrieve
    ) {
        const error = new Error('Stripe Product/Price creation is not configured for paid plan changes.');
        error.code = 'PLAN_CHANGE_PRICE_API_UNAVAILABLE';
        throw error;
    }

    const metadata = {
        sellerId: String(subscription.seller),
        stripeSubscriptionId: String(subscription.stripeSubscriptionId),
        planChangeToken: attempt.idempotencyToken,
        plan: target.plan,
        includeMetaAds: String(target.includeMetaAds),
    };
    if (subscriptionItemId !== subscription.planChangeAttempt?.stripeSubscriptionItemId) {
        await persistPlanChangeAttemptFields(subscription._id, attempt, {
            stripeSubscriptionItemId: subscriptionItemId,
        });
        subscription.planChangeAttempt.stripeSubscriptionItemId = subscriptionItemId;
    }

    let productId = subscription.planChangeAttempt?.stripeProductId;
    let product;
    if (!productId) {
        product = await stripe.products.create({
            name: target.planName,
            description: `${target.planName} recurring subscription`,
            metadata,
        }, {
            idempotencyKey: `rozare-plan-change-product-${subscription._id}-${attempt.idempotencyToken}`,
        });
        productId = stripeObjectId(product);
        if (
            !productId
            || product.active === false
            || !durablePlanChangeMetadataMatches(product.metadata, subscription, attempt, target)
        ) {
            const error = new Error('Stripe did not return the durable plan-change Product ID.');
            error.code = 'PLAN_CHANGE_PRODUCT_INVALID';
            throw error;
        }
        await persistPlanChangeAttemptFields(subscription._id, attempt, { stripeProductId: productId });
        subscription.planChangeAttempt.stripeProductId = productId;
    } else {
        product = await stripe.products.retrieve(productId);
        if (
            stripeObjectId(product) !== String(productId)
            || product.active === false
            || !durablePlanChangeMetadataMatches(product.metadata, subscription, attempt, target)
        ) {
            const error = new Error('The durable plan-change Product no longer matches this attempt.');
            error.code = 'PLAN_CHANGE_PRODUCT_INVALID';
            throw error;
        }
    }

    let priceId = subscription.planChangeAttempt?.stripePriceId;
    let price;
    if (!priceId) {
        price = await stripe.prices.create({
            currency: 'usd',
            unit_amount: target.unitAmount,
            recurring: { interval: 'month' },
            product: productId,
            metadata,
        }, {
            idempotencyKey: `rozare-plan-change-price-${subscription._id}-${attempt.idempotencyToken}`,
        });
        priceId = stripeObjectId(price);
        if (
            !priceId
            || String(price.currency || '').toLowerCase() !== 'usd'
            || !Number.isSafeInteger(price.unit_amount)
            || price.unit_amount !== target.unitAmount
            || stripeObjectId(price.product) !== String(productId)
            || price.recurring?.interval !== 'month'
            || price.active === false
            || !durablePlanChangeMetadataMatches(price.metadata, subscription, attempt, target)
        ) {
            const error = new Error('Stripe returned a Price that does not match the durable plan-change target.');
            error.code = 'PLAN_CHANGE_PRICE_INVALID';
            throw error;
        }
        await persistPlanChangeAttemptFields(subscription._id, attempt, { stripePriceId: priceId });
        subscription.planChangeAttempt.stripePriceId = priceId;
    } else {
        price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
        if (
            stripeObjectId(price) !== String(priceId)
            || String(price.currency || '').toLowerCase() !== 'usd'
            || !Number.isSafeInteger(price.unit_amount)
            || price.unit_amount !== target.unitAmount
            || stripeObjectId(price.product) !== String(productId)
            || price.recurring?.interval !== 'month'
            || price.active === false
            || !durablePlanChangeMetadataMatches(price.metadata, subscription, attempt, target)
        ) {
            const error = new Error('The durable plan-change Price no longer matches this attempt.');
            error.code = 'PLAN_CHANGE_PRICE_INVALID';
            throw error;
        }
    }
    return priceId;
}

async function bindPlanChangeInvoice(subscriptionId, attemptToken, invoiceId, expiresAt = null) {
    if (!invoiceId) return false;
    const result = await SellerSubscription.updateOne({
        _id: subscriptionId,
        'planChangeAttempt.idempotencyToken': attemptToken,
        'planChangeAttempt.state': { $in: ['processing', 'pending_payment', 'recoverable'] },
        $or: [
            { 'planChangeAttempt.stripeInvoiceId': null },
            { 'planChangeAttempt.stripeInvoiceId': { $exists: false } },
            { 'planChangeAttempt.stripeInvoiceId': invoiceId },
        ],
    }, {
        $set: {
            'planChangeAttempt.stripeInvoiceId': invoiceId,
            ...(expiresAt ? { 'planChangeAttempt.pendingUpdateExpiresAt': expiresAt } : {}),
        },
    });
    return Number(result.matchedCount ?? result.n ?? 0) === 1;
}

async function clearTerminalPlanChangeAttempt(subscriptionId, attemptToken, reason) {
    await SellerSubscription.updateOne({
        _id: subscriptionId,
        'planChangeAttempt.idempotencyToken': attemptToken,
        'planChangeAttempt.state': { $in: ['processing', 'pending_payment', 'recoverable'] },
    }, {
        $set: {
            'planChangeAttempt.state': null,
            'planChangeAttempt.processingToken': null,
            'planChangeAttempt.completedAt': new Date(),
            'planChangeAttempt.lastError': reason,
        },
    });
}

async function assertPlanChangeClaimActive(subscriptionId, attempt) {
    const owned = await planChangeClaimIsActive(subscriptionId, attempt);
    if (!owned) {
        const error = new Error('This plan change was superseded before Stripe was mutated.');
        error.code = 'PLAN_CHANGE_SUPERSEDED';
        throw error;
    }
}

async function planChangeClaimIsActive(subscriptionId, attempt) {
    return SellerSubscription.exists({
        _id: subscriptionId,
        stripeSubscriptionId: attempt.subscription.stripeSubscriptionId,
        'planChangeAttempt.idempotencyToken': attempt.idempotencyToken,
        'planChangeAttempt.processingToken': attempt.processingToken,
        'planChangeAttempt.state': 'processing',
        cancelledAt: null,
        'pendingDowngrade.toPlan': null,
    });
}

async function preservePlanChangeAttemptForStripeOutcome(subscription, attemptToken, {
    invoiceId = null,
    state = 'recoverable',
    lastError,
} = {}) {
    const filter = {
        _id: subscription._id,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        'planChangeAttempt.idempotencyToken': attemptToken,
        'planChangeAttempt.state': { $in: [null, ...activePlanChangeStates] },
    };
    if (invoiceId) {
        filter.$or = [
            { 'planChangeAttempt.stripeInvoiceId': null },
            { 'planChangeAttempt.stripeInvoiceId': { $exists: false } },
            { 'planChangeAttempt.stripeInvoiceId': invoiceId },
        ];
    }
    return SellerSubscription.findOneAndUpdate(filter, {
        $set: {
            'planChangeAttempt.state': state,
            'planChangeAttempt.processingToken': null,
            ...(invoiceId ? { 'planChangeAttempt.stripeInvoiceId': invoiceId } : {}),
            ...(lastError ? { 'planChangeAttempt.lastError': lastError } : {}),
        },
    }, { new: true });
}

async function loadBoundPlanChangeInvoice(stripeSubscription, invoiceId) {
    if (!invoiceId) return null;
    let invoice = stripeInvoiceObject(stripeSubscription);
    if (!invoice || stripeObjectId(invoice) !== String(invoiceId)) {
        if (!stripe?.invoices?.retrieve) return null;
        invoice = await stripe.invoices.retrieve(invoiceId, {
            expand: ['parent.subscription_details.subscription'],
        });
    }
    return loadCompletePlanChangeInvoice(invoice);
}

function planChangeSourceStillExact(subscription, attempt, stripeSubscription) {
    if (
        !stripeSubscription
        || String(stripeSubscription.id || '') !== String(subscription.stripeSubscriptionId)
        || stripeObjectId(stripeSubscription.customer) !== String(subscription.stripeCustomerId)
        || stripeSubscription.pending_update
    ) return false;
    return exactStripeSubscriptionItem(stripeSubscription, {
        expectedItemId: attempt.stripeSubscriptionItemId,
        expectedPriceId: attempt.sourceStripePriceId,
        expectedProductId: attempt.sourceStripeProductId,
        expectedUnitAmount: attempt.sourceUnitAmountMinor,
    }).ok;
}

async function convergePlanChangeAfterVoidRace(subscription, attempt, stripeSubscription, invoice = null) {
    if (stripeSubscription?.pending_update) {
        return { applied: false, subscription };
    }
    if (attempt.changeKind === 'meta_removal') {
        const authority = await stripePlanChangeIsAuthoritative(stripeSubscription, {
            expectedSubscriptionId: subscription.stripeSubscriptionId,
            expectedCustomerId: subscription.stripeCustomerId,
            expectedUnitAmount: attempt.targetUnitAmountMinor,
            expectedPriceId: attempt.stripePriceId,
            expectedProductId: attempt.stripeProductId,
            expectedSubscriptionItemId: attempt.stripeSubscriptionItemId,
            allowUnpaidRemoval: true,
        });
        if (!authority.ok) return { applied: false, subscription };
        const applied = await applyLocalPlanChange(subscription._id, attempt.idempotencyToken, null);
        if (applied.applied) {
            await ensurePlanChangeCompletionNotificationOutboxed(subscription._id, attempt.idempotencyToken);
            applied.subscription = await SellerSubscription.findById(subscription._id);
        }
        return applied;
    }
    return convergePaidPlanChange({
        subscription,
        stripeSubscription,
        ...(invoice ? { paidInvoice: invoice } : {}),
    });
}

async function compensateLostPlanChangeClaim({ subscription, attempt, stripeSubscription }) {
    const durableAttempt = subscription.planChangeAttempt || {};
    if (
        String(stripeSubscription?.id || '') !== String(subscription.stripeSubscriptionId)
        || stripeObjectId(stripeSubscription?.customer) !== String(subscription.stripeCustomerId)
        || durableAttempt.idempotencyToken !== attempt.idempotencyToken
    ) return { applied: false, compensated: false };

    let authoritativeStripeSubscription = stripeSubscription;
    if (authoritativeStripeSubscription.pending_update) {
        if (!pendingUpdateMatchesTarget(stripeSubscription, {
            priceId: durableAttempt.stripePriceId,
            subscriptionItemId: durableAttempt.stripeSubscriptionItemId,
            invoiceId: durableAttempt.stripeInvoiceId,
        })) return { applied: false, compensated: false };
        const exactPending = await exactPendingPlanChangeInvoice(
            stripeSubscription,
            subscription,
            durableAttempt,
        );
        if (!exactPending.ok || !stripe?.invoices?.voidInvoice) {
            return { applied: false, compensated: false };
        }
        durableAttempt.stripeInvoiceId = exactPending.invoiceId;
        let voidConfirmed = false;
        let voidError = null;
        try {
            const voidedInvoice = await stripe.invoices.voidInvoice(exactPending.invoiceId, {}, {
                idempotencyKey: `rozare-plan-change-void-${subscription._id}-${attempt.idempotencyToken}`,
            });
            voidConfirmed = String(voidedInvoice?.status || '') === 'void';
        } catch (error) {
            // Payment can win between the exact pending-invoice read and the
            // void request. Stripe then rejects the void because the Invoice
            // is paid or its PaymentIntent is already settling. Resolve that
            // race from freshly retrieved authoritative objects below.
            voidError = error;
        }
        try {
            authoritativeStripeSubscription = await retrievePlanChangeStripeSubscription(
                subscription.stripeSubscriptionId,
            );
        } catch (refreshError) {
            throw voidError || refreshError;
        }
        const pendingStillOwned = pendingUpdateMatchesTarget(authoritativeStripeSubscription, {
            priceId: durableAttempt.stripePriceId,
            subscriptionItemId: durableAttempt.stripeSubscriptionItemId,
            invoiceId: exactPending.invoiceId,
        });
        const preserved = await preservePlanChangeAttemptForStripeOutcome(
            subscription,
            attempt.idempotencyToken,
            {
                invoiceId: exactPending.invoiceId,
                state: pendingStillOwned ? 'pending_payment' : 'recoverable',
                lastError: pendingStillOwned
                    ? 'Cancellation or downgrade is scheduled while Stripe is still resolving the exact plan-change payment.'
                    : 'Stripe changed the exact pending invoice while cancellation or downgrade superseded the HTTP claim.',
            },
        );
        if (!preserved) {
            const latest = await SellerSubscription.findById(subscription._id);
            if (
                latest?.planChangeAttempt?.idempotencyToken === attempt.idempotencyToken
                && latest.planChangeAttempt.state === 'applied'
            ) return { applied: true, reused: true, subscription: latest };
            return { applied: false, compensated: false, subscription: latest };
        }
        if (pendingStillOwned) {
            return {
                applied: false,
                compensated: false,
                pending: true,
                subscription: preserved,
                reason: voidError?.message || 'Stripe still reports the exact pending plan-change payment.',
            };
        }

        const refreshedInvoice = await loadBoundPlanChangeInvoice(
            authoritativeStripeSubscription,
            exactPending.invoiceId,
        );
        const winner = await convergePlanChangeAfterVoidRace(
            preserved,
            durableAttempt,
            authoritativeStripeSubscription,
            refreshedInvoice,
        );
        if (winner.applied) return winner;

        if (voidConfirmed || String(refreshedInvoice?.status || '') === 'void') {
            await clearTerminalPlanChangeAttempt(
                subscription._id,
                attempt.idempotencyToken,
                'The plan change was superseded and its unpaid Stripe invoice was voided.',
            );
            return {
                applied: false,
                compensated: true,
                subscription: await SellerSubscription.findById(subscription._id),
            };
        }
        return {
            applied: false,
            compensated: false,
            pending: true,
            subscription: preserved,
            reason: voidError?.message || 'Stripe has not proven the exact plan-change invoice to be terminal and unpaid.',
        };
    }

    const restored = await preservePlanChangeAttemptForStripeOutcome(
        subscription,
        attempt.idempotencyToken,
        {
            state: 'recoverable',
            lastError: 'Stripe completed this plan change while cancellation or downgrade superseded the HTTP claim.',
        },
    );
    if (!restored) {
        const latest = await SellerSubscription.findById(subscription._id);
        if (
            latest?.planChangeAttempt?.idempotencyToken === attempt.idempotencyToken
            && latest.planChangeAttempt.state === 'applied'
        ) return { applied: true, reused: true, subscription: latest };
        return { applied: false, compensated: false, subscription: latest };
    }
    return convergePlanChangeAfterVoidRace(
        restored,
        durableAttempt,
        authoritativeStripeSubscription,
    );
}

function terminalizePlanChangeForSubscriptionReplacement(subscription, previousSubscriptionId, nextSubscriptionId) {
    const attempt = subscription?.planChangeAttempt;
    if (
        !attempt
        || !activePlanChangeStates.includes(attempt.state)
        || !attempt.stripeSubscriptionId
        || String(attempt.stripeSubscriptionId) !== String(previousSubscriptionId || '')
        || String(previousSubscriptionId || '') === String(nextSubscriptionId || '')
    ) return false;
    attempt.state = null;
    attempt.processingToken = null;
    attempt.pendingUpdateExpiresAt = null;
    attempt.completedAt = new Date();
    attempt.lastError = 'The Stripe subscription was replaced before this plan change completed.';
    return true;
}

async function supersedeActivePlanChange(subscription, reason) {
    let current = await SellerSubscription.findById(subscription._id);
    let attempt = current?.planChangeAttempt || {};
    if (!current || !activePlanChangeStates.includes(attempt.state) || !attempt.idempotencyToken) {
        return current || subscription;
    }
    if (
        !attempt.stripeSubscriptionId
        || String(attempt.stripeSubscriptionId) !== String(current.stripeSubscriptionId)
    ) {
        await clearTerminalPlanChangeAttempt(current._id, attempt.idempotencyToken, reason);
        return SellerSubscription.findById(current._id);
    }

    const stripeSubscription = await retrievePlanChangeStripeSubscription(current.stripeSubscriptionId);
    if (
        String(stripeSubscription?.id || '') !== String(current.stripeSubscriptionId)
        || stripeObjectId(stripeSubscription?.customer) !== String(current.stripeCustomerId)
    ) {
        const error = new Error('Stripe subscription ownership changed while the plan change was being superseded.');
        error.code = 'PLAN_CHANGE_OWNERSHIP_MISMATCH';
        throw error;
    }

    if (!stripeSubscription.pending_update) {
        const invoice = await loadBoundPlanChangeInvoice(stripeSubscription, attempt.stripeInvoiceId);
        const winner = await convergePlanChangeAfterVoidRace(
            current,
            attempt,
            stripeSubscription,
            invoice,
        );
        if (winner.applied) return winner.subscription;

        const sourceStillExact = planChangeSourceStillExact(current, attempt, stripeSubscription);
        const exactInvoiceIsVoid = Boolean(
            attempt.stripeInvoiceId
            && stripeObjectId(invoice) === String(attempt.stripeInvoiceId)
            && String(invoice?.status || '') === 'void',
        );
        if (sourceStillExact && (!attempt.stripeInvoiceId || exactInvoiceIsVoid)) {
            await clearTerminalPlanChangeAttempt(current._id, attempt.idempotencyToken, reason);
            return SellerSubscription.findById(current._id);
        }

        // A bound Invoice can become paid or enter PaymentIntent processing
        // before the subscription projection catches up. Keep the generation
        // durable so the next HTTP/webhook reconciliation can apply the exact
        // winner; cancellation/downgrade remains scheduled independently.
        const preserved = await preservePlanChangeAttemptForStripeOutcome(current, attempt.idempotencyToken, {
            invoiceId: attempt.stripeInvoiceId,
            state: 'recoverable',
            lastError: 'Cancellation or downgrade is scheduled while Stripe is resolving the exact plan-change invoice.',
        });
        return preserved || current;
    }

    const ownsPending = pendingUpdateMatchesTarget(stripeSubscription, {
        priceId: attempt.stripePriceId,
        subscriptionItemId: attempt.stripeSubscriptionItemId,
        invoiceId: attempt.stripeInvoiceId,
    });
    if (!ownsPending) {
        await clearTerminalPlanChangeAttempt(current._id, attempt.idempotencyToken, reason);
        return SellerSubscription.findById(current._id);
    }

    const invoiceId = stripeObjectId(stripeSubscription.latest_invoice);
    if (!invoiceId || (attempt.stripeInvoiceId && String(attempt.stripeInvoiceId) !== invoiceId)) {
        const error = new Error('The pending Stripe invoice does not match the durable plan-change generation.');
        error.code = 'PLAN_CHANGE_SUPERSEDED';
        throw error;
    }
    if (!attempt.stripeInvoiceId) {
        const bound = await bindPlanChangeInvoice(current._id, attempt.idempotencyToken, invoiceId);
        if (!bound) {
            const error = new Error('A different Stripe invoice already owns this plan-change attempt.');
            error.code = 'PLAN_CHANGE_SUPERSEDED';
            throw error;
        }
        attempt.stripeInvoiceId = invoiceId;
    }

    let invoice = stripeInvoiceObject(stripeSubscription);
    if (!invoice || stripeObjectId(invoice) !== invoiceId) {
        invoice = await stripe.invoices.retrieve(invoiceId);
    }
    invoice = await loadCompletePlanChangeInvoice(invoice);
    if (
        !invoice
        || !['draft', 'open', 'uncollectible'].includes(String(invoice.status || ''))
        || stripeObjectId(invoice.customer) !== String(current.stripeCustomerId)
        || invoiceSubscriptionId(invoice) !== String(current.stripeSubscriptionId)
        || String(invoice.billing_reason || '') !== 'subscription_update'
        || String(invoice.currency || '').toLowerCase() !== 'usd'
        || !exactPlanChangeInvoiceLines(invoice, {
            expectedSubscriptionId: current.stripeSubscriptionId,
            expectedSubscriptionItemId: attempt.stripeSubscriptionItemId,
            expectedPriceId: attempt.stripePriceId,
            expectedProductId: attempt.stripeProductId,
            expectedUnitAmount: attempt.targetUnitAmountMinor,
            expectedSourcePriceId: attempt.sourceStripePriceId,
            expectedSourceProductId: attempt.sourceStripeProductId,
            expectedSourceUnitAmount: attempt.sourceUnitAmountMinor,
        })
    ) {
        const error = new Error('The pending Stripe invoice could not be proven to belong to this exact plan change.');
        error.code = 'PLAN_CHANGE_SUPERSEDED';
        throw error;
    }
    if (!stripe?.invoices?.voidInvoice) {
        const preserved = await preservePlanChangeAttemptForStripeOutcome(
            current,
            attempt.idempotencyToken,
            {
                invoiceId,
                state: 'pending_payment',
                lastError: 'Cancellation or downgrade is scheduled, but Stripe invoice voiding is temporarily unavailable.',
            },
        );
        return preserved || current;
    }
    let voidConfirmed = false;
    let voidError = null;
    try {
        const voidedInvoice = await stripe.invoices.voidInvoice(invoiceId, {}, {
            idempotencyKey: `rozare-plan-change-void-${current._id}-${attempt.idempotencyToken}`,
        });
        voidConfirmed = String(voidedInvoice?.status || '') === 'void';
    } catch (error) {
        // A payment may atomically leave the voidable state after the exact
        // preflight. Fresh Stripe state, not this conflict, decides the winner.
        voidError = error;
    }
    let afterVoid;
    try {
        afterVoid = await retrievePlanChangeStripeSubscription(current.stripeSubscriptionId);
    } catch (refreshError) {
        throw voidError || refreshError;
    }
    const pendingStillOwned = pendingUpdateMatchesTarget(afterVoid, {
        priceId: attempt.stripePriceId,
        subscriptionItemId: attempt.stripeSubscriptionItemId,
        invoiceId,
    });
    const preserved = await preservePlanChangeAttemptForStripeOutcome(
        current,
        attempt.idempotencyToken,
        {
            invoiceId,
            state: pendingStillOwned ? 'pending_payment' : 'recoverable',
            lastError: pendingStillOwned
                ? 'Cancellation or downgrade is scheduled while Stripe is still resolving the exact plan-change payment.'
                : 'Stripe changed the exact pending invoice while cancellation or downgrade was being scheduled.',
        },
    );
    if (!preserved) {
        const latest = await SellerSubscription.findById(current._id);
        return latest || current;
    }
    if (pendingStillOwned) return preserved;

    const refreshedInvoice = await loadBoundPlanChangeInvoice(afterVoid, invoiceId);
    const winner = await convergePlanChangeAfterVoidRace(
        preserved,
        attempt,
        afterVoid,
        refreshedInvoice,
    );
    if (winner.applied) return winner.subscription;

    const exactInvoiceIsVoid = Boolean(
        stripeObjectId(refreshedInvoice) === String(invoiceId)
        && String(refreshedInvoice?.status || '') === 'void',
    );
    if (
        planChangeSourceStillExact(preserved, attempt, afterVoid)
        && (voidConfirmed || exactInvoiceIsVoid)
    ) {
        await clearTerminalPlanChangeAttempt(preserved._id, attempt.idempotencyToken, reason);
        return SellerSubscription.findById(preserved._id);
    }
    return preserved;
}

async function applyLocalPlanChange(subscriptionId, attemptToken, invoiceId) {
    const current = await SellerSubscription.findById(subscriptionId);
    if (!current) return { applied: false, subscription: null };
    if (
        current.planChangeAttempt?.state === 'applied'
        && current.planChangeAttempt?.idempotencyToken === attemptToken
    ) return { applied: true, reused: true, subscription: current };

    const attempt = current.planChangeAttempt || {};
    const isUnpaidRemoval = attempt.changeKind === 'meta_removal';
    if (
        !activePlanChangeStates.includes(attempt.state)
        || attempt.idempotencyToken !== attemptToken
        || attempt.targetPlan !== 'elite'
        || !attempt.stripeProductId
        || !attempt.stripePriceId
        || (!isUnpaidRemoval && (!invoiceId || attempt.stripeInvoiceId !== invoiceId))
        || (isUnpaidRemoval && invoiceId)
    ) return { applied: false, subscription: current };

    const filter = {
        _id: current._id,
        stripeSubscriptionId: attempt.stripeSubscriptionId,
        'planChangeAttempt.idempotencyToken': attemptToken,
        'planChangeAttempt.state': { $in: activePlanChangeStates },
        ...(isUnpaidRemoval
            ? {
                $or: [
                    { 'planChangeAttempt.stripeInvoiceId': null },
                    { 'planChangeAttempt.stripeInvoiceId': { $exists: false } },
                ],
            }
            : { 'planChangeAttempt.stripeInvoiceId': invoiceId }),
    };
    const updated = await SellerSubscription.findOneAndUpdate(filter, {
        $set: {
            plan: 'elite',
            planName: attempt.targetPlanName,
            metaAdsIncluded: Boolean(attempt.targetIncludeMetaAds),
            bonusFeaturesActive: true,
            bonusExpiryDate: null,
            bonusFeaturesExpiredPermanently: false,
            bonusGraceDeadline: null,
            warningEmailSent: false,
            stripeProductId: attempt.stripeProductId,
            stripePriceId: attempt.stripePriceId,
            ...(invoiceId ? { 'planChangeAttempt.stripeInvoiceId': invoiceId } : {}),
            'planChangeAttempt.state': 'applied',
            'planChangeAttempt.processingToken': null,
            'planChangeAttempt.pendingUpdateExpiresAt': null,
            'planChangeAttempt.completedAt': new Date(),
            'planChangeAttempt.lastError': '',
            'planChangeAttempt.notificationState': 'pending',
            'planChangeAttempt.notificationToken': null,
            'planChangeAttempt.notificationStartedAt': null,
            'planChangeAttempt.notificationCompletedAt': null,
            'planChangeAttempt.notificationLastError': '',
            'planChangeAttempt.notificationEmailState': 'pending',
            'planChangeAttempt.notificationWhatsAppState': 'pending',
            'planChangeAttempt.notificationInAppState': 'pending',
            'planChangeAttempt.notificationPushState': 'pending',
        },
    }, { new: true });
    if (updated) return { applied: true, subscription: updated };
    return { applied: false, subscription: await SellerSubscription.findById(current._id) };
}

async function convergePaidPlanChange({
    subscription,
    stripeSubscription,
    paidInvoice = null,
    invoiceAlreadyRecorded = false,
    eventId = '',
    eventCreated = 0,
}) {
    let current = await SellerSubscription.findById(subscription._id);
    const attempt = current?.planChangeAttempt || {};
    if (
        current
        && attempt.state === 'applied'
        && attempt.targetPlan === 'elite'
        && attempt.idempotencyToken
        && attempt.stripePriceId
        && attempt.stripeInvoiceId
    ) {
        await ensurePlanChangeCompletionNotificationOutboxed(current._id, attempt.idempotencyToken);
        current = await SellerSubscription.findById(current._id);
        return { handled: true, applied: true, reused: true, subscription: current };
    }
    if (
        !current
        || !activePlanChangeStates.includes(attempt.state)
        || attempt.targetPlan !== 'elite'
        || attempt.changeKind === 'meta_removal'
        || !attempt.stripeProductId
        || !attempt.stripePriceId
        || !Number.isSafeInteger(attempt.targetUnitAmountMinor)
        || attempt.targetUnitAmountMinor <= 0
    ) return { handled: false, applied: false, subscription: current };

    let invoice = paidInvoice || stripeInvoiceObject(stripeSubscription);
    if (
        !paidInvoice
        && attempt.stripeInvoiceId
        && stripeObjectId(invoice) !== String(attempt.stripeInvoiceId)
    ) {
        if (!stripe?.invoices?.retrieve) {
            return {
                handled: true,
                applied: false,
                reason: 'Stripe invoice retrieval is unavailable for the durable plan-change invoice.',
                subscription: current,
            };
        }
        invoice = await stripe.invoices.retrieve(attempt.stripeInvoiceId, {
            expand: ['parent.subscription_details.subscription'],
        });
    }
    const invoiceId = stripeObjectId(invoice);
    if (!invoiceId) {
        return { handled: true, applied: false, reason: 'Stripe did not return the plan-change invoice.', subscription: current };
    }
    if (!attempt.stripeInvoiceId) {
        const candidateAuthority = await stripePlanChangeIsAuthoritative(stripeSubscription, {
            expectedSubscriptionId: current.stripeSubscriptionId,
            expectedCustomerId: current.stripeCustomerId,
            expectedUnitAmount: attempt.targetUnitAmountMinor,
            expectedPriceId: attempt.stripePriceId,
            expectedProductId: attempt.stripeProductId,
            expectedSubscriptionItemId: attempt.stripeSubscriptionItemId,
            expectedInvoiceId: invoiceId,
            expectedSourcePriceId: attempt.sourceStripePriceId,
            expectedSourceProductId: attempt.sourceStripeProductId,
            expectedSourceUnitAmount: attempt.sourceUnitAmountMinor,
            invoiceOverride: invoice,
        });
        if (!candidateAuthority.ok) {
            return { handled: true, applied: false, reason: candidateAuthority.reason, subscription: current };
        }
        const firstBinding = await bindPlanChangeInvoice(
            current._id,
            attempt.idempotencyToken,
            invoiceId,
        );
        if (!firstBinding) {
            return { handled: true, applied: false, reason: 'A different Stripe invoice already owns this plan-change attempt.', subscription: current };
        }
        attempt.stripeInvoiceId = invoiceId;
    }
    const authority = await stripePlanChangeIsAuthoritative(stripeSubscription, {
        expectedSubscriptionId: current.stripeSubscriptionId,
        expectedCustomerId: current.stripeCustomerId,
        expectedUnitAmount: attempt.targetUnitAmountMinor,
        expectedPriceId: attempt.stripePriceId,
        expectedProductId: attempt.stripeProductId,
        expectedSubscriptionItemId: attempt.stripeSubscriptionItemId,
        expectedInvoiceId: attempt.stripeInvoiceId,
        expectedSourcePriceId: attempt.sourceStripePriceId,
        expectedSourceProductId: attempt.sourceStripeProductId,
        expectedSourceUnitAmount: attempt.sourceUnitAmountMinor,
        invoiceOverride: invoice,
    });
    if (!authority.ok) {
        return { handled: true, applied: false, pending: Boolean(stripeSubscription.pending_update), reason: authority.reason, subscription: current };
    }

    const bound = await bindPlanChangeInvoice(
        current._id,
        attempt.idempotencyToken,
        invoiceId,
        stripePendingUpdateExpiryDate(stripeSubscription.pending_update?.expires_at),
    );
    if (!bound) {
        return { handled: true, applied: false, reason: 'The paid invoice does not match the durable plan-change attempt.', subscription: current };
    }

    if (!invoiceAlreadyRecorded) {
        const recorded = await recordSubscriptionInvoicePayment({
            invoice,
            eventId,
            eventCreated,
        });
        if (
            !recorded.handled
            || recorded.stale
            || (recorded.zeroAmount && !recorded.planChangeAuthorized)
        ) {
            return { handled: true, applied: false, reason: 'The plan-change invoice did not create paid coverage.', subscription: current };
        }
    }

    const applied = await applyLocalPlanChange(current._id, attempt.idempotencyToken, invoiceId);
    if (applied.applied) {
        await ensurePlanChangeCompletionNotificationOutboxed(current._id, attempt.idempotencyToken);
        applied.subscription = await SellerSubscription.findById(current._id);
    }
    return { handled: true, ...applied };
}

async function reconcileExistingPendingPlanChange(subscription) {
    const attempt = subscription?.planChangeAttempt || {};
    if (
        activePlanChangeStates.includes(attempt.state)
        && attempt.stripeSubscriptionId
        && String(attempt.stripeSubscriptionId) !== String(subscription.stripeSubscriptionId)
    ) {
        await clearTerminalPlanChangeAttempt(
            subscription._id,
            attempt.idempotencyToken,
            'The previous Stripe subscription was replaced before this plan change completed.',
        );
        return SellerSubscription.findById(subscription._id);
    }
    if (
        attempt.state === 'processing'
        && String(attempt.processingToken || '').startsWith(ENTITLEMENT_PLAN_SYNC_TOKEN_PREFIX)
    ) {
        // This lease belongs to refund/dispute funded-plan reconciliation,
        // not to the user plan-change state machine. claimPlanChangeAttempt
        // applies its encoded timestamp/recovery contract.
        return subscription;
    }
    if (
        attempt.state === 'processing'
        && attempt.startedAt
        && attempt.startedAt > new Date(Date.now() - PLAN_CHANGE_LEASE_MS)
    ) return subscription;
    if (
        !stripe
        || !activePlanChangeStates.includes(attempt.state)
        || !subscription.stripeSubscriptionId
        || !attempt.idempotencyToken
        || !attempt.stripeSubscriptionItemId
        || !attempt.stripeProductId
        || !attempt.stripePriceId
    ) return subscription;

    const stripeSubscription = await retrievePlanChangeStripeSubscription(subscription.stripeSubscriptionId);
    if (stripeSubscription.pending_update) {
        if (pendingUpdateMatchesTarget(stripeSubscription, {
            priceId: attempt.stripePriceId,
            subscriptionItemId: attempt.stripeSubscriptionItemId,
            invoiceId: attempt.stripeInvoiceId,
        })) {
            const exactPendingInvoice = await exactPendingPlanChangeInvoice(
                stripeSubscription,
                subscription,
                attempt,
            );
            if (exactPendingInvoice.ok) {
                const bound = await bindPlanChangeInvoice(
                    subscription._id,
                    attempt.idempotencyToken,
                    exactPendingInvoice.invoiceId,
                    stripePendingUpdateExpiryDate(stripeSubscription.pending_update.expires_at),
                );
                if (bound) return SellerSubscription.findById(subscription._id);
            }
        }
        await clearTerminalPlanChangeAttempt(
            subscription._id,
            attempt.idempotencyToken,
            'Stripe superseded the durable pending plan change.',
        );
        return SellerSubscription.findById(subscription._id);
    }

    if (attempt.changeKind === 'meta_removal') {
        const removalAuthority = await stripePlanChangeIsAuthoritative(stripeSubscription, {
            expectedSubscriptionId: subscription.stripeSubscriptionId,
            expectedCustomerId: subscription.stripeCustomerId,
            expectedUnitAmount: attempt.targetUnitAmountMinor,
            expectedPriceId: attempt.stripePriceId,
            expectedProductId: attempt.stripeProductId,
            expectedSubscriptionItemId: attempt.stripeSubscriptionItemId,
            allowUnpaidRemoval: true,
        });
        if (removalAuthority.ok) {
            const applied = await applyLocalPlanChange(subscription._id, attempt.idempotencyToken, null);
            if (applied.applied) {
                await ensurePlanChangeCompletionNotificationOutboxed(subscription._id, attempt.idempotencyToken);
                return SellerSubscription.findById(subscription._id);
            }
        }
    }

    const convergence = attempt.changeKind === 'meta_removal'
        ? { applied: false }
        : await convergePaidPlanChange({ subscription, stripeSubscription });
    if (convergence.applied) return convergence.subscription;

    if (['processing', 'recoverable'].includes(attempt.state)) {
        const sourceStillExact = exactStripePlanChangeSource(stripeSubscription, {
            expectedItemId: attempt.stripeSubscriptionItemId,
            expectedPriceId: attempt.sourceStripePriceId,
            expectedProductId: attempt.sourceStripeProductId,
            expectedUnitAmount: attempt.sourceUnitAmountMinor,
        });
        if (sourceStillExact.ok) {
            // The remote mutation either never happened or its response was
            // lost. Reusing the same Stripe idempotency key is the only safe
            // way to discover that outcome without creating a new generation.
            return subscription;
        }
    }

    // A pending-payment generation with no matching pending/applied target is
    // terminal. Processing/recoverable generations were retained above only
    // when the immutable predecessor is still exact, so the same Stripe
    // idempotency key can safely be replayed.
    await clearTerminalPlanChangeAttempt(
        subscription._id,
        attempt.idempotencyToken,
        attempt.pendingUpdateExpiresAt && attempt.pendingUpdateExpiresAt <= new Date()
            ? 'Stripe expired the unpaid pending plan update.'
            : 'Stripe removed, replaced, or never applied this plan update.',
    );
    return SellerSubscription.findById(subscription._id);
}

const publicPlanChangeSubscription = subscription => ({
    plan: subscription.plan,
    planName: subscription.planName,
    metaAdsIncluded: subscription.metaAdsIncluded,
    bonusFeaturesActive: subscription.bonusFeaturesActive,
    bonusExpiryDate: subscription.bonusExpiryDate,
    founderOffer: {
        active: Boolean(subscription.founderOffer?.active),
        code: subscription.founderOffer?.code || null,
    },
});

async function listPlanChangePaymentIntents(invoice) {
    const invoiceId = stripeObjectId(invoice);
    let rows = [];
    if (invoiceId && stripe?.invoicePayments?.list) {
        let startingAfter;
        for (let page = 0; page < 100; page += 1) {
            const response = await stripe.invoicePayments.list({
                invoice: invoiceId,
                limit: 100,
                expand: ['data.payment.payment_intent'],
                ...(startingAfter ? { starting_after: startingAfter } : {}),
            });
            const data = Array.isArray(response?.data) ? response.data : [];
            rows.push(...data);
            if (!response?.has_more) break;
            startingAfter = stripeObjectId(data.at(-1));
            if (!startingAfter) break;
        }
    }
    if (!rows.length && Array.isArray(invoice?.payments?.data)) rows = invoice.payments.data;
    return rows
        .map(row => row?.payment?.payment_intent || row?.payment_intent)
        .filter(paymentIntent => paymentIntent && typeof paymentIntent === 'object')
        .sort((left, right) => Number(right.created || 0) - Number(left.created || 0));
}

async function reconcilePlanChangePaymentActionRequired(invoice) {
    const invoiceId = stripeObjectId(invoice);
    const stripeSubscriptionId = invoiceSubscriptionId(invoice);
    if (
        !invoiceId
        || !stripeSubscriptionId
        || String(invoice?.billing_reason || '') !== 'subscription_update'
    ) return { handled: false };

    let subscription = await bindIncomingPlanChangeInvoiceIfExact(invoice);
    subscription = subscription?._id
        ? await SellerSubscription.findById(subscription._id)
        : null;
    const attempt = subscription?.planChangeAttempt || {};
    if (
        !subscription
        || !activePlanChangeStates.includes(attempt.state)
        || attempt.changeKind === 'meta_removal'
        || String(attempt.stripeSubscriptionId || '') !== String(subscription.stripeSubscriptionId || '')
        || String(attempt.stripeInvoiceId || '') !== invoiceId
        || !attempt.stripeSubscriptionItemId
        || !attempt.stripeProductId
        || !attempt.stripePriceId
    ) return { handled: false };

    const stripeSubscription = await retrievePlanChangeStripeSubscription(stripeSubscriptionId);
    if (!pendingUpdateMatchesTarget(stripeSubscription, {
        priceId: attempt.stripePriceId,
        subscriptionItemId: attempt.stripeSubscriptionItemId,
        invoiceId,
    })) return { handled: false };

    const exactPending = await exactPendingPlanChangeInvoice(
        stripeSubscription,
        subscription,
        attempt,
    );
    if (!exactPending.ok || exactPending.invoiceId !== invoiceId) return { handled: false };
    const paymentIntents = await listPlanChangePaymentIntents(exactPending.invoice);
    const actionPaymentIntent = paymentIntents.find(candidate => (
        String(candidate?.status || '').toLowerCase() === 'requires_action'
    ));
    if (!actionPaymentIntent) return { handled: false };

    const result = await SellerSubscription.updateOne({
        _id: subscription._id,
        stripeSubscriptionId,
        cancelledAt: null,
        'pendingDowngrade.toPlan': null,
        'planChangeAttempt.idempotencyToken': attempt.idempotencyToken,
        'planChangeAttempt.stripeSubscriptionId': stripeSubscriptionId,
        'planChangeAttempt.stripeSubscriptionItemId': attempt.stripeSubscriptionItemId,
        'planChangeAttempt.stripeProductId': attempt.stripeProductId,
        'planChangeAttempt.stripePriceId': attempt.stripePriceId,
        'planChangeAttempt.stripeInvoiceId': invoiceId,
        'planChangeAttempt.state': { $in: activePlanChangeStates },
    }, {
        $set: {
            'planChangeAttempt.state': 'pending_payment',
            'planChangeAttempt.processingToken': null,
            'planChangeAttempt.pendingUpdateExpiresAt': stripePendingUpdateExpiryDate(
                stripeSubscription.pending_update?.expires_at
            ),
            'planChangeAttempt.lastError': 'Stripe requires payment authentication. Retry this exact plan change to continue securely.',
        },
    });
    const handled = Number(result.matchedCount ?? result.n ?? 0) === 1;
    if (!handled) return { handled: false };

    const initialized = await SellerSubscription.findOneAndUpdate({
        _id: subscription._id,
        stripeSubscriptionId,
        'planChangeAttempt.idempotencyToken': attempt.idempotencyToken,
        'planChangeAttempt.stripeInvoiceId': invoiceId,
        'planChangeAttempt.state': 'pending_payment',
        $or: [
            { 'planChangeAttempt.notificationState': null },
            { 'planChangeAttempt.notificationState': { $exists: false } },
        ],
    }, {
        $set: {
            'planChangeAttempt.notificationState': 'pending',
            'planChangeAttempt.notificationToken': null,
            'planChangeAttempt.notificationStartedAt': null,
            'planChangeAttempt.notificationCompletedAt': null,
            'planChangeAttempt.notificationLastError': '',
            'planChangeAttempt.notificationEmailState': 'pending',
            'planChangeAttempt.notificationWhatsAppState': 'pending',
            'planChangeAttempt.notificationInAppState': 'pending',
            'planChangeAttempt.notificationPushState': 'pending',
        },
    }, { new: true });
    const notificationOwner = initialized || await SellerSubscription.findOne({
        _id: subscription._id,
        stripeSubscriptionId,
        'planChangeAttempt.idempotencyToken': attempt.idempotencyToken,
        'planChangeAttempt.stripeInvoiceId': invoiceId,
        'planChangeAttempt.state': 'pending_payment',
    });
    const notificationOutstanding = ['pending', 'partial', 'processing'].includes(
        String(notificationOwner?.planChangeAttempt?.notificationState || '')
    );
    return {
        handled: true,
        invoiceId,
        paymentIntentId: stripeObjectId(actionPaymentIntent),
        notificationIntent: notificationOutstanding ? {
            subscriptionId: String(subscription._id),
            attemptToken: String(attempt.idempotencyToken),
            invoiceId,
        } : null,
    };
}

async function loadConcurrentlyReconciledPendingPlanChange(subscriptionId, claim, stripeSubscription) {
    const current = await SellerSubscription.findById(subscriptionId);
    const attempt = current?.planChangeAttempt || {};
    if (
        !current
        || current.cancelledAt
        || current.pendingDowngrade?.toPlan
        || attempt.idempotencyToken !== claim.idempotencyToken
        || attempt.state !== 'pending_payment'
        || !attempt.stripeInvoiceId
        || !pendingUpdateMatchesTarget(stripeSubscription, {
            priceId: attempt.stripePriceId,
            subscriptionItemId: attempt.stripeSubscriptionItemId,
            invoiceId: attempt.stripeInvoiceId,
        })
    ) return null;
    return current;
}

async function respondPendingPlanChange(res, stripeSubscription) {
    const invoice = stripeInvoiceObject(stripeSubscription);
    const paymentIntents = await listPlanChangePaymentIntents(invoice);
    const paymentIntent = paymentIntents.find(candidate => [
        'requires_action',
        'requires_confirmation',
        'requires_payment_method',
        'processing',
        'canceled',
        'succeeded',
    ].includes(String(candidate?.status || '').toLowerCase())) || null;
    const paymentIntentStatus = String(paymentIntent?.status || '').toLowerCase();
    if (paymentIntentStatus === 'requires_action') {
        const clientSecret = paymentIntent?.client_secret
            || invoice?.confirmation_secret?.client_secret
            || null;
        if (!clientSecret) {
            return res.status(409).json({
                code: 'PLAN_CHANGE_ACTION_UNAVAILABLE',
                msg: 'Stripe requires authentication but did not return a usable PaymentIntent secret. No local plan features were changed.',
                pending: true,
                actionRequired: false,
                paymentIntentStatus,
                invoiceId: stripeObjectId(invoice) || null,
            });
        }
        return res.status(409).json({
            code: 'PLAN_CHANGE_ACTION_REQUIRED',
            msg: 'Stripe is waiting for payment authentication. No local plan features were changed.',
            pending: true,
            actionRequired: true,
            clientSecret,
            paymentIntentStatus,
            invoiceId: stripeObjectId(invoice) || null,
        });
    }
    if (['requires_confirmation', 'processing', 'succeeded'].includes(paymentIntentStatus)) {
        return res.status(409).json({
            code: 'PLAN_CHANGE_PROCESSING',
            msg: 'Stripe is still settling the exact plan-change invoice. No local plan features were changed.',
            pending: true,
            actionRequired: false,
            paymentIntentStatus,
            invoiceId: stripeObjectId(invoice) || null,
        });
    }
    return res.status(402).json({
        code: 'PLAN_CHANGE_PAYMENT_REQUIRED',
        msg: 'Stripe has not paid the plan-change invoice. No local plan features were changed.',
        pending: true,
        actionRequired: false,
        paymentIntentStatus: paymentIntentStatus || null,
        invoiceId: stripeObjectId(invoice) || null,
    });
}

// Initialize subscription when seller creates store or becomes seller
exports.initializeSubscription = async (sellerId) => {
    try {
        let sub = await SellerSubscription.findOne({ seller: sellerId });
        if (sub) return sub;

        const now = new Date();
        const trialEnd = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000);

        sub = new SellerSubscription({
            seller: sellerId,
            trialStartDate: now,
            trialEndDate: trialEnd,
            status: 'trial',
            plan: 'free_trial',
            planName: 'Rozare Free Trial',
            aiMessageLimit: -1,
        });
        await sub.save();
        return sub;
    } catch (error) {
        console.error('Initialize subscription error:', error);
        throw error;
    }
};

// Get subscription status
exports.getSubscriptionStatus = async (req, res) => {
    try {
        const sellerId = req.user.id;
        let sub = await SellerSubscription.findOne({ seller: sellerId });

        if (!sub) {
            sub = await exports.initializeSubscription(sellerId);
        }

        // Check and update status if trial expired
        sub = await checkAndUpdateStatus(sub);

        if (!sub.cancelledAt && !sub.pendingDowngrade?.toPlan) {
            sub = await reconcileExistingPendingPlanChange(sub);
        }
        if (
            sub.planChangeAttempt?.state === 'applied'
            && ['pending', 'partial'].includes(sub.planChangeAttempt?.notificationState)
            && sub.planChangeAttempt?.idempotencyToken
        ) {
            await ensurePlanChangeCompletionNotificationOutboxed(sub._id, sub.planChangeAttempt.idempotencyToken);
            sub = await SellerSubscription.findById(sub._id);
        }

        // Check bonus features expiry (only for starter plan, not elite)
        if (sub.bonusFeaturesActive && sub.bonusExpiryDate && new Date() > sub.bonusExpiryDate && sub.plan !== 'elite') {
            sub.bonusFeaturesActive = false;
            sub.bonusFeaturesExpiredPermanently = true;
            sub.bonusExpiredNotificationEventAt = sub.bonusExpiryDate;
            await sub.save();
            sub = await ensureBonusLifecyclePricingSnapshot(sub, {
                kind: 'expired',
                sourceDate: sub.bonusExpiredNotificationEventAt,
            });
            await enqueueBonusLifecycleNotification(sub, {
                kind: 'expired',
                sourceDate: sub.bonusExpiredNotificationEventAt,
            });
            sub.bonusExpiredNotificationEnqueuedAt = new Date();
            await sub.save();
        }

        // Calculate grace period info
        const now = new Date();
        const hasGracePeriod = sub.status === 'blocked' && sub.bonusGraceDeadline && now < sub.bonusGraceDeadline && !sub.bonusFeaturesExpiredPermanently;
        const graceDaysRemaining = hasGracePeriod ? Math.ceil((sub.bonusGraceDeadline - now) / (1000 * 60 * 60 * 24)) : 0;

        const founderPromotion = await getFounderPromotionStatus(sub);
        const founderDiscountPercent = await founderDiscountPercentForPresentation(sub);

        res.json({
            subscription: {
                status: sub.status,
                plan: sub.plan,
                planName: sub.status === 'trial' || sub.plan === 'free_trial'
                    ? 'Rozare Free Trial'
                    : sub.planName || (sub.plan === 'elite' ? 'Rozare Elite' : 'Rozare Starter'),
                trialStartDate: sub.trialStartDate,
                trialEndDate: sub.trialEndDate,
                trialDaysRemaining: sub.trialDaysRemaining,
                isTrialExpiringSoon: sub.isTrialExpiringSoon,
                isBlocked: sub.isBlocked,
                subscribedAt: sub.subscribedAt,
                freePeriodEndDate: sub.freePeriodEndDate,
                currentPeriodEnd: sub.currentPeriodEnd,
                aiMessageLimit: -1,
                aiMessagesUnlimited: true,
                metaAdsIncluded: sub.metaAdsIncluded || false,
                metaAdsAddonCents: META_ADS_ADDON_CENTS,
                cancelledAt: sub.cancelledAt,
                blockedReason: sub.blockedReason,
                bonusFeaturesActive: sub.bonusFeaturesActive,
                bonusExpiryDate: sub.bonusExpiryDate,
                bonusFeaturesExpiredPermanently: sub.bonusFeaturesExpiredPermanently || false,
                bonusGraceDeadline: sub.bonusGraceDeadline || null,
                bonusGraceDaysRemaining: graceDaysRemaining,
                pendingDowngrade: sub.pendingDowngrade?.toPlan || null,
                hasUsedFreePeriod: sub.hasUsedFreePeriod || false,
                pricing: getPricingCatalog(),
                founderOffer: {
                    active: Boolean(sub.founderOffer?.active),
                    code: sub.founderOffer?.code || null,
                    discountPercent: founderDiscountPercent,
                    claimedAt: sub.founderOffer?.claimedAt || null,
                    forfeitedAt: sub.founderOffer?.forfeitedAt || null,
                    source: sub.founderOffer?.source || null,
                },
                founderPromotion,
            },
        });
    } catch (error) {
        console.error('Get subscription status error:', error);
        if (error?.code === 'SUBSCRIPTION_FOUNDER_OFFER_INVALID') {
            return res.status(503).json({
                msg: 'Subscription pricing data requires recovery before it can be displayed safely.',
                code: error.code,
            });
        }
        res.status(500).json({ msg: 'Server error' });
    }
};

// Check and update subscription status
async function checkAndUpdateStatus(sub) {
    const now = new Date();

    if (sub.status === 'trial' && now > sub.trialEndDate) {
        sub.status = 'blocked';
        sub.blockedAt = now;
        sub.blockedReason = 'Trial period expired. Please subscribe to a paid plan to reactivate your store.';
        sub.trialBlockedNotificationEventAt = sub.trialEndDate;

        // Block the store + schedule subdomain removal in 7 days (if not purchased)
        const storeDoc = await Store.findOne({ seller: sub.seller });
        if (storeDoc) {
            storeDoc.isActive = false;
            storeDoc.blockedAt = now;
            const purchased = storeDoc.subdomainPurchase?.isPurchased &&
                storeDoc.subdomainPurchase?.expiresAt &&
                new Date(storeDoc.subdomainPurchase.expiresAt) > now;
            if (!purchased) {
                storeDoc.subdomainPurchase = {
                    ...(storeDoc.subdomainPurchase?.toObject?.() || {}),
                    removalScheduledAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
                };
            }
            await storeDoc.save();
        }

        await sub.save();

        const Cart = require('../models/Cart');
        const Product = require('../models/Product');
        const sellerProducts = await Product.find({ seller: sub.seller }).select('_id');
        if (sellerProducts.length) {
            const productIds = sellerProducts.map(product => product._id);
            await Cart.updateMany(
                { 'cartItems.product': { $in: productIds } },
                { $pull: { cartItems: { product: { $in: productIds } } } },
            );
        }
        await enqueueTrialBlockedNotification(sub);
        sub.trialBlockedNotificationEnqueuedAt = new Date();
        await sub.save();
    }

    if (sub.status === 'free_period' && sub.freePeriodEndDate && now > sub.freePeriodEndDate) {
        // Reconcile the Stripe payment ledger before declaring the first paid
        // cycle overdue. This keeps status reads from overwriting an already
        // recorded, current subscription-cycle payment after webhook retries or
        // out-of-order delivery.
        const recomputed = await recomputeSubscriptionEntitlement(sub._id, { allowRestore: true });
        if (recomputed) sub = recomputed;
        if (sub.status !== 'free_period') return sub;

        // The free period ending does not prove that Stripe collected money.
        // invoice.payment_succeeded supplies the authoritative paid interval.
        sub.status = 'past_due';
        await sub.save();
    }

    return sub;
}

async function getUsableStripeCustomerId(sub, user, sellerId) {
    const previousCustomerId = sub.stripeCustomerId || null;
    const mustPreserveExistingSubscriptionCustomer = Boolean(
        previousCustomerId
        && sub.stripeSubscriptionId
        && ['trial', 'free_period', 'active', 'past_due'].includes(sub.status)
    );
    const { customer } = await ensureStripeCustomerForUser(sellerId, {
        preferredCustomerId: mustPreserveExistingSubscriptionCustomer ? previousCustomerId : null,
    });
    if (previousCustomerId !== customer.id) {
        sub.stripeCustomerId = customer.id;
        // A resource-missing customer belongs to another Stripe mode or was
        // deleted. Its subscription/price IDs are unusable in this mode too.
        sub.stripeSubscriptionId = undefined;
        sub.stripePriceId = undefined;
        resetSubscriptionInvoiceOrdering(sub);
        await sub.save();
    }
    return customer.id;
}

// Create Stripe checkout for subscription
exports.createCheckout = async (req, res) => {
    let founderReservation = null;
    let checkoutClaim = null;
    let checkoutSession = null;
    let sellerId = null;
    let stripeCreateStarted = false;
    let stripeCreateCompleted = false;
    try {
        // Guard: Stripe must be configured. In live mode this is the most common
        // cause of a 500 here (e.g. STRIPE_LIVE_SECRET_KEY missing in env).
        if (!stripe) {
            console.error('[subscription] createCheckout: Stripe is not configured');
            return res.status(503).json({
                msg: 'Payments are not configured on the server. Please contact support.',
                code: 'STRIPE_NOT_CONFIGURED',
            });
        }

        sellerId = req.user.id;
        const { plan } = req.body; // 'starter' or 'elite'
        if (
            req.body?.includeMetaAds !== undefined
            && typeof req.body.includeMetaAds !== 'boolean'
        ) {
            return res.status(400).json({
                msg: 'Meta ads selection must be a boolean.',
                code: 'INVALID_META_ADS_SELECTION',
            });
        }
        const includeMetaAdsRequested = req.body?.includeMetaAds === true;
        const requestedCouponCode = normalizePromotionCode(req.body?.couponCode);
        if (!['starter', 'elite'].includes(plan)) {
            return res.status(400).json({ msg: 'Choose a valid subscription plan.' });
        }
        if (includeMetaAdsRequested && plan !== 'elite') {
            return res.status(400).json({ msg: 'Meta ads can only be added to the Rozare Elite plan.' });
        }
        if (requestedCouponCode && requestedCouponCode !== FOUNDER_PROMOTION.code) {
            return res.status(400).json({
                msg: 'This subscription coupon is not valid.',
                code: 'INVALID_SUBSCRIPTION_COUPON',
            });
        }
        const user = await User.findById(sellerId);
        if (!user) {
            return res.status(404).json({ msg: 'Seller account not found.' });
        }
        if (!user.email) {
            return res.status(400).json({ msg: 'Your account is missing an email address. Please update your profile before subscribing.' });
        }

        let sub = await SellerSubscription.findOne({ seller: sellerId });

        if (!sub) {
            sub = await exports.initializeSubscription(sellerId);
        }

        if (sub.paymentRisk?.suspended) {
            return res.status(423).json({
                msg: 'Your subscription has an unresolved Stripe payment dispute. Billing changes are temporarily frozen.',
                code: 'SUBSCRIPTION_PAYMENT_RISK_OPEN',
            });
        }

        // Already subscribed
        if (['active', 'free_period'].includes(sub.status)) {
            return res.status(400).json({ msg: 'You already have an active subscription.' });
        }

        if (requestedCouponCode === FOUNDER_PROMOTION.code && (
            sub.founderOffer?.claimedAt || sub.founderOffer?.forfeitedAt
        )) {
            return res.status(400).json({
                msg: sub.founderOffer?.active
                    ? 'Your founder price is already locked to this subscription.'
                    : 'This seller account has already used the founder coupon. The founder rate ends when the subscription ends.',
                code: 'FOUNDER_COUPON_ALREADY_USED',
            });
        }

        const requestFingerprint = fingerprintCheckoutRequest({
            plan,
            includeMetaAds: includeMetaAdsRequested,
            couponCode: requestedCouponCode,
            checkoutClient: String(req.body?.checkoutClient || 'web').trim().toLowerCase(),
        });
        const claimResult = await claimSellerCheckout({
            sellerId,
            flow: 'subscription',
            requestFingerprint,
        });
        if (!claimResult.acquired) {
            const existingClaim = claimResult.claim;
            if (
                existingClaim.requestFingerprint === requestFingerprint
                && existingClaim.sessionId
                && existingClaim.sessionUrl
            ) {
                if (
                    requestedCouponCode === FOUNDER_PROMOTION.code
                    && existingClaim.founderReservationToken
                    && existingClaim.creationState === 'recoverable'
                ) {
                    try {
                        await attachCheckoutSessionToReservation(
                            sellerId,
                            existingClaim.founderReservationToken,
                            existingClaim.sessionId
                        );
                        await attachSellerCheckoutSession({
                            sellerId,
                            flow: 'subscription',
                            token: existingClaim.token,
                            sessionId: existingClaim.sessionId,
                            sessionUrl: existingClaim.sessionUrl,
                        });
                    } catch (recoveryError) {
                        await markSellerCheckoutClaimRecoverable({
                            sellerId,
                            flow: 'subscription',
                            token: existingClaim.token,
                            error: recoveryError,
                        }).catch(() => {});
                        return res.status(503).json({
                            msg: 'Checkout was created but its founder reservation is still being recovered. Retry this same checkout shortly.',
                            code: 'CHECKOUT_RECOVERY_PENDING',
                        });
                    }
                }
                return res.json({
                    url: existingClaim.sessionUrl,
                    sessionId: existingClaim.sessionId,
                    founderOfferReserved: requestedCouponCode === FOUNDER_PROMOTION.code,
                    reused: true,
                });
            }
            return res.status(409).json({
                msg: 'A subscription checkout is already in progress. Complete or cancel it before starting another.',
                code: 'CHECKOUT_PENDING',
                retryAfterSeconds: checkoutClaimRetryAfterSeconds(existingClaim),
            });
        }
        checkoutClaim = claimResult.claim;

        // Create or validate Stripe customer. A saved customer can be stale when
        // switching test/live mode or if it was deleted in Stripe.
        const customerId = await getUsableStripeCustomerId(sub, user, sellerId);

        // Prevent parallel subscription exploit:
        // (1) Expire any OPEN checkout sessions for this customer so they can't be completed later
        // (2) Cancel any existing ACTIVE/TRIALING Stripe subscriptions before creating a new one
        try {
            // Layer 1: Expire open checkout sessions (prevents "two tabs, pay both" exploit)
            const openSessions = await stripe.checkout.sessions.list({
                customer: customerId,
                limit: 100,
            });
            if (!Array.isArray(openSessions?.data) || openSessions.has_more === true) {
                const incompleteListError = new Error('Stripe returned an incomplete subscription Checkout-session list.');
                incompleteListError.code = 'SUBSCRIPTION_STRIPE_PREFLIGHT_INCOMPLETE';
                throw incompleteListError;
            }
            for (const s of openSessions.data) {
                if (s.status === 'open' && s.mode === 'subscription') {
                    if (s.metadata?.checkoutClaimToken === checkoutClaim.token) {
                        // This can be the remotely-created result of an earlier
                        // timed-out request. Replaying the same Stripe
                        // idempotency key below is the recovery path.
                        continue;
                    }
                    await stripe.checkout.sessions.expire(s.id);
                    if (s.metadata?.founderReservationToken) {
                        await releaseFounderReservation({
                            sellerId,
                            token: s.metadata.founderReservationToken,
                            checkoutSessionId: s.id,
                        });
                    }
                } else if (s.status === 'expired' && s.metadata?.founderReservationToken) {
                    await releaseFounderReservation({
                        sellerId,
                        token: s.metadata.founderReservationToken,
                        checkoutSessionId: s.id,
                    });
                }
            }

            const cancelDiscoveredStaleSubscription = async existing => {
                if (typeof existing?.id !== 'string' || !/^sub_[A-Za-z0-9_]+$/.test(existing.id)) {
                    const invalidReferenceError = new Error('Stripe returned an invalid stale subscription reference.');
                    invalidReferenceError.code = 'SUBSCRIPTION_STRIPE_PREFLIGHT_INVALID';
                    throw invalidReferenceError;
                }
                const cleanup = await ensureStripeSubscriptionCleanup({
                    seller: sellerId,
                    staleStripeSubscriptionId: existing.id,
                    replacementStripeSubscriptionId: sub.stripeSubscriptionId || '',
                    stripeCustomerId: customerId,
                    reason: 'precheckout_stale_subscription',
                    sourceReference: checkoutClaim.token,
                    occurredAt: checkoutClaim.createdAt,
                });
                const result = await processStripeSubscriptionCleanupById(cleanup._id);
                if (result?.status !== 'completed') {
                    const pendingCleanupError = new Error(
                        'An earlier Stripe subscription still requires cancellation confirmation. No new Checkout was created; retry after recovery.',
                    );
                    pendingCleanupError.code = 'SUBSCRIPTION_STALE_CLEANUP_PENDING';
                    pendingCleanupError.statusCode = 409;
                    throw pendingCleanupError;
                }
            };

            // Layer 2: Cancel any active subscriptions
            const existingSubs = await stripe.subscriptions.list({
                customer: customerId,
                status: 'active',
                limit: 100,
            });
            if (!Array.isArray(existingSubs?.data) || existingSubs.has_more === true) {
                const incompleteListError = new Error('Stripe returned an incomplete active-subscription list.');
                incompleteListError.code = 'SUBSCRIPTION_STRIPE_PREFLIGHT_INCOMPLETE';
                throw incompleteListError;
            }
            for (const existing of existingSubs.data) {
                if (
                    existing.id !== sub.stripeSubscriptionId
                    && existing.metadata?.checkoutClaimToken !== checkoutClaim.token
                ) {
                    await cancelDiscoveredStaleSubscription(existing);
                }
            }
            // Also cancel any trialing subscriptions
            const trialingSubs = await stripe.subscriptions.list({
                customer: customerId,
                status: 'trialing',
                limit: 100,
            });
            if (!Array.isArray(trialingSubs?.data) || trialingSubs.has_more === true) {
                const incompleteListError = new Error('Stripe returned an incomplete trialing-subscription list.');
                incompleteListError.code = 'SUBSCRIPTION_STRIPE_PREFLIGHT_INCOMPLETE';
                throw incompleteListError;
            }
            for (const existing of trialingSubs.data) {
                if (
                    existing.id !== sub.stripeSubscriptionId
                    && existing.metadata?.checkoutClaimToken !== checkoutClaim.token
                ) {
                    await cancelDiscoveredStaleSubscription(existing);
                }
            }
        } catch (listErr) {
            console.error('Failed to list/expire existing Stripe sessions/subscriptions:', listErr.message);
            // Creating another billable Checkout while Stripe preflight is
            // incomplete can produce duplicate subscriptions. Fail closed; the
            // durable seller Checkout claim and cleanup worker make the exact
            // request safely retryable.
            throw listErr;
        }

        if (requestedCouponCode === FOUNDER_PROMOTION.code) {
            if (checkoutClaim.founderReservationToken) {
                founderReservation = { token: checkoutClaim.founderReservationToken };
            } else {
                founderReservation = await reserveFounderSlot(sellerId);
                checkoutClaim = await setSellerCheckoutClaimContext({
                    sellerId,
                    flow: 'subscription',
                    token: checkoutClaim.token,
                    founderReservationToken: founderReservation.token,
                });
            }
        }

        // Determine plan details
        const {
            isElite,
            includeMetaAds,
            planName,
            unitAmount: priceAmount,
            metaAddOn,
            freePeriodDays,
        } = buildPlanPricing(plan, includeMetaAdsRequested, Boolean(founderReservation));
        const getsFreePeriod = !sub.hasUsedFreePeriod;
        const trialDays = getsFreePeriod ? freePeriodDays : 0;
        const description = isElite
            ? getsFreePeriod
                ? `Rozare Elite - First ${trialDays} days free, then ${formatUsdMinorExact(priceAmount)}/month. Includes all Starter + Bonus features${includeMetaAds ? ' plus Meta ads add-on' : ''}${founderReservation ? ' at the FIRST100 founder rate' : ''}. Cancel anytime.`
                : `Rozare Elite - ${formatUsdMinorExact(priceAmount)}/month. Includes all Starter + Bonus features${includeMetaAds ? ' plus Meta ads add-on' : ''}${founderReservation ? ' at the FIRST100 founder rate' : ''}. Cancel anytime.`
            : getsFreePeriod
                ? `Rozare Starter - First ${trialDays} days free, then ${formatUsdMinorExact(priceAmount)}/month${founderReservation ? ' at the FIRST100 founder rate' : ''}. Cancel anytime.`
                : `Rozare Starter - ${formatUsdMinorExact(priceAmount)}/month${founderReservation ? ' at the FIRST100 founder rate' : ''}. Cancel anytime.`;

        const checkoutReturnUrls = getHostedCheckoutReturnUrls({
            client: req.body?.checkoutClient,
            flow: 'subscription',
            frontendUrl: process.env.FRONTEND_URL,
            backendUrl: process.env.BACKEND_PUBLIC_URL || 'https://rozare.up.railway.app',
            couponCode: founderReservation ? FOUNDER_PROMOTION.code : '',
        });

        // Create a subscription (with or without free trial period)
        const sessionConfig = {
            customer: customerId,
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: planName,
                        description,
                    },
                    unit_amount: priceAmount,
                    recurring: { interval: 'month' },
                },
                quantity: 1,
            }],
            subscription_data: {
                metadata: {
                    sellerId: sellerId.toString(),
                    plan: isElite ? 'elite' : 'starter',
                    includeMetaAds: includeMetaAds ? 'true' : 'false',
                    metaAdsAddonCents: String(metaAddOn || 0),
                    recurringAmountMinor: String(priceAmount),
                    recurringCurrency: 'USD',
                    introductoryPeriodDays: String(trialDays),
                    founderCouponCode: founderReservation ? FOUNDER_PROMOTION.code : '',
                    founderReservationToken: founderReservation?.token || '',
                    checkoutClaimToken: checkoutClaim.token,
                },
            },
            success_url: checkoutReturnUrls.successUrl,
            cancel_url: checkoutReturnUrls.cancelUrl,
            metadata: {
                sellerId: sellerId.toString(),
                plan: isElite ? 'elite' : 'starter',
                includeMetaAds: includeMetaAds ? 'true' : 'false',
                metaAdsAddonCents: String(metaAddOn || 0),
                recurringAmountMinor: String(priceAmount),
                recurringCurrency: 'USD',
                introductoryPeriodDays: String(trialDays),
                founderCouponCode: founderReservation ? FOUNDER_PROMOTION.code : '',
                founderReservationToken: founderReservation?.token || '',
                checkoutClaimToken: checkoutClaim.token,
            },
            expires_at: Math.floor(new Date(checkoutClaim.expiresAt).getTime() / 1000),
        };

        // Only add trial days if seller hasn't used free period before
        if (trialDays > 0) {
            sessionConfig.subscription_data.trial_period_days = trialDays;
        }

        stripeCreateStarted = true;
        checkoutSession = await stripe.checkout.sessions.create(sessionConfig, {
            idempotencyKey: `rozare-subscription-checkout-${checkoutClaim.token}`,
        });
        stripeCreateCompleted = true;
        if (!checkoutSession?.id || !checkoutSession?.url) {
            throw new Error('Stripe did not return a usable Checkout Session.');
        }

        await attachSellerCheckoutSession({
            sellerId,
            flow: 'subscription',
            token: checkoutClaim.token,
            sessionId: checkoutSession.id,
            sessionUrl: checkoutSession.url,
        });

        if (founderReservation) {
            await attachCheckoutSessionToReservation(sellerId, founderReservation.token, checkoutSession.id);
        }

        res.json({
            url: checkoutSession.url,
            sessionId: checkoutSession.id,
            founderOfferReserved: Boolean(founderReservation),
        });
    } catch (error) {
        let checkoutExpiryConfirmed = false;
        if (checkoutSession?.id && stripe?.checkout?.sessions?.expire) {
            try {
                const expiredSession = await stripe.checkout.sessions.expire(checkoutSession.id);
                checkoutExpiryConfirmed = expiredSession?.status === 'expired';
            } catch (expireError) {
                console.error('[subscription] Failed to expire unusable Checkout:', expireError.message);
            }
        }
        const createDefinitivelyRejected = stripeCreateStarted
            && !stripeCreateCompleted
            && isDefinitiveStripeCreationError(error);
        const safeToReleaseCheckout = !stripeCreateStarted
            || createDefinitivelyRejected
            || checkoutExpiryConfirmed;
        if (safeToReleaseCheckout && checkoutClaim && sellerId) {
            await releaseSellerCheckoutClaim({
                sellerId,
                flow: 'subscription',
                token: checkoutClaim.token,
            }).catch(releaseError => {
                console.error('[subscription] Failed to release Checkout claim:', releaseError.message);
            });
        }
        if (safeToReleaseCheckout && founderReservation) {
            await releaseFounderReservation({ sellerId, token: founderReservation.token }).catch(releaseError => {
                console.error('[subscription] Failed to release founder reservation after Checkout error:', releaseError.message);
            });
        }
        if (!safeToReleaseCheckout && checkoutClaim && sellerId) {
            await markSellerCheckoutClaimRecoverable({
                sellerId,
                flow: 'subscription',
                token: checkoutClaim.token,
                error,
            }).catch(recoveryError => {
                console.error('[subscription] Failed to mark Checkout claim recoverable:', recoveryError.message);
            });
        }
        // Surface a useful diagnostic so the seller (and our logs) can tell
        // *why* checkout failed instead of a generic 500. Stripe SDK errors
        // expose `type`, `code`, and `message`.
        console.error('Create checkout error:', {
            message: error?.message,
            type: error?.type,
            code: error?.code,
            statusCode: error?.statusCode,
            raw: error?.raw?.message,
        });
        const status = !safeToReleaseCheckout
            || error?.code === 'SUBSCRIPTION_STRIPE_PREFLIGHT_INCOMPLETE'
            ? 503 : [
            'FOUNDER_COUPON_FULL',
            'FOUNDER_COUPON_ALREADY_USED',
            'FOUNDER_CHECKOUT_PENDING',
            'CHECKOUT_PENDING',
            'CHECKOUT_CLAIM_LOST',
            'SUBSCRIPTION_STALE_CLEANUP_PENDING',
        ].includes(error?.code) ? 409 : 500;
        res.status(status).json({
            msg: !safeToReleaseCheckout
                ? 'Checkout creation could not be confirmed. Retry the same plan and options to recover this payment attempt.'
                : error?.raw?.message || error?.message || 'Failed to create checkout session',
            code: !safeToReleaseCheckout
                ? 'CHECKOUT_RECOVERY_PENDING'
                : error?.code || error?.type || 'CHECKOUT_ERROR',
        });
    }
};

const SUBSCRIPTION_BONUS_GRACE_MS = 3 * 24 * 60 * 60 * 1000;
const SUBDOMAIN_REMOVAL_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

function cancellationTransitionOwnsSubscription(subscription, stripeSubscriptionId) {
    return Boolean(
        subscription
        && String(subscription.cancellationTransition?.stripeSubscriptionId || '') === String(stripeSubscriptionId || '')
    );
}

function cancellationStillAuthoritative(subscription, stripeSubscriptionId) {
    return Boolean(
        cancellationTransitionOwnsSubscription(subscription, stripeSubscriptionId)
        && String(subscription.stripeSubscriptionId || '') === String(stripeSubscriptionId || '')
        && subscription.status === 'blocked'
    );
}

async function claimOrdinarySubscriptionCancellation({ subscription, eventId, now }) {
    const stripeSubscriptionId = String(subscription?.stripeSubscriptionId || '');
    if (!stripeSubscriptionId) return null;

    const activationPending = Boolean(subscription.pendingDowngrade?.activationPending);
    const keepStarterBonus = Boolean(
        !activationPending
        && subscription.plan === 'starter'
        && subscription.bonusFeaturesActive
        && !subscription.bonusFeaturesExpiredPermanently
        && subscription.bonusExpiryDate
        && now < subscription.bonusExpiryDate
    );
    const bonusGraceDeadline = keepStarterBonus
        ? new Date(now.getTime() + SUBSCRIPTION_BONUS_GRACE_MS)
        : null;
    const subdomainRemovalScheduledAt = new Date(now.getTime() + SUBDOMAIN_REMOVAL_GRACE_MS);

    const set = {
        status: 'blocked',
        cancelledAt: now,
        blockedAt: now,
        blockedReason: 'Subscription cancelled. Subscribe again to reactivate your store.',
        aiMessageLimit: -1,
        metaAdsIncluded: false,
        bonusGraceDeadline,
        pendingDowngrade: { toPlan: null, scheduledAt: null, activationPending: false },
        'paymentRisk.suspended': false,
        'paymentRisk.reason': '',
        'paymentRisk.previousStatus': null,
        'paymentRisk.stripeSubscriptionId': '',
        'paymentRisk.updatedAt': now,
        cancellationTransition: {
            stripeSubscriptionId,
            firstEventId: String(eventId || `subscription-deleted:${stripeSubscriptionId}`),
            cancelledAt: now,
            blockedAt: now,
            bonusGraceDeadline,
            subdomainRemovalScheduledAt,
            storeAppliedAt: null,
            cartCleanupAppliedAt: null,
            notificationEnqueuedAt: null,
            completedAt: null,
        },
    };
    if (keepStarterBonus) set.bonusGraceNotificationSent = false;
    if (activationPending) {
        set.bonusFeaturesActive = false;
        set.bonusExpiryDate = null;
        set.bonusFeaturesExpiredPermanently = Boolean(subscription.starterBonusPeriodUsed);
    }
    if (subscription.founderOffer?.active) {
        set['founderOffer.active'] = false;
        set['founderOffer.forfeitedAt'] = now;
    }

    const claimed = await SellerSubscription.findOneAndUpdate({
        _id: subscription._id,
        stripeSubscriptionId,
        'cancellationTransition.stripeSubscriptionId': { $ne: stripeSubscriptionId },
    }, {
        $set: set,
    }, { new: true, runValidators: true });
    if (claimed) return claimed;

    const current = await SellerSubscription.findById(subscription._id);
    return cancellationTransitionOwnsSubscription(current, stripeSubscriptionId)
        ? current
        : null;
}

async function markCancellationStep(subscriptionId, stripeSubscriptionId, field, at = new Date()) {
    await SellerSubscription.updateOne({
        _id: subscriptionId,
        'cancellationTransition.stripeSubscriptionId': stripeSubscriptionId,
        [`cancellationTransition.${field}`]: null,
    }, {
        $set: { [`cancellationTransition.${field}`]: at },
    });
    return SellerSubscription.findById(subscriptionId);
}

async function synchronizeOrdinaryCancellationStore(subscription) {
    const stripeSubscriptionId = String(subscription?.cancellationTransition?.stripeSubscriptionId || '');
    if (!stripeSubscriptionId || subscription.cancellationTransition?.storeAppliedAt) return subscription;

    let current = await SellerSubscription.findById(subscription._id);
    if (!current || current.cancellationTransition?.storeAppliedAt) return current;
    if (!cancellationStillAuthoritative(current, stripeSubscriptionId)) {
        return markCancellationStep(current._id, stripeSubscriptionId, 'storeAppliedAt');
    }

    const transition = current.cancellationTransition;
    const storeBefore = await Store.findOne({ seller: current.seller });
    if (storeBefore) {
        const purchased = Boolean(
            storeBefore.subdomainPurchase?.isPurchased
            && storeBefore.subdomainPurchase?.expiresAt
            && new Date(storeBefore.subdomainPurchase.expiresAt) > transition.cancelledAt
        );
        await Store.findOneAndUpdate({ _id: storeBefore._id }, {
            $set: {
                isActive: false,
                blockedAt: transition.blockedAt,
                'subdomainPurchase.removalScheduledAt': purchased
                    ? null
                    : transition.subdomainRemovalScheduledAt,
            },
            $unset: { subscriptionPaymentRiskLock: 1 },
        });

        // A newer Checkout can become authoritative while the cross-document
        // Store projection is in flight. Undo only this transition's exact
        // timestamps; never overwrite a newer/manual Store state.
        const afterStoreWrite = await SellerSubscription.findById(current._id)
            .select('status stripeSubscriptionId paymentRisk cancellationTransition')
            .lean();
        const fundedAfterWrite = afterStoreWrite
            && cancellationTransitionOwnsSubscription(afterStoreWrite, stripeSubscriptionId)
            && String(afterStoreWrite.stripeSubscriptionId || '') !== stripeSubscriptionId
            && ['active', 'free_period'].includes(afterStoreWrite.status)
            && !afterStoreWrite.paymentRisk?.suspended;
        if (fundedAfterWrite) {
            await Store.updateOne({
                _id: storeBefore._id,
                isActive: false,
                blockedAt: transition.blockedAt,
                ...(!purchased ? {
                    'subdomainPurchase.removalScheduledAt': transition.subdomainRemovalScheduledAt,
                } : {}),
            }, {
                $set: {
                    isActive: true,
                    blockedAt: null,
                    ...(!purchased ? { 'subdomainPurchase.removalScheduledAt': null } : {}),
                },
            });
        } else if (!purchased) {
            // A concurrent subdomain purchase must always win over a stale
            // removal schedule, even if it completed during this projection.
            await Store.updateOne({
                _id: storeBefore._id,
                'subdomainPurchase.isPurchased': true,
                'subdomainPurchase.expiresAt': { $gt: transition.cancelledAt },
                'subdomainPurchase.removalScheduledAt': transition.subdomainRemovalScheduledAt,
            }, {
                $set: { 'subdomainPurchase.removalScheduledAt': null },
            });
        }
    }

    return markCancellationStep(current._id, stripeSubscriptionId, 'storeAppliedAt');
}

async function synchronizeOrdinaryCancellationCartCleanup(subscription) {
    const stripeSubscriptionId = String(subscription?.cancellationTransition?.stripeSubscriptionId || '');
    if (!stripeSubscriptionId || subscription.cancellationTransition?.cartCleanupAppliedAt) return subscription;

    const current = await SellerSubscription.findById(subscription._id);
    if (!current || current.cancellationTransition?.cartCleanupAppliedAt) return current;
    if (cancellationStillAuthoritative(current, stripeSubscriptionId)) {
        const Cart = require('../models/Cart');
        const Product = require('../models/Product');
        const sellerProducts = await Product.find({ seller: current.seller }).select('_id').lean();
        if (sellerProducts.length > 0) {
            const productIds = sellerProducts.map(product => product._id);
            await Cart.updateMany(
                { 'cartItems.product': { $in: productIds } },
                { $pull: { cartItems: { product: { $in: productIds } } } },
            );
        }
    }
    return markCancellationStep(current._id, stripeSubscriptionId, 'cartCleanupAppliedAt');
}

async function synchronizeOrdinarySubscriptionCancellation(subscription) {
    let current = await synchronizeOrdinaryCancellationStore(subscription);
    current = await synchronizeOrdinaryCancellationCartCleanup(current);
    return current;
}

async function finalizeOrdinarySubscriptionCancellation(subscription) {
    const stripeSubscriptionId = String(subscription?.cancellationTransition?.stripeSubscriptionId || '');
    if (!stripeSubscriptionId || subscription?.cancellationTransition?.completedAt) return subscription;

    const dbSession = await mongoose.startSession();
    try {
        await dbSession.withTransaction(async () => {
            const current = await SellerSubscription.findById(subscription._id).session(dbSession);
            if (
                !current
                || current.cancellationTransition?.completedAt
                || !cancellationTransitionOwnsSubscription(current, stripeSubscriptionId)
            ) return;

            const completedAt = new Date();
            if (!cancellationStillAuthoritative(current, stripeSubscriptionId)) {
                // A newer paid subscription won before the alert was committed.
                // Record the old transition as fully reconciled without sending
                // a stale "store blocked" message to a reactivated seller.
                await SellerSubscription.updateOne({
                    _id: current._id,
                    'cancellationTransition.stripeSubscriptionId': stripeSubscriptionId,
                    'cancellationTransition.completedAt': null,
                }, {
                    $set: { 'cancellationTransition.completedAt': completedAt },
                }, { session: dbSession });
                return;
            }

            await enqueueSubscriptionCancellationNotification(current, { session: dbSession });
            const marked = await SellerSubscription.updateOne({
                _id: current._id,
                stripeSubscriptionId,
                status: 'blocked',
                'cancellationTransition.stripeSubscriptionId': stripeSubscriptionId,
                'cancellationTransition.notificationEnqueuedAt': null,
                'cancellationTransition.completedAt': null,
            }, {
                $set: {
                    'cancellationTransition.notificationEnqueuedAt': completedAt,
                    'cancellationTransition.completedAt': completedAt,
                },
            }, { session: dbSession });
            if (marked.modifiedCount !== 1) {
                const conflict = new Error('Subscription cancellation notification ownership changed during finalization.');
                conflict.code = 'SUBSCRIPTION_CANCELLATION_FINALIZE_CONFLICT';
                throw conflict;
            }
        });
    } finally {
        await dbSession.endSession();
    }
    return SellerSubscription.findById(subscription._id);
}

async function finalizeSubscriptionActivationNotification(subscription, sourceReference) {
    const subscriptionId = subscription?._id || subscription;
    const source = String(sourceReference || '');
    if (!subscriptionId || !source) return subscription;

    const dbSession = await mongoose.startSession();
    try {
        await dbSession.withTransaction(async () => {
            const current = await SellerSubscription.findById(subscriptionId).session(dbSession);
            const activation = current?.activationNotification;
            if (
                !current
                || String(activation?.sourceReference || '') !== source
                || activation?.completedAt
            ) return;

            const completedAt = new Date();
            const stillAuthoritative = (
                String(current.stripeSubscriptionId || '') === String(activation.stripeSubscriptionId || '')
                && ['active', 'free_period'].includes(current.status)
            );
            if (!stillAuthoritative) {
                await SellerSubscription.updateOne({
                    _id: current._id,
                    'activationNotification.sourceReference': source,
                    'activationNotification.completedAt': null,
                }, {
                    $set: { 'activationNotification.completedAt': completedAt },
                }, { session: dbSession });
                return;
            }

            await enqueueSubscriptionActivationNotification(current, { session: dbSession });
            const marked = await SellerSubscription.updateOne({
                _id: current._id,
                stripeSubscriptionId: activation.stripeSubscriptionId,
                status: { $in: ['active', 'free_period'] },
                'activationNotification.sourceReference': source,
                'activationNotification.completedAt': null,
            }, {
                $set: {
                    'activationNotification.notificationEnqueuedAt': completedAt,
                    'activationNotification.completedAt': completedAt,
                },
            }, { session: dbSession });
            if (marked.modifiedCount !== 1) {
                const conflict = new Error('Subscription activation notification ownership changed during finalization.');
                conflict.code = 'SUBSCRIPTION_ACTIVATION_FINALIZE_CONFLICT';
                throw conflict;
            }
        });
    } finally {
        await dbSession.endSession();
    }
    return SellerSubscription.findById(subscriptionId);
}

// Handle subscription webhook events
exports.handleWebhook = async (event) => {
    try {
        switch (event.type) {
            case 'checkout.session.expired': {
                const session = event.data.object;
                const sellerId = session.metadata?.sellerId;
                const checkoutClaimToken = session.metadata?.checkoutClaimToken;
                const checkoutFlow = session.mode === 'payment'
                    && session.metadata?.type === 'subdomain_purchase'
                    ? 'subdomain'
                    : session.mode === 'subscription' ? 'subscription' : null;
                if (sellerId && checkoutFlow && (checkoutClaimToken || session.id)) {
                    await releaseSellerCheckoutClaim({
                        sellerId,
                        flow: checkoutFlow,
                        token: checkoutClaimToken,
                        sessionId: session.id,
                    }).catch(releaseError => {
                        console.error('[subscription] Failed to release expired Checkout claim:', releaseError.message);
                    });
                }
                if (checkoutFlow === 'subdomain' && sellerId && session.metadata?.storeId && checkoutClaimToken) {
                    const { releaseSubdomainResourceLock } = require('../services/subdomainResourceLockService');
                    await releaseSubdomainResourceLock({
                        storeId: session.metadata.storeId,
                        sellerId,
                        token: checkoutClaimToken,
                    });
                }
                if (session.mode === 'subscription' && session.metadata?.founderReservationToken) {
                    await releaseFounderReservation({
                        sellerId,
                        token: session.metadata.founderReservationToken,
                        checkoutSessionId: session.id,
                    });
                }
                break;
            }

            case 'checkout.session.completed': {
                const session = event.data.object;

                // Handle subdomain purchase (one-time payment)
                if (session.mode === 'payment' && session.metadata?.type === 'subdomain_purchase') {
                    const { handleSubdomainPurchaseWebhook } = require('./subdomainPurchaseController');
                    const processed = await handleSubdomainPurchaseWebhook(session);
                    if (!processed) {
                        const error = new Error('The completed subdomain Checkout was not processed.');
                        error.code = 'SUBDOMAIN_CHECKOUT_NOT_PROCESSED';
                        throw error;
                    }
                    await releaseSellerCheckoutClaim({
                        sellerId: session.metadata?.sellerId,
                        flow: 'subdomain',
                        token: session.metadata?.checkoutClaimToken,
                        sessionId: session.id,
                    }).catch(releaseError => {
                        console.error('[subscription] Failed to release completed subdomain Checkout claim:', releaseError.message);
                    });
                    break;
                }

                if (session.mode !== 'subscription') break;

                const sellerId = session.metadata?.sellerId;
                if (!sellerId) break;

                let sub = await SellerSubscription.findOne({ seller: sellerId });
                if (!sub) break;

                if (sub.processedCheckoutSessionIds?.includes(session.id)) {
                    if (
                        sub.pendingStoreSync?.kind === 'checkout_activation'
                        && sub.pendingStoreSync?.eventId === session.id
                    ) {
                        await synchronizePendingSubscriptionStore(sub);
                    }
                    await finalizeSubscriptionActivationNotification(sub, session.id);
                    await releaseSellerCheckoutClaim({
                        sellerId,
                        flow: 'subscription',
                        token: session.metadata?.checkoutClaimToken,
                        sessionId: session.id,
                    }).catch(() => undefined);
                    break;
                }

                const selectedPlan = session.metadata?.plan || 'starter';
                if (!['starter', 'elite'].includes(selectedPlan)) {
                    const planSnapshotError = new Error('Completed Checkout has an invalid plan snapshot.');
                    planSnapshotError.code = 'CHECKOUT_SUBSCRIPTION_PLAN_SNAPSHOT_INVALID';
                    throw planSnapshotError;
                }
                const isElite = selectedPlan === 'elite';
                const rawIncludeMetaAds = session.metadata?.includeMetaAds;
                if (
                    rawIncludeMetaAds !== undefined
                    && rawIncludeMetaAds !== ''
                    && !['true', 'false'].includes(rawIncludeMetaAds)
                ) {
                    const planSnapshotError = new Error('Completed Checkout has an invalid Meta ads snapshot.');
                    planSnapshotError.code = 'CHECKOUT_SUBSCRIPTION_PLAN_SNAPSHOT_INVALID';
                    throw planSnapshotError;
                }
                const includeMetaAds = isElite && session.metadata?.includeMetaAds === 'true';
                if (!isElite && session.metadata?.includeMetaAds === 'true') {
                    const planSnapshotError = new Error('Completed Starter Checkout cannot include the Elite Meta ads add-on.');
                    planSnapshotError.code = 'CHECKOUT_SUBSCRIPTION_PLAN_SNAPSHOT_INVALID';
                    throw planSnapshotError;
                }
                const founderReservationToken = session.metadata?.founderReservationToken || '';
                const usesFounderCoupon = session.metadata?.founderCouponCode === FOUNDER_PROMOTION.code
                    && Boolean(founderReservationToken);
                const now = new Date();

                if (typeof session.subscription !== 'string' || !session.subscription.trim()) {
                    const subscriptionSnapshotError = new Error('Completed Checkout is missing its Stripe subscription reference.');
                    subscriptionSnapshotError.code = 'CHECKOUT_SUBSCRIPTION_MISMATCH';
                    throw subscriptionSnapshotError;
                }

                // Validate every immutable Stripe-owned activation fact before
                // claiming local state, consuming a founder reservation, or
                // cancelling an older Stripe subscription. A malformed or
                // incomplete remote snapshot must be a side-effect-free retry.
                const rawRecurringAmountMinor = session.metadata?.recurringAmountMinor;
                const hasRecurringAmountSnapshot = !(rawRecurringAmountMinor === undefined
                    || rawRecurringAmountMinor === null
                    || rawRecurringAmountMinor === '');
                const expectedRecurringAmountMinor = hasRecurringAmountSnapshot
                    ? stripeIntegerDecimal(rawRecurringAmountMinor)
                    : null;
                if (
                    (hasRecurringAmountSnapshot && (
                        !Number.isSafeInteger(expectedRecurringAmountMinor)
                        || expectedRecurringAmountMinor <= 0
                    ))
                    || (session.metadata?.recurringCurrency
                        && String(session.metadata.recurringCurrency).toUpperCase() !== 'USD')
                ) {
                    const priceSnapshotError = new Error('Completed Checkout has an invalid recurring-price snapshot.');
                    priceSnapshotError.code = 'CHECKOUT_SUBSCRIPTION_PRICE_SNAPSHOT_INVALID';
                    throw priceSnapshotError;
                }
                const activatedStripeSubscription = await retrievePlanChangeStripeSubscription(session.subscription);
                if (
                    String(activatedStripeSubscription?.id || '') !== String(session.subscription)
                    || stripeObjectId(activatedStripeSubscription?.customer) !== String(sub.stripeCustomerId)
                    || activatedStripeSubscription?.pending_update
                ) {
                    const mismatchError = new Error('Completed Checkout returned a Stripe subscription with mismatched ownership or a pending update.');
                    mismatchError.code = 'CHECKOUT_SUBSCRIPTION_MISMATCH';
                    throw mismatchError;
                }
                const activatedItem = exactStripePlanChangeSource(activatedStripeSubscription, {
                    expectedUnitAmount: expectedRecurringAmountMinor,
                });
                if (!activatedItem.ok) {
                    const mismatchError = new Error(`Completed Checkout subscription is not exact: ${activatedItem.reason}`);
                    mismatchError.code = 'CHECKOUT_SUBSCRIPTION_MISMATCH';
                    throw mismatchError;
                }
                // New Checkouts carry an exact server-created amount snapshot.
                // For older sessions that do not, the complete Stripe Price is
                // the only historical authority; never substitute a later
                // application catalog value.
                const recurringAmountMinor = expectedRecurringAmountMinor
                    ?? activatedItem.unitAmount;
                const introductoryPeriodDays = checkoutIntroductoryPeriodDays(session, {
                    stripeSubscription: activatedStripeSubscription,
                    legacyEligible: !sub.hasUsedFreePeriod,
                });
                const activatedPeriod = exactStripeSubscriptionBillingPeriod(
                    activatedStripeSubscription,
                    { introductoryPeriodDays },
                );

                // Atomic race guard: try to "claim" this subscription slot. If another parallel
                // webhook already claimed a DIFFERENT stripeSubscriptionId for this seller in an
                // active billing state, this update will match zero documents and we know the
                // incoming checkout is a duplicate from a parallel-checkout exploit.
                let previousStripeSubId = sub.stripeSubscriptionId;
                const claimed = await SellerSubscription.findOneAndUpdate(
                    {
                        seller: sellerId,
                        $or: [
                            { stripeSubscriptionId: null },
                            { stripeSubscriptionId: { $exists: false } },
                            { stripeSubscriptionId: session.subscription },
                            // Allow overwriting if the existing sub is in a non-billing state
                            { status: { $in: ['trial', 'cancelled', 'blocked'] } },
                        ],
                    },
                    [{
                        $set: {
                            // Freeze the predecessor in the same atomic write
                            // that claims the replacement. If the process dies
                            // before the durable Stripe cleanup row is created,
                            // a signed webhook replay can reconstruct it without
                            // guessing which subscription may still be billing.
                            'pendingStoreSync.previousStripeSubscriptionId': {
                                $cond: [
                                    {
                                        $and: [
                                            { $eq: ['$pendingStoreSync.kind', 'checkout_activation'] },
                                            { $eq: ['$pendingStoreSync.eventId', session.id] },
                                            { $eq: ['$pendingStoreSync.stripeSubscriptionId', session.subscription] },
                                        ],
                                    },
                                    '$pendingStoreSync.previousStripeSubscriptionId',
                                    { $ifNull: ['$stripeSubscriptionId', null] },
                                ],
                            },
                            'pendingStoreSync.kind': 'checkout_activation',
                            'pendingStoreSync.eventId': session.id,
                            'pendingStoreSync.stripeSubscriptionId': session.subscription,
                            'pendingStoreSync.blockedAt': null,
                            stripeSubscriptionId: session.subscription,
                        },
                    }],
                    { new: false } // we only need to know if a doc matched; we'll reload below
                );

                if (!claimed) {
                    // Another webhook already claimed an active sub — this is a
                    // duplicate from a parallel checkout. Persist the cleanup
                    // before contacting Stripe so an uncertain provider outcome
                    // can never disappear into a log line.
                    const authoritative = await SellerSubscription.findOne({ seller: sellerId })
                        .select('stripeSubscriptionId stripeCustomerId')
                        .lean();
                    const duplicateCleanup = await ensureStripeSubscriptionCleanup({
                        seller: sellerId,
                        staleStripeSubscriptionId: session.subscription,
                        replacementStripeSubscriptionId: authoritative?.stripeSubscriptionId || '',
                        stripeCustomerId: authoritative?.stripeCustomerId || sub.stripeCustomerId || '',
                        reason: 'duplicate_checkout',
                        sourceReference: session.id,
                        occurredAt: activatedPeriod.subscriptionStartedAt,
                    });
                    const duplicateCleanupResult = await processStripeSubscriptionCleanupById(duplicateCleanup._id);
                    if (duplicateCleanupResult?.status === 'completed') {
                        console.log(`[subscription] Race lost for seller ${sellerId}. Confirmed duplicate incoming sub ${session.subscription} cancelled.`);
                    } else {
                        console.error('[subscription] Duplicate incoming subscription cancellation remains under durable recovery.', {
                            sellerId,
                            subscriptionId: session.subscription,
                            cleanupId: String(duplicateCleanup._id),
                            status: duplicateCleanupResult?.status,
                        });
                    }
                    if (usesFounderCoupon) {
                        await releaseFounderReservation({
                            sellerId,
                            token: founderReservationToken,
                            checkoutSessionId: session.id,
                        });
                    }
                    await releaseSellerCheckoutClaim({
                        sellerId,
                        flow: 'subscription',
                        token: session.metadata?.checkoutClaimToken,
                        sessionId: session.id,
                    }).catch(releaseError => {
                        console.error('[subscription] Failed to release duplicate Checkout claim:', releaseError.message);
                    });
                    break;
                }

                // Reload the freshly-claimed document so `sub.save()` works on the latest state
                sub = await SellerSubscription.findOne({ seller: sellerId });
                if (!sub) break;

                // `findOneAndUpdate(..., { new: false })` returns the exact
                // pre-claim authority snapshot. On a webhook replay after the
                // atomic claim but before cleanup persistence, that snapshot
                // already carries the frozen predecessor marker. Recover it
                // before any founder-rejection or replacement cleanup branch;
                // waiting until the later subscription projection would skip
                // cancellation of the old, potentially still-billing plan.
                const claimedExistingMarker = claimed.pendingStoreSync?.kind === 'checkout_activation'
                    && claimed.pendingStoreSync?.eventId === session.id
                    && claimed.pendingStoreSync?.stripeSubscriptionId === session.subscription;
                previousStripeSubId = claimedExistingMarker
                    ? claimed.pendingStoreSync?.previousStripeSubscriptionId
                    : claimed.stripeSubscriptionId;

                if (usesFounderCoupon) {
                    try {
                        const founderClaim = await claimFounderReservation({
                            sellerId,
                            token: founderReservationToken,
                            checkoutSessionId: session.id,
                        });
                        sub.founderOffer = {
                            active: true,
                            code: FOUNDER_PROMOTION.code,
                            discountPercent: FOUNDER_PROMOTION.discountPercent,
                            claimedAt: founderClaim.claimedAt || sub.founderOffer?.claimedAt || now,
                            forfeitedAt: null,
                            source: 'coupon',
                        };
                    } catch (founderError) {
                        const isDeterministicFounderFailure = [
                            'FOUNDER_RESERVATION_INVALID',
                            'FOUNDER_COUPON_ALREADY_USED',
                        ].includes(founderError?.code);
                        if (!isDeterministicFounderFailure) {
                            // A transient database failure must make Stripe retry the webhook.
                            // Cancelling here would incorrectly destroy a valid founder checkout.
                            if (previousStripeSubId) {
                                await SellerSubscription.updateOne(
                                    { seller: sellerId, stripeSubscriptionId: session.subscription },
                                    { $set: { stripeSubscriptionId: previousStripeSubId } }
                                );
                            } else {
                                await SellerSubscription.updateOne(
                                    { seller: sellerId, stripeSubscriptionId: session.subscription },
                                    { $unset: { stripeSubscriptionId: 1 } }
                                );
                            }
                            throw founderError;
                        }

                        console.error('[subscription] Founder reservation claim failed; cancelling discounted subscription.', {
                            sellerId,
                            sessionId: session.id,
                            subscriptionId: session.subscription,
                            code: founderError?.code,
                            message: founderError?.message,
                        });
                        const invalidFounderCleanup = await ensureStripeSubscriptionCleanup({
                            seller: sellerId,
                            staleStripeSubscriptionId: session.subscription,
                            replacementStripeSubscriptionId: previousStripeSubId || '',
                            stripeCustomerId: sub.stripeCustomerId || '',
                            reason: 'invalid_founder_checkout',
                            sourceReference: session.id,
                            occurredAt: activatedPeriod.subscriptionStartedAt,
                        });
                        // Restore local authority only after the cleanup intent
                        // is durable, but before its guarded Stripe attempt. If
                        // we attempted first, the cleanup worker would correctly
                        // see the rejected incoming plan as locally authoritative
                        // and stop forever in manual review.
                        if (previousStripeSubId) {
                            await SellerSubscription.updateOne(
                                { seller: sellerId, stripeSubscriptionId: session.subscription },
                                { $set: { stripeSubscriptionId: previousStripeSubId } }
                            );
                        } else {
                            await SellerSubscription.updateOne(
                                { seller: sellerId, stripeSubscriptionId: session.subscription },
                                { $unset: { stripeSubscriptionId: 1 } }
                            );
                        }
                        const invalidFounderCleanupResult = await processStripeSubscriptionCleanupById(
                            invalidFounderCleanup._id,
                        );
                        if (invalidFounderCleanupResult?.status !== 'completed') {
                            console.error('[subscription] Invalid founder subscription cancellation remains under durable recovery.', {
                                sellerId,
                                subscriptionId: session.subscription,
                                cleanupId: String(invalidFounderCleanup._id),
                                status: invalidFounderCleanupResult?.status,
                            });
                        }
                        break;
                    }
                }

                // If we claimed over a stale stripeSubscriptionId (different from incoming),
                // cancel the stale one on Stripe's side.
                if (
                    previousStripeSubId &&
                    previousStripeSubId !== session.subscription
                ) {
                    const replacementCleanup = await ensureStripeSubscriptionCleanup({
                        seller: sellerId,
                        staleStripeSubscriptionId: previousStripeSubId,
                        replacementStripeSubscriptionId: session.subscription,
                        stripeCustomerId: sub.stripeCustomerId || '',
                        reason: 'replacement_activation',
                        sourceReference: session.id,
                        occurredAt: activatedPeriod.subscriptionStartedAt,
                    });
                    const replacementCleanupResult = await processStripeSubscriptionCleanupById(
                        replacementCleanup._id,
                    );
                    if (replacementCleanupResult?.status === 'completed') {
                        console.log(`[subscription] Confirmed stale Stripe sub ${previousStripeSubId} cancelled in favor of ${session.subscription}.`);
                    } else {
                        console.error('[subscription] Stale Stripe subscription cancellation remains under durable recovery.', {
                            sellerId,
                            staleSubscriptionId: previousStripeSubId,
                            replacementSubscriptionId: session.subscription,
                            cleanupId: String(replacementCleanup._id),
                            status: replacementCleanupResult?.status,
                        });
                    }
                }

                sub.plan = isElite ? 'elite' : 'starter';
                sub.planName = isElite
                    ? (includeMetaAds ? 'Rozare Elite + Meta Ads' : 'Rozare Elite')
                    : 'Rozare Starter';
                sub.metaAdsIncluded = includeMetaAds;
                if (String(previousStripeSubId || '') !== String(session.subscription || '')) {
                    resetSubscriptionInvoiceOrdering(sub);
                }

                sub.stripeSubscriptionId = session.subscription;
                // `warningEmailSent` is shared by seller-trial and scheduled
                // subscription-ending warnings. A seller may subscribe after
                // receiving the trial warning, so begin the newly activated
                // billing lifecycle with a fresh ending-warning state.
                sub.warningEmailSent = false;
                sub.aiMessageLimit = -1;
                sub.blockedAt = null;
                sub.blockedReason = '';
                sub.paymentRisk.suspended = false;
                sub.paymentRisk.reason = '';
                sub.paymentRisk.previousStatus = null;
                sub.paymentRisk.stripeSubscriptionId = '';
                sub.paymentRisk.updatedAt = now;
                sub.pendingDowngrade = { toPlan: null, scheduledAt: null, activationPending: false };
                sub.processedCheckoutSessionIds.addToSet(session.id);
                sub.pendingStoreSync = {
                    kind: 'checkout_activation',
                    eventId: session.id,
                    stripeSubscriptionId: session.subscription,
                    previousStripeSubscriptionId: previousStripeSubId || null,
                    blockedAt: null,
                };

                let freshStarterBonusGranted = false;
                if (isElite) {
                    // Elite plan: bonus features are always active (never expire)
                    sub.bonusFeaturesActive = true;
                    sub.bonusExpiryDate = null; // No expiry for Elite
                    sub.bonusFeaturesExpiredPermanently = false;
                    sub.bonusGraceDeadline = null;
                } else {
                    // Starter plan: check permanent starter bonus usage, grace period, and temp expiry
                    if (sub.starterBonusPeriodUsed) {
                        // This seller has already had their Starter bonus period before — no more bonus on Starter
                        sub.bonusFeaturesActive = false;
                        sub.bonusFeaturesExpiredPermanently = true;
                        sub.bonusGraceDeadline = null;
                    } else if (sub.bonusFeaturesExpiredPermanently) {
                        // Permanently expired (safety check) — Starter re-subscription does NOT restore bonus
                        sub.bonusFeaturesActive = false;
                    } else if (sub.bonusGraceDeadline && now <= sub.bonusGraceDeadline && sub.bonusExpiryDate) {
                        // Re-subscribed within 3-day grace period — keep remaining bonus time
                        sub.bonusFeaturesActive = true;
                        // bonusExpiryDate stays the same (the original 6-month deadline)
                        sub.bonusGraceDeadline = null;
                        // starterBonusPeriodUsed already true from initial subscribe
                    } else if (sub.bonusGraceDeadline && now > sub.bonusGraceDeadline) {
                        // Grace period passed — bonus permanently gone for Starter
                        sub.bonusFeaturesActive = false;
                        sub.bonusFeaturesExpiredPermanently = true;
                        sub.bonusGraceDeadline = null;
                    } else {
                        // Fresh subscription (first time on Starter) — give 6 months bonus
                        sub.bonusFeaturesActive = true;
                        // Stripe's authoritative item-period start is loaded
                        // below; defer the calendar deadline so a delayed
                        // webhook cannot extend the six-month grant.
                        sub.bonusExpiryDate = null;
                        sub.bonusGraceDeadline = null;
                        sub.starterBonusPeriodUsed = true; // Mark permanently — can never get fresh Starter bonus again
                        freshStarterBonusGranted = true;
                    }
                }

                sub.subscribedAt = activatedPeriod.subscriptionStartedAt;
                sub.currentPeriodStart = activatedPeriod.currentPeriodStart;
                sub.currentPeriodEnd = activatedPeriod.currentPeriodEnd;
                if (freshStarterBonusGranted) {
                    sub.bonusExpiryDate = addUtcCalendarMonths(
                        activatedPeriod.subscriptionStartedAt,
                        6,
                    );
                }
                if (activatedPeriod.trialActive) {
                    sub.status = 'free_period';
                    sub.freePeriodEndDate = activatedPeriod.trialEnd;
                    sub.hasUsedFreePeriod = true;
                } else {
                    sub.status = 'active';
                    sub.freePeriodEndDate = null;
                    if (introductoryPeriodDays > 0) sub.hasUsedFreePeriod = true;
                }
                sub.stripeProductId = activatedItem.productId;
                sub.stripePriceId = activatedItem.priceId;
                terminalizePlanChangeForSubscriptionReplacement(
                    sub,
                    previousStripeSubId,
                    session.subscription,
                );
                sub.activationNotification = {
                    kind: 'checkout_activation',
                    sourceReference: session.id,
                    stripeSubscriptionId: session.subscription,
                    occurredAt: now,
                    planName: sub.planName,
                    recurringAmountMinor,
                    currency: 'USD',
                    // A delayed completion may arrive after Stripe already
                    // ended the trial and started paid billing. In that case the
                    // activation receipt must not promise a free period that no
                    // longer exists.
                    freePeriodDays: activatedPeriod.trialActive ? introductoryPeriodDays : 0,
                    freePeriodEndDate: activatedPeriod.trialActive ? sub.freePeriodEndDate : null,
                    notificationEnqueuedAt: null,
                    completedAt: null,
                };

                await sub.save();

                // Clear the persisted marker only after the Store projection is
                // durable. A webhook retry resumes this exact operation.
                await synchronizePendingSubscriptionStore(sub);

                // Billing state is durable at this point; the seller can safely
                // start a future Checkout only after this paid session is closed.
                await releaseSellerCheckoutClaim({
                    sellerId,
                    flow: 'subscription',
                    token: session.metadata?.checkoutClaimToken,
                    sessionId: session.id,
                }).catch(releaseError => {
                    console.error('[subscription] Failed to release completed Checkout claim:', releaseError.message);
                });

                await finalizeSubscriptionActivationNotification(sub, session.id);
                break;
            }

            case 'customer.subscription.updated':
            case 'customer.subscription.pending_update_applied':
            case 'customer.subscription.pending_update_expired': {
                const incoming = event.data.object;
                let sub = await SellerSubscription.findOne({ stripeSubscriptionId: incoming.id });
                if (
                    !sub
                    || !['processing', 'pending_payment', 'recoverable'].includes(sub.planChangeAttempt?.state)
                    || sub.planChangeAttempt?.targetPlan !== 'elite'
                    || !sub.planChangeAttempt?.stripeProductId
                    || !sub.planChangeAttempt?.stripePriceId
                ) break;

                const stripeSubscription = await retrievePlanChangeStripeSubscription(incoming.id);
                if (stripeSubscription.pending_update) {
                    const matches = pendingUpdateMatchesTarget(stripeSubscription, {
                        priceId: sub.planChangeAttempt.stripePriceId,
                        subscriptionItemId: sub.planChangeAttempt.stripeSubscriptionItemId,
                        invoiceId: sub.planChangeAttempt.stripeInvoiceId,
                    });
                    if (!matches) {
                        await clearTerminalPlanChangeAttempt(
                            sub._id,
                            sub.planChangeAttempt.idempotencyToken,
                            'Stripe superseded the pending plan change.',
                        );
                        break;
                    }
                    const exactPendingInvoice = await exactPendingPlanChangeInvoice(
                        stripeSubscription,
                        sub,
                        sub.planChangeAttempt,
                    );
                    if (!exactPendingInvoice.ok) {
                        await clearTerminalPlanChangeAttempt(
                            sub._id,
                            sub.planChangeAttempt.idempotencyToken,
                            exactPendingInvoice.reason,
                        );
                        break;
                    }
                    const bound = await bindPlanChangeInvoice(
                        sub._id,
                        sub.planChangeAttempt.idempotencyToken,
                        exactPendingInvoice.invoiceId,
                        stripePendingUpdateExpiryDate(stripeSubscription.pending_update.expires_at),
                    );
                    if (!bound) {
                        await clearTerminalPlanChangeAttempt(
                            sub._id,
                            sub.planChangeAttempt.idempotencyToken,
                            'A different Stripe invoice already owns this plan-change attempt.',
                        );
                    }
                    break;
                }

                let convergence;
                if (sub.planChangeAttempt.changeKind === 'meta_removal') {
                    const authority = await stripePlanChangeIsAuthoritative(stripeSubscription, {
                        expectedSubscriptionId: sub.stripeSubscriptionId,
                        expectedCustomerId: sub.stripeCustomerId,
                        expectedUnitAmount: sub.planChangeAttempt.targetUnitAmountMinor,
                        expectedPriceId: sub.planChangeAttempt.stripePriceId,
                        expectedProductId: sub.planChangeAttempt.stripeProductId,
                        expectedSubscriptionItemId: sub.planChangeAttempt.stripeSubscriptionItemId,
                        allowUnpaidRemoval: true,
                    });
                    if (authority.ok) {
                        convergence = await applyLocalPlanChange(
                            sub._id,
                            sub.planChangeAttempt.idempotencyToken,
                            null,
                        );
                        if (convergence.applied) {
                            await ensurePlanChangeCompletionNotificationOutboxed(
                                sub._id,
                                sub.planChangeAttempt.idempotencyToken,
                            );
                        }
                    } else {
                        convergence = { applied: false, reason: authority.reason };
                    }
                } else {
                    convergence = await convergePaidPlanChange({
                        subscription: sub,
                        stripeSubscription,
                        eventId: event.id,
                        eventCreated: event.created,
                    });
                }
                if (
                    event.type === 'customer.subscription.pending_update_expired'
                    && !convergence.applied
                    && ['processing', 'pending_payment', 'recoverable'].includes(sub.planChangeAttempt.state)
                ) {
                    const incomingInvoice = stripeInvoiceObject(incoming);
                    const incomingInvoiceId = stripeObjectId(
                        incomingInvoice || incoming.latest_invoice,
                    );
                    const ownsExpiredAttempt = incomingInvoiceId
                        && incomingInvoiceId === sub.planChangeAttempt.stripeInvoiceId;
                    if (ownsExpiredAttempt) {
                        await clearTerminalPlanChangeAttempt(
                            sub._id,
                            sub.planChangeAttempt.idempotencyToken,
                            'Stripe expired the unpaid pending plan change.',
                        );
                    }
                }
                break;
            }

            case 'customer.subscription.deleted': {
                const subscription = event.data.object;
                let sub = await SellerSubscription.findOne({
                    $or: [
                        { stripeSubscriptionId: subscription.id },
                        { 'cancellationTransition.stripeSubscriptionId': subscription.id },
                        { 'activationNotification.sourceReference': subscription.id },
                        {
                            'pendingStoreSync.previousStripeSubscriptionId': subscription.id,
                            'pendingStoreSync.kind': { $in: ['downgrade_block', 'downgrade_activation'] },
                        },
                    ],
                });
                if (!sub) break;

                const now = new Date();

                if (
                    sub.stripeSubscriptionId !== subscription.id
                    && sub.pendingStoreSync?.previousStripeSubscriptionId === subscription.id
                    && ['downgrade_block', 'downgrade_activation'].includes(sub.pendingStoreSync?.kind)
                ) {
                    // The Stripe subscription and local Subscription transition
                    // already completed, but the Store write failed. Resume only
                    // that owned projection; never create a second subscription.
                    await synchronizePendingSubscriptionStore(sub);
                    if (sub.activationNotification?.sourceReference === subscription.id) {
                        await finalizeSubscriptionActivationNotification(sub, subscription.id);
                    }
                    break;
                }

                if (
                    sub.stripeSubscriptionId !== subscription.id
                    && sub.activationNotification?.sourceReference === subscription.id
                ) {
                    await finalizeSubscriptionActivationNotification(sub, subscription.id);
                    break;
                }

                if (
                    sub.stripeSubscriptionId !== subscription.id
                    && cancellationTransitionOwnsSubscription(sub, subscription.id)
                ) {
                    sub = await synchronizeOrdinarySubscriptionCancellation(sub);
                    await finalizeOrdinarySubscriptionCancellation(sub);
                    break;
                }

                // Check if this is a downgrade to Starter (not a real cancellation)
                if (sub.pendingDowngrade?.toPlan === 'starter') {
                    sub = await ensurePendingDowngradeQuoteFrozen(sub);
                    const downgradeQuote = requirePendingDowngradeQuote(sub);
                    if (downgradeQuote.sourceStripeSubscriptionId !== subscription.id) {
                        throw pendingDowngradeError(
                            'The ended Stripe subscription does not own this frozen downgrade quote.',
                            'PENDING_DOWNGRADE_SOURCE_MISMATCH'
                        );
                    }
                    const transitionToken = crypto.randomUUID();
                    const transitionEventId = String(event.id || `subscription-deleted:${subscription.id}`);
                    const staleTransitionCutoff = new Date(now.getTime() - 10 * 60 * 1000);
                    const transitionClaim = await SellerSubscription.findOneAndUpdate(
                        {
                            _id: sub._id,
                            stripeSubscriptionId: subscription.id,
                            'pendingDowngrade.toPlan': 'starter',
                            $or: [
                                { 'pendingDowngrade.processingToken': null },
                                { 'pendingDowngrade.processingToken': { $exists: false } },
                                { 'pendingDowngrade.processingStartedAt': { $lte: staleTransitionCutoff } },
                            ],
                        },
                        {
                            $set: {
                                'pendingDowngrade.processingToken': transitionToken,
                                'pendingDowngrade.processingEventId': transitionEventId,
                                'pendingDowngrade.processingStartedAt': now,
                            },
                        },
                        { new: true }
                    );

                    if (!transitionClaim) {
                        const current = await SellerSubscription.findById(sub._id)
                            .select('stripeSubscriptionId pendingDowngrade')
                            .lean();
                        if (
                            !current
                            || current.stripeSubscriptionId !== subscription.id
                            || current.pendingDowngrade?.toPlan !== 'starter'
                        ) {
                            // The first delivery already completed the transition.
                            break;
                        }
                        const inProgressError = new Error('This downgrade webhook transition is already being processed.');
                        inProgressError.code = 'DOWNGRADE_TRANSITION_IN_PROGRESS';
                        throw inProgressError;
                    }
                    sub = transitionClaim;

                    // Auto-create a new Starter subscription via Stripe
                    try {
                        // Ensure customer has a default payment method
                        // Get the payment method from the cancelled Elite subscription
                        let defaultPaymentMethod = null;
                        try {
                            const customer = await stripe.customers.retrieve(sub.stripeCustomerId);
                            defaultPaymentMethod = customer.invoice_settings?.default_payment_method;

                            // If no default payment method, try to get one from the ended subscription
                            if (!defaultPaymentMethod) {
                                const endedSub = await stripe.subscriptions.retrieve(subscription.id).catch(() => null);
                                if (endedSub?.default_payment_method) {
                                    defaultPaymentMethod = endedSub.default_payment_method;
                                    // Set it as customer's default
                                    await stripe.customers.update(sub.stripeCustomerId, {
                                        invoice_settings: { default_payment_method: defaultPaymentMethod },
                                    });
                                }
                            }
                        } catch (pmErr) {
                            console.error('Error retrieving payment method for downgrade:', pmErr.message);
                        }

                        const subCreateParams = {
                            customer: sub.stripeCustomerId,
                            items: [{
                                price_data: {
                                    currency: 'usd',
                                    product_data: {
                                        name: downgradeQuote.targetPlanName,
                                        description: `${downgradeQuote.targetPlanName} - ${formatUsdMinorExact(downgradeQuote.targetUnitAmountMinor)}/month${downgradeQuote.founderRateApplied ? ' at the locked founder rate' : ''}. Cancel anytime.`,
                                    },
                                    unit_amount: downgradeQuote.targetUnitAmountMinor,
                                    recurring: { interval: 'month' },
                                },
                                quantity: 1,
                            }],
                            metadata: {
                                sellerId: sub.seller.toString(),
                                plan: 'starter',
                                founderCouponCode: downgradeQuote.founderRateApplied
                                    ? downgradeQuote.founderOfferCode
                                    : '',
                                transitionFromSubscriptionId: subscription.id,
                                transitionEventId,
                                downgradeOperationKey: downgradeQuote.operationKey,
                                targetUnitAmountMinor: String(downgradeQuote.targetUnitAmountMinor),
                                targetCurrency: downgradeQuote.targetCurrency,
                                founderRateApplied: String(downgradeQuote.founderRateApplied),
                            },
                            payment_behavior: 'default_incomplete', // Don't block if charge fails
                        };

                        if (defaultPaymentMethod) {
                            subCreateParams.default_payment_method = defaultPaymentMethod;
                        }

                        const newSubscription = await stripe.subscriptions.create(subCreateParams, {
                            // Stable across Stripe retries and even distinct
                            // deletion events for the same ended subscription.
                            idempotencyKey: `rozare-downgrade-${sub._id}-${subscription.id}`,
                        });
                        const createdStripeSubscription = await retrievePlanChangeStripeSubscription(newSubscription.id);
                        if (
                            String(createdStripeSubscription?.id || '') !== String(newSubscription.id)
                            || stripeObjectId(createdStripeSubscription?.customer) !== String(sub.stripeCustomerId)
                            || createdStripeSubscription?.pending_update
                            || String(createdStripeSubscription?.collection_method || '') !== 'charge_automatically'
                            || createdStripeSubscription?.pause_collection
                            || createdStripeSubscription?.cancel_at_period_end
                        ) {
                            const mismatchError = new Error('Stripe returned a replacement Starter subscription with mismatched ownership or billing controls.');
                            mismatchError.code = 'DOWNGRADE_SUBSCRIPTION_MISMATCH';
                            throw mismatchError;
                        }
                        const createdStarterItem = exactStripeSubscriptionItem(createdStripeSubscription, {
                            expectedUnitAmount: downgradeQuote.targetUnitAmountMinor,
                        });
                        if (!createdStarterItem.ok) {
                            const mismatchError = new Error(`Stripe returned a non-exact replacement Starter item: ${createdStarterItem.reason}`);
                            mismatchError.code = 'DOWNGRADE_SUBSCRIPTION_MISMATCH';
                            throw mismatchError;
                        }
                        // No trial is requested for this replacement. Only
                        // Stripe's `active` result proves the first Starter
                        // invoice completed; missing/trialing/incomplete states
                        // remain blocked until invoice.payment_succeeded.
                        const newSubscriptionPaid = createdStripeSubscription.status === 'active';
                        const createdStarterPeriod = newSubscriptionPaid
                            ? exactStripeSubscriptionBillingPeriod(createdStripeSubscription)
                            : null;

                        // Update local subscription to Starter
                        sub.status = newSubscriptionPaid ? 'active' : 'past_due';
                        sub.plan = 'starter';
                        sub.planName = downgradeQuote.targetPlanName;
                        sub.metaAdsIncluded = false;
                        resetSubscriptionInvoiceOrdering(sub);
                        sub.stripeSubscriptionId = newSubscription.id;
                        sub.stripeProductId = createdStarterItem.productId;
                        sub.stripePriceId = createdStarterItem.priceId;
                        terminalizePlanChangeForSubscriptionReplacement(
                            sub,
                            subscription.id,
                            newSubscription.id,
                        );
                        if (newSubscriptionPaid) {
                            sub.subscribedAt = createdStarterPeriod.subscriptionStartedAt;
                            sub.currentPeriodStart = createdStarterPeriod.currentPeriodStart;
                            sub.currentPeriodEnd = createdStarterPeriod.currentPeriodEnd;
                            sub.freePeriodEndDate = null;
                            sub.paymentRisk.suspended = false;
                            sub.paymentRisk.reason = '';
                            sub.paymentRisk.previousStatus = null;
                            sub.paymentRisk.stripeSubscriptionId = '';
                            sub.paymentRisk.updatedAt = now;
                        } else {
                            sub.paymentRisk.suspended = true;
                            sub.paymentRisk.reason = 'Stripe has not completed the first Starter payment.';
                            sub.paymentRisk.previousStatus = 'active';
                            sub.paymentRisk.stripeSubscriptionId = newSubscription.id;
                            sub.paymentRisk.updatedAt = now;
                            sub.blockedAt = now;
                            sub.blockedReason = `Stripe payment risk: ${sub.paymentRisk.reason}`;
                        }
                        sub.cancelledAt = null;
                        sub.pendingDowngrade = {
                            toPlan: null,
                            scheduledAt: null,
                            activationPending: !newSubscriptionPaid,
                        };
                        sub.pendingStoreSync = {
                            kind: newSubscriptionPaid ? 'downgrade_activation' : 'downgrade_block',
                            eventId: transitionEventId,
                            stripeSubscriptionId: newSubscription.id,
                            previousStripeSubscriptionId: subscription.id,
                            blockedAt: newSubscriptionPaid ? null : now,
                        };
                        sub.warningEmailSent = false;

                        // An incomplete Stripe creation has not funded Starter
                        // access yet. Defer the one-time six-month clock until
                        // invoice.payment_succeeded confirms real payment.
                        if (newSubscriptionPaid) {
                            activateStarterBonusForPaidDowngrade(
                                sub,
                                createdStarterPeriod.subscriptionStartedAt,
                            );
                            sub.activationNotification = {
                                kind: 'automatic_downgrade',
                                sourceReference: subscription.id,
                                stripeSubscriptionId: newSubscription.id,
                                occurredAt: now,
                                planName: sub.planName,
                                recurringAmountMinor: createdStarterItem.unitAmount,
                                currency: 'USD',
                                freePeriodDays: 0,
                                freePeriodEndDate: null,
                                notificationEnqueuedAt: null,
                                completedAt: null,
                            };
                        } else {
                            sub.bonusFeaturesActive = false;
                            sub.bonusExpiryDate = null;
                            sub.bonusGraceDeadline = null;
                            sub.bonusFeaturesExpiredPermanently = Boolean(sub.starterBonusPeriodUsed);
                        }

                        await sub.save();

                        await synchronizePendingSubscriptionStore(sub);

                        if (!newSubscriptionPaid) {
                            // The first invoice webhook was made retryable while
                            // this transition was unbound. Its retry now owns the
                            // authoritative recovery/blocking transition.
                            break;
                        }

                        await finalizeSubscriptionActivationNotification(sub, subscription.id);

                        break;
                    } catch (downgradeErr) {
                        console.error('Auto-downgrade to Starter failed:', downgradeErr);
                        await SellerSubscription.updateOne(
                            {
                                _id: sub._id,
                                stripeSubscriptionId: subscription.id,
                                'pendingDowngrade.processingToken': transitionToken,
                            },
                            {
                                $set: {
                                    'pendingDowngrade.processingToken': null,
                                    'pendingDowngrade.processingEventId': null,
                                    'pendingDowngrade.processingStartedAt': null,
                                },
                            }
                        ).catch(releaseError => {
                            console.error('Failed to release downgrade transition claim:', releaseError.message);
                        });
                        // Stripe must retry a failed paid-plan transition. Falling
                        // through would incorrectly block a seller who requested
                        // a downgrade rather than a cancellation.
                        throw downgradeErr;
                    }
                }

                // Regular cancellation. The ended Stripe subscription owns one
                // immutable timeline. Replays resume any unfinished projection
                // and outbox enqueue without extending grace/removal deadlines.
                sub = await claimOrdinarySubscriptionCancellation({
                    subscription: sub,
                    eventId: event.id,
                    now,
                });
                if (!sub) break;
                sub = await synchronizeOrdinarySubscriptionCancellation(sub);
                await finalizeOrdinarySubscriptionCancellation(sub);

                break;
            }

            case 'invoice.payment_action_required': {
                const result = await reconcilePlanChangePaymentActionRequired(event.data.object);
                if (result.notificationIntent) {
                    await ensurePlanChangeActionNotificationOutboxed(
                        result.notificationIntent.subscriptionId,
                        result.notificationIntent.attemptToken,
                        result.notificationIntent.invoiceId
                    );
                }
                break;
            }

            case 'invoice.payment_failed': {
                const invoice = event.data.object;
                await bindIncomingPlanChangeInvoiceIfExact(invoice);
                const result = await recordSubscriptionInvoiceFailure({
                    invoice,
                    eventId: event.id,
                    eventCreated: event.created,
                });
                if (!result.handled || result.stale) break;
                if (result.notificationIntent?.kind === 'failed') {
                    await ensurePaymentFailureNotificationOutboxed(
                        result.notificationIntent.subscriptionId,
                        result.notificationIntent.invoiceId
                    );
                }
                break;
            }

            case 'invoice.paid':
            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                await bindIncomingPlanChangeInvoiceIfExact(invoice);
                const result = await recordSubscriptionInvoicePayment({
                    invoice,
                    eventId: event.id,
                    eventCreated: event.created,
                });
                if (!result.handled || result.stale) break;
                let sub = result.subscription;

                if (
                    invoice.billing_reason === 'subscription_update'
                    && (!result.zeroAmount || result.planChangeAuthorized)
                    && ['processing', 'pending_payment', 'recoverable'].includes(sub.planChangeAttempt?.state)
                ) {
                    const stripeSubscription = await retrievePlanChangeStripeSubscription(sub.stripeSubscriptionId);
                    const convergence = await convergePaidPlanChange({
                        subscription: sub,
                        stripeSubscription,
                        paidInvoice: invoice,
                        invoiceAlreadyRecorded: true,
                        eventId: event.id,
                        eventCreated: event.created,
                    });
                    if (convergence.subscription) sub = convergence.subscription;
                }

                const recoveredFailureInvoiceId = String(
                    result.payment?.recoveryNotification?.failureInvoiceId || ''
                );
                if (
                    result.payment?.paymentNotification?.kind === 'recovered'
                    && recoveredFailureInvoiceId
                ) {
                    await Notification.deleteOne({
                        user: sub.seller,
                        dedupeKey: `subscription-payment-failed:${String(sub._id)}:${String(recoveredFailureInvoiceId)}`,
                    });
                    await Notification.deleteMany({
                        user: sub.seller,
                        eventType: 'subscription.payment_failed',
                        aggregateId: String(sub._id),
                    });
                }

                // Zero-due plan-change invoices can apply an exact Stripe
                // Price but never create recurring paid-cycle coverage or run
                // ordinary renewal/downgrade side effects.
                if (result.zeroAmount) break;

                if (
                    sub.status === 'active'
                    && sub.plan === 'starter'
                    && sub.pendingDowngrade?.activationPending
                ) {
                    activateStarterBonusForPaidDowngrade(
                        sub,
                        sub.currentPeriodStart || new Date(),
                    );
                    sub.pendingDowngrade.activationPending = false;
                    await sub.save();
                }

                if (result.created && sub.status === 'active' && invoice.billing_reason === 'subscription_cycle') {
                    // The service already persisted Stripe's authoritative
                    // period. Only reset the warning marker for the new cycle.
                    sub.warningEmailSent = false; // reset for next cycle
                    await sub.save();
                }
                break;
            }
        }
    } catch (error) {
        console.error('Subscription webhook error:', error);
        throw error;
    }
};

// Cancel subscription
exports.cancelSubscription = async (req, res) => {
    try {
        const sellerId = req.user.id;
        let sub = await SellerSubscription.findOne({ seller: sellerId });

        if (!sub || !sub.stripeSubscriptionId) {
            return res.status(400).json({ msg: 'No active subscription found' });
        }
        if (!stripe) {
            return res.status(500).json({ msg: 'Payment system not configured' });
        }

        const resumingCancellation = Boolean(sub.cancelledAt);
        const cancellationRequestedAt = sub.cancelledAt || new Date();
        if (!resumingCancellation) {
            sub = await SellerSubscription.findOneAndUpdate({
                _id: sub._id,
                stripeSubscriptionId: sub.stripeSubscriptionId,
                $or: [
                    { cancelledAt: null },
                    { cancelledAt: { $exists: false } },
                ],
            }, {
                $set: { cancelledAt: cancellationRequestedAt },
            }, { new: true });
            if (!sub) {
                return res.status(409).json({
                    code: 'SUBSCRIPTION_CANCELLATION_PENDING',
                    msg: 'Another cancellation request is being persisted. Retry safely.',
                });
            }
        }

        // Cancel at period end
        let stripeCancellationScheduled = false;
        try {
            await stripe.subscriptions.update(sub.stripeSubscriptionId, {
                cancel_at_period_end: true,
            }, {
                idempotencyKey: `rozare-cancel-${sub._id}-${new Date(cancellationRequestedAt).getTime()}`,
            });
            stripeCancellationScheduled = true;
        } catch (error) {
            if (
                !stripeCancellationScheduled
                && !resumingCancellation
                && isDefinitiveStripeMutationRejection(error)
            ) {
                await SellerSubscription.updateOne({
                    _id: sub._id,
                    stripeSubscriptionId: sub.stripeSubscriptionId,
                    cancelledAt: cancellationRequestedAt,
                }, { $set: { cancelledAt: null } });
            }
            throw error;
        }
        // Close the narrow race where a plan-change request passed its first
        // preflight just before cancellation reached Stripe.
        sub = await supersedeActivePlanChange(
            sub,
            'The seller cancelled the subscription before this plan change completed.',
        );

        // Determine if bonus features are still active (for the warning message)
        const now = new Date();
        const hasBonusAtRisk = sub.plan === 'starter' && sub.bonusFeaturesActive && !sub.bonusFeaturesExpiredPermanently && sub.bonusExpiryDate && now < sub.bonusExpiryDate;
        const bonusDaysRemaining = hasBonusAtRisk ? Math.ceil((sub.bonusExpiryDate - now) / (1000 * 60 * 60 * 24)) : 0;

        res.json({
            msg: 'Subscription will be cancelled at the end of the current period.',
            reused: resumingCancellation,
            founderWarning: sub.founderOffer?.active
                ? 'Your locked FIRST100 founder rate will be permanently forfeited when this subscription ends.'
                : null,
            bonusWarning: hasBonusAtRisk ? {
                message: 'Once your subscription period ends, you will have 3 days to re-subscribe and keep your bonus features. After 3 days, bonus features will be permanently removed from the Starter plan.',
                bonusDaysRemaining,
            } : null,
        });
    } catch (error) {
        console.error('Cancel subscription error:', error);
        res.status(500).json({ msg: 'Failed to cancel subscription' });
    }
};

// Upgrade from Starter to Elite (swap Stripe subscription)
exports.upgradeToElite = async (req, res) => {
    let attempt = null;
    let localPlanApplied = false;
    try {
        const sellerId = req.user.id;
        if (
            req.body?.includeMetaAds !== undefined
            && typeof req.body.includeMetaAds !== 'boolean'
        ) {
            return res.status(400).json({ msg: 'includeMetaAds must be a boolean.' });
        }
        const includeMetaAdsRequested = req.body?.includeMetaAds === true;
        let sub = await SellerSubscription.findOne({ seller: sellerId });

        if (!sub) {
            return res.status(400).json({ msg: 'No subscription found' });
        }

        if (sub.cancelledAt || sub.pendingDowngrade?.toPlan) {
            return res.status(409).json({
                code: 'PLAN_CHANGE_BLOCKED_BY_CANCELLATION',
                msg: sub.pendingDowngrade?.toPlan
                    ? 'Cancel the scheduled downgrade before changing the current plan.'
                    : 'This subscription is scheduled to end. Start or resume a subscription before changing its plan.',
            });
        }

        const attemptBeforeReconciliation = activePlanChangeStates.includes(sub.planChangeAttempt?.state)
            ? {
                token: sub.planChangeAttempt.idempotencyToken,
                invoiceId: sub.planChangeAttempt.stripeInvoiceId,
            }
            : null;
        sub = await reconcileExistingPendingPlanChange(sub);
        if (
            attemptBeforeReconciliation?.token
            && sub.planChangeAttempt?.idempotencyToken === attemptBeforeReconciliation.token
            && sub.planChangeAttempt?.state === null
        ) {
            return res.status(409).json({
                code: sub.planChangeAttempt?.lastError?.includes('expired')
                    ? 'PLAN_CHANGE_EXPIRED'
                    : 'PLAN_CHANGE_SUPERSEDED',
                msg: `${sub.planChangeAttempt?.lastError || 'Stripe superseded this plan change.'} No local features were changed; retry after Stripe no longer reports the old generation.`,
                invoiceId: attemptBeforeReconciliation.invoiceId || null,
            });
        }

        const isStarterUpgrade = sub.plan === 'starter';
        const isElitePlanUpdate = sub.plan === 'elite';
        const isMetaAdsRemoval = isElitePlanUpdate
            && Boolean(sub.metaAdsIncluded)
            && !includeMetaAdsRequested;
        const changeKind = isStarterUpgrade
            ? 'upgrade'
            : isMetaAdsRemoval ? 'meta_removal' : 'meta_addition';

        const {
            includeMetaAds,
            planName,
            unitAmount,
        } = buildPlanPricing(
            'elite',
            includeMetaAdsRequested,
            Boolean(sub.founderOffer?.active)
        );
        const target = {
            changeKind,
            plan: 'elite',
            includeMetaAds,
            planName,
            unitAmount,
        };
        if (
            sub.planChangeAttempt?.state === 'applied'
            && sub.planChangeAttempt?.targetPlan === target.plan
            && sub.planChangeAttempt?.targetPlanName === target.planName
            && Boolean(sub.planChangeAttempt?.targetIncludeMetaAds) === Boolean(target.includeMetaAds)
            && Number.isSafeInteger(sub.planChangeAttempt?.targetUnitAmountMinor)
            && sub.planChangeAttempt.targetUnitAmountMinor === target.unitAmount
        ) {
            await ensurePlanChangeCompletionNotificationOutboxed(sub._id, sub.planChangeAttempt.idempotencyToken);
            sub = await SellerSubscription.findById(sub._id);
            return res.json({
                msg: 'This Rozare Elite plan change was already completed.',
                reused: true,
                subscription: publicPlanChangeSubscription(sub),
            });
        }
        // Applied retries above remain idempotent even if a later entitlement
        // recomputation suspended the subscription. New mutations still require
        // an active Starter or Elite billing state.
        if (!['active', 'free_period'].includes(sub.status) || (!isStarterUpgrade && !isElitePlanUpdate)) {
            return res.status(400).json({ msg: 'You can only update an active Starter or Elite plan.' });
        }
        const requestFingerprint = planChangeFingerprint(sub, target);
        if (
            sub.planChangeAttempt?.state === 'applied'
            && sub.planChangeAttempt?.requestFingerprint === requestFingerprint
        ) {
            await ensurePlanChangeCompletionNotificationOutboxed(sub._id, sub.planChangeAttempt.idempotencyToken);
            sub = await SellerSubscription.findById(sub._id);
            return res.json({
                msg: 'This Rozare Elite plan change was already completed.',
                reused: true,
                subscription: {
                    plan: sub.plan,
                    planName: sub.planName,
                    metaAdsIncluded: sub.metaAdsIncluded,
                    bonusFeaturesActive: sub.bonusFeaturesActive,
                    bonusExpiryDate: sub.bonusExpiryDate,
                    founderOffer: {
                        active: Boolean(sub.founderOffer?.active),
                        code: sub.founderOffer?.code || null,
                    },
                },
            });
        }
        if (isElitePlanUpdate && Boolean(sub.metaAdsIncluded) === includeMetaAdsRequested) {
            return res.status(400).json({
                msg: includeMetaAdsRequested
                    ? 'Meta ads are already included in your Elite plan.'
                    : 'Meta ads are already removed from your Elite plan.',
            });
        }

        if (!sub.stripeSubscriptionId) {
            return res.status(400).json({ msg: 'No active Stripe subscription found.' });
        }

        if (!stripe) {
            return res.status(500).json({ msg: 'Payment system not configured' });
        }

        if (sub.status === 'free_period' && !isMetaAdsRemoval) {
            return res.status(409).json({
                code: 'PLAN_CHANGE_PAYMENT_REQUIRED',
                msg: 'Paid Elite or Meta Ads access can be added after the introductory free period has ended.',
            });
        }

        const claim = await claimPlanChangeAttempt(sub, requestFingerprint, target);
        if (claim.applied) {
            sub = claim.subscription;
            await ensurePlanChangeCompletionNotificationOutboxed(sub._id, sub.planChangeAttempt.idempotencyToken);
            sub = await SellerSubscription.findById(sub._id);
            return res.json({
                msg: 'This Rozare Elite plan change was already completed.',
                reused: true,
                subscription: {
                    plan: sub.plan,
                    planName: sub.planName,
                    metaAdsIncluded: sub.metaAdsIncluded,
                    bonusFeaturesActive: sub.bonusFeaturesActive,
                    bonusExpiryDate: sub.bonusExpiryDate,
                },
            });
        }
        if (claim.pending) {
            return res.status(409).json({
                code: claim.code || 'PLAN_CHANGE_PENDING',
                msg: claim.msg || 'This subscription change is already being processed. Please retry shortly.',
                ...(claim.retryAfterSeconds
                    ? { retryAfterSeconds: claim.retryAfterSeconds }
                    : {}),
            });
        }
        attempt = claim;
        sub = claim.subscription;

        // Prove the exact predecessor before creating a target Price or mutating
        // Stripe. This rejects legacy multi-item, discounted, paused, manual-
        // collection, stale-Price, and cancellation-in-progress subscriptions.
        let stripeSubscription = await retrievePlanChangeStripeSubscription(sub.stripeSubscriptionId);
        if (
            String(stripeSubscription?.id || '') !== String(sub.stripeSubscriptionId)
            || stripeObjectId(stripeSubscription?.customer) !== String(sub.stripeCustomerId)
        ) {
            await clearDefinitivePlanChangeAttempt(sub._id, attempt, new Error('Stripe subscription ownership mismatch.'));
            return res.status(409).json({
                code: 'PLAN_CHANGE_OWNERSHIP_MISMATCH',
                msg: 'Stripe returned a subscription that does not belong to this seller. No local features were changed.',
            });
        }
        const sourcePricing = buildPlanPricing(
            sub.plan,
            Boolean(sub.metaAdsIncluded),
            Boolean(sub.founderOffer?.active),
        );
        const sourceAuthority = exactStripePlanChangeSource(stripeSubscription, {
            expectedItemId: sub.planChangeAttempt?.stripeSubscriptionItemId || null,
            expectedPriceId: sub.planChangeAttempt?.sourceStripePriceId || sub.stripePriceId || null,
            expectedProductId: sub.planChangeAttempt?.sourceStripeProductId || sub.stripeProductId || null,
            expectedUnitAmount: sourcePricing.unitAmount,
        });
        if (!sourceAuthority.ok) {
            await clearDefinitivePlanChangeAttempt(sub._id, attempt, new Error(sourceAuthority.reason));
            return res.status(409).json({
                code: 'PLAN_CHANGE_SOURCE_MISMATCH',
                msg: `${sourceAuthority.reason} No Stripe plan update was created.`,
            });
        }
        const subscriptionItemId = sourceAuthority.itemId;
        await bindPlanChangeSourceSnapshot(sub, attempt, sourceAuthority);

        if (
            stripeSubscription.pending_update
            && (
                !sub.planChangeAttempt?.stripePriceId
                || !sub.planChangeAttempt?.stripeProductId
                || !pendingUpdateMatchesTarget(stripeSubscription, {
                    priceId: sub.planChangeAttempt.stripePriceId,
                    subscriptionItemId,
                    invoiceId: sub.planChangeAttempt.stripeInvoiceId,
                })
            )
        ) {
            await clearTerminalPlanChangeAttempt(
                sub._id,
                attempt.idempotencyToken,
                'Stripe already has a different pending subscription update.',
            );
            return res.status(409).json({
                code: 'PLAN_CHANGE_SUPERSEDED',
                msg: 'Stripe already has a different pending subscription update. No Product, Price, or local feature change was created.',
            });
        }

        const targetPriceId = await ensureDurablePlanChangePrice(
            sub,
            attempt,
            target,
            subscriptionItemId,
        );
        const targetProductId = sub.planChangeAttempt.stripeProductId;

        let updatedSubscription = stripeSubscription;
        if (isMetaAdsRemoval) {
            const alreadyApplied = await stripePlanChangeIsAuthoritative(stripeSubscription, {
                expectedSubscriptionId: sub.stripeSubscriptionId,
                expectedCustomerId: sub.stripeCustomerId,
                expectedUnitAmount: unitAmount,
                expectedPriceId: targetPriceId,
                expectedProductId: targetProductId,
                expectedSubscriptionItemId: subscriptionItemId,
                allowUnpaidRemoval: true,
            });
            if (!alreadyApplied.ok) {
                await assertPlanChangeClaimActive(sub._id, attempt);
                updatedSubscription = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
                    items: [{
                        id: subscriptionItemId,
                        price: targetPriceId,
                        quantity: 1,
                    }],
                    proration_behavior: 'create_prorations',
                    expand: PLAN_CHANGE_STRIPE_EXPAND,
                }, {
                    idempotencyKey: `rozare-plan-change-${sub._id}-${attempt.idempotencyToken}`,
                });
                if (!(await planChangeClaimIsActive(sub._id, attempt))) {
                    const loss = await compensateLostPlanChangeClaim({
                        subscription: sub,
                        attempt,
                        stripeSubscription: updatedSubscription,
                    });
                    if (loss.applied) {
                        localPlanApplied = true;
                        sub = loss.subscription;
                        return res.json({
                            msg: 'Stripe completed the exact plan change before cancellation or downgrade superseded the request. The paid/local state was reconciled without resuming the cancellation.',
                            subscription: publicPlanChangeSubscription(sub),
                            cancellationScheduled: Boolean(sub.cancelledAt),
                        });
                    }
                    const supersededError = new Error(loss.compensated
                        ? 'Cancellation or downgrade superseded this plan change and its unpaid invoice was voided.'
                        : 'Cancellation or downgrade superseded this plan change before its Stripe outcome could be safely applied.');
                    supersededError.code = 'PLAN_CHANGE_SUPERSEDED';
                    throw supersededError;
                }
            }
            const removalAuthority = await stripePlanChangeIsAuthoritative(updatedSubscription, {
                expectedSubscriptionId: sub.stripeSubscriptionId,
                expectedCustomerId: sub.stripeCustomerId,
                expectedUnitAmount: unitAmount,
                expectedPriceId: targetPriceId,
                expectedProductId: targetProductId,
                expectedSubscriptionItemId: subscriptionItemId,
                allowUnpaidRemoval: true,
            });
            if (!removalAuthority.ok) {
                const pendingError = new Error(removalAuthority.reason);
                pendingError.code = 'PLAN_CHANGE_FAILED';
                await markPlanChangeRecoverable(sub._id, attempt, pendingError);
                return res.status(409).json({
                    code: pendingError.code,
                    msg: `${removalAuthority.reason} No local plan features were changed.`,
                });
            }
            const applied = await applyLocalPlanChange(sub._id, attempt.idempotencyToken, null);
            if (!applied.applied) {
                const supersededError = new Error('The durable Meta Ads removal was superseded before local application.');
                supersededError.code = 'PLAN_CHANGE_SUPERSEDED';
                throw supersededError;
            }
            localPlanApplied = true;
            await ensurePlanChangeCompletionNotificationOutboxed(sub._id, attempt.idempotencyToken);
            sub = await SellerSubscription.findById(sub._id);
        } else {
            if (stripeSubscription.pending_update) {
                if (!pendingUpdateMatchesTarget(stripeSubscription, {
                    priceId: targetPriceId,
                    subscriptionItemId,
                    invoiceId: sub.planChangeAttempt?.stripeInvoiceId,
                })) {
                    await clearTerminalPlanChangeAttempt(
                        sub._id,
                        attempt.idempotencyToken,
                        'Stripe replaced this plan change with a different pending update.',
                    );
                    return res.status(409).json({
                        code: 'PLAN_CHANGE_SUPERSEDED',
                        msg: 'A different Stripe subscription update replaced this request. No local features were changed; retry your intended plan change.',
                    });
                }
                const exactPendingInvoice = await exactPendingPlanChangeInvoice(
                    stripeSubscription,
                    sub,
                    sub.planChangeAttempt,
                );
                if (!exactPendingInvoice.ok) {
                    await clearTerminalPlanChangeAttempt(sub._id, attempt.idempotencyToken, exactPendingInvoice.reason);
                    return res.status(409).json({
                        code: 'PLAN_CHANGE_SUPERSEDED',
                        msg: `${exactPendingInvoice.reason} No local features were changed.`,
                    });
                }
                const bound = await bindPlanChangeInvoice(
                    sub._id,
                    attempt.idempotencyToken,
                    exactPendingInvoice.invoiceId,
                    stripePendingUpdateExpiryDate(stripeSubscription.pending_update.expires_at),
                );
                if (!bound) {
                    await clearTerminalPlanChangeAttempt(
                        sub._id,
                        attempt.idempotencyToken,
                        'A different Stripe invoice already owns this plan-change attempt.',
                    );
                    return res.status(409).json({
                        code: 'PLAN_CHANGE_SUPERSEDED',
                        msg: 'A different Stripe invoice already owns this plan change. No local features were changed.',
                    });
                }
                await markPlanChangePendingPayment(sub._id, attempt, {
                    invoiceId: exactPendingInvoice.invoiceId,
                    expiresAt: stripePendingUpdateExpiryDate(stripeSubscription.pending_update.expires_at),
                });
                return await respondPendingPlanChange(res, stripeSubscription);
            }

            const expiredPendingAttempt = claim.resumed
                && claim.previousState === 'pending_payment'
                && sub.planChangeAttempt?.pendingUpdateExpiresAt
                && sub.planChangeAttempt.pendingUpdateExpiresAt <= new Date()
                && stripeObjectId(stripeSubscription.items?.data?.[0]?.price) !== targetPriceId;
            if (expiredPendingAttempt) {
                await clearTerminalPlanChangeAttempt(
                    sub._id,
                    attempt.idempotencyToken,
                    'Stripe expired the unpaid pending plan update.',
                );
                return res.status(409).json({
                    code: 'PLAN_CHANGE_EXPIRED',
                    msg: 'The unpaid Stripe plan change expired. No local features were changed; retry to start a fresh payment attempt.',
                });
            }

            const currentAuthority = await stripePlanChangeIsAuthoritative(stripeSubscription, {
                expectedSubscriptionId: sub.stripeSubscriptionId,
                expectedCustomerId: sub.stripeCustomerId,
                expectedUnitAmount: unitAmount,
                expectedPriceId: targetPriceId,
                expectedProductId: targetProductId,
                expectedSubscriptionItemId: subscriptionItemId,
                expectedInvoiceId: sub.planChangeAttempt?.stripeInvoiceId,
                expectedSourcePriceId: sub.planChangeAttempt?.sourceStripePriceId,
                expectedSourceProductId: sub.planChangeAttempt?.sourceStripeProductId,
                expectedSourceUnitAmount: sub.planChangeAttempt?.sourceUnitAmountMinor,
            });
            if (!currentAuthority.ok) {
                await assertPlanChangeClaimActive(sub._id, attempt);
                updatedSubscription = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
                    items: [{ id: subscriptionItemId, price: targetPriceId, quantity: 1 }],
                    proration_behavior: 'always_invoice',
                    payment_behavior: 'pending_if_incomplete',
                    expand: PLAN_CHANGE_STRIPE_EXPAND,
                }, {
                    idempotencyKey: `rozare-plan-change-${sub._id}-${attempt.idempotencyToken}`,
                });
                if (!(await planChangeClaimIsActive(sub._id, attempt))) {
                    const webhookReconciled = await loadConcurrentlyReconciledPendingPlanChange(
                        sub._id,
                        attempt,
                        updatedSubscription,
                    );
                    if (webhookReconciled) {
                        sub = webhookReconciled;
                    } else {
                        const loss = await compensateLostPlanChangeClaim({
                            subscription: sub,
                            attempt,
                            stripeSubscription: updatedSubscription,
                        });
                        if (loss.applied) {
                            localPlanApplied = true;
                            sub = loss.subscription;
                            return res.json({
                                msg: 'Stripe paid the exact plan change before cancellation or downgrade superseded the request. Entitlements were reconciled without resuming the cancellation.',
                                subscription: publicPlanChangeSubscription(sub),
                                cancellationScheduled: Boolean(sub.cancelledAt),
                            });
                        }
                        const supersededError = new Error(loss.compensated
                            ? 'Cancellation or downgrade superseded this plan change and its unpaid invoice was voided.'
                            : 'Cancellation or downgrade superseded this plan change before its Stripe outcome could be safely applied.');
                        supersededError.code = 'PLAN_CHANGE_SUPERSEDED';
                        throw supersededError;
                    }
                }
            }

            if (updatedSubscription.pending_update) {
                if (!pendingUpdateMatchesTarget(updatedSubscription, {
                    priceId: targetPriceId,
                    subscriptionItemId,
                })) {
                    await clearTerminalPlanChangeAttempt(
                        sub._id,
                        attempt.idempotencyToken,
                        'Stripe returned a different pending update than the requested Price.',
                    );
                    return res.status(409).json({
                        code: 'PLAN_CHANGE_SUPERSEDED',
                        msg: 'Stripe returned a different pending subscription update. No local features were changed.',
                    });
                }
                const exactPendingInvoice = await exactPendingPlanChangeInvoice(
                    updatedSubscription,
                    sub,
                    sub.planChangeAttempt,
                );
                if (!exactPendingInvoice.ok) {
                    await clearTerminalPlanChangeAttempt(sub._id, attempt.idempotencyToken, exactPendingInvoice.reason);
                    return res.status(409).json({
                        code: 'PLAN_CHANGE_SUPERSEDED',
                        msg: `${exactPendingInvoice.reason} No local features were changed.`,
                    });
                }
                const bound = await bindPlanChangeInvoice(
                    sub._id,
                    attempt.idempotencyToken,
                    exactPendingInvoice.invoiceId,
                    stripePendingUpdateExpiryDate(updatedSubscription.pending_update.expires_at),
                );
                if (!bound) {
                    await clearTerminalPlanChangeAttempt(
                        sub._id,
                        attempt.idempotencyToken,
                        'A different Stripe invoice already owns this plan-change attempt.',
                    );
                    return res.status(409).json({
                        code: 'PLAN_CHANGE_SUPERSEDED',
                        msg: 'A different Stripe invoice already owns this plan change. No local features were changed.',
                    });
                }
                await markPlanChangePendingPayment(sub._id, attempt, {
                    invoiceId: exactPendingInvoice.invoiceId,
                    expiresAt: stripePendingUpdateExpiryDate(updatedSubscription.pending_update.expires_at),
                });
                return await respondPendingPlanChange(res, updatedSubscription);
            }

            const convergence = await convergePaidPlanChange({
                subscription: sub,
                stripeSubscription: updatedSubscription,
            });
            if (!convergence.applied) {
                const pendingError = new Error(convergence.reason || 'Stripe has not confirmed the paid plan change.');
                pendingError.code = 'PLAN_CHANGE_PAYMENT_REQUIRED';
                await markPlanChangeRecoverable(sub._id, attempt, pendingError);
                return res.status(409).json({
                    code: pendingError.code,
                    msg: `${pendingError.message} No local plan features were changed.`,
                });
            }
            sub = convergence.subscription;
            localPlanApplied = true;
        }

        res.json({
            msg: isElitePlanUpdate
                ? 'Rozare Elite plan updated successfully.'
                : 'Successfully upgraded to Rozare Elite! Bonus features are now permanently included.',
            subscription: {
                plan: sub.plan,
                planName: sub.planName,
                metaAdsIncluded: sub.metaAdsIncluded,
                bonusFeaturesActive: sub.bonusFeaturesActive,
                bonusExpiryDate: sub.bonusExpiryDate,
                founderOffer: {
                    active: Boolean(sub.founderOffer?.active),
                    code: sub.founderOffer?.code || null,
                },
            },
        });
    } catch (error) {
        console.error('Upgrade to Elite error:', error);
        if (attempt && !localPlanApplied) {
            if (isDefinitiveStripeCreationError(error)) {
                await clearDefinitivePlanChangeAttempt(attempt.subscription._id, attempt, error)
                    .catch(markError => console.error('Failed to clear declined plan-change attempt:', markError.message));
            } else {
                await markPlanChangeRecoverable(attempt.subscription._id, attempt, error)
                    .catch(markError => console.error('Failed to preserve recoverable plan-change attempt:', markError.message));
            }
        }
        const paymentIntent = error?.payment_intent || error?.raw?.payment_intent;
        if (paymentIntent?.status === 'requires_action') {
            if (!paymentIntent.client_secret) {
                return res.status(409).json({
                    code: 'PLAN_CHANGE_ACTION_UNAVAILABLE',
                    msg: 'Stripe requires payment authentication but did not return a usable PaymentIntent secret. No local plan features were changed.',
                    actionRequired: false,
                });
            }
            return res.status(409).json({
                code: 'PLAN_CHANGE_ACTION_REQUIRED',
                msg: 'Stripe requires payment authentication. No local plan features were changed.',
                actionRequired: true,
                clientSecret: paymentIntent.client_secret,
            });
        }
        if ([
            'PLAN_CHANGE_SUPERSEDED',
            'PLAN_CHANGE_CLAIM_LOST',
            'PLAN_CHANGE_SOURCE_CHANGED',
        ].includes(error?.code)) {
            return res.status(409).json({
                code: 'PLAN_CHANGE_SUPERSEDED',
                msg: `${error.message} No local plan features were changed.`,
            });
        }
        if (Number(error?.statusCode) === 402 || error?.type === 'StripeCardError') {
            return res.status(402).json({
                code: 'PLAN_CHANGE_PAYMENT_REQUIRED',
                msg: 'Stripe could not complete the plan-change payment. No local plan features were changed.',
            });
        }
        res.status(503).json({
            code: attempt ? 'PLAN_CHANGE_RECOVERY_PENDING' : 'PLAN_CHANGE_FAILED',
            msg: 'The plan change could not be confirmed. No new features were granted; retry safely.',
        });
    }
};

// Downgrade from Elite to Starter (Starter starts after Elite period ends)
exports.downgradeToStarter = async (req, res) => {
    try {
        const sellerId = req.user.id;
        let sub = await SellerSubscription.findOne({ seller: sellerId });

        if (!sub) {
            return res.status(400).json({ msg: 'No subscription found' });
        }

        // Must be on an active Elite plan
        if (!['active', 'free_period'].includes(sub.status) || sub.plan !== 'elite') {
            return res.status(400).json({ msg: 'You can only downgrade from an active Elite plan.' });
        }

        if (!sub.stripeSubscriptionId) {
            return res.status(400).json({ msg: 'No active Stripe subscription found.' });
        }

        let resumingDowngrade = sub.pendingDowngrade?.toPlan === 'starter';

        if (!stripe) {
            return res.status(500).json({ msg: 'Payment system not configured' });
        }

        const scheduledAt = resumingDowngrade
            ? sub.pendingDowngrade?.scheduledAt
            : new Date();
        if (!resumingDowngrade) {
            const frozenQuote = buildPendingDowngradeQuote(sub, { scheduledAt });
            sub = await SellerSubscription.findOneAndUpdate({
                _id: sub._id,
                stripeSubscriptionId: sub.stripeSubscriptionId,
                $or: [
                    { 'pendingDowngrade.toPlan': null },
                    { 'pendingDowngrade.toPlan': { $exists: false } },
                ],
            }, {
                $set: {
                    pendingDowngrade: frozenQuote,
                    cancelledAt: scheduledAt,
                },
            }, { new: true });
            if (!sub) {
                // A concurrent identical request may have won the compare-and-
                // set. Join its durable operation instead of creating another
                // Stripe mutation or another notification generation.
                const concurrent = await SellerSubscription.findOne({ seller: sellerId });
                if (!concurrent || concurrent.pendingDowngrade?.toPlan !== 'starter') {
                    return res.status(409).json({
                        code: 'DOWNGRADE_ALREADY_SCHEDULED',
                        msg: 'Another downgrade request changed this subscription. Refresh and retry.',
                    });
                }
                sub = concurrent;
                resumingDowngrade = true;
            }
        }

        sub = await ensurePendingDowngradeQuoteFrozen(sub);
        const downgradeQuote = requirePendingDowngradeQuote(sub);

        // Cancel Elite at period end (Stripe will fire customer.subscription.deleted)
        let stripeDowngradeScheduled = false;
        try {
            await stripe.subscriptions.update(downgradeQuote.sourceStripeSubscriptionId, {
                cancel_at_period_end: true,
            }, {
                idempotencyKey: `rozare-downgrade-schedule-${sub._id}-${downgradeQuote.operationKey}`,
            });
            stripeDowngradeScheduled = true;
            const stripeScheduledAt = new Date();
            await SellerSubscription.updateOne({
                _id: sub._id,
                stripeSubscriptionId: downgradeQuote.sourceStripeSubscriptionId,
                'pendingDowngrade.toPlan': 'starter',
                'pendingDowngrade.operationKey': downgradeQuote.operationKey,
                $or: [
                    { 'pendingDowngrade.stripeScheduledAt': null },
                    { 'pendingDowngrade.stripeScheduledAt': { $exists: false } },
                ],
            }, {
                $set: { 'pendingDowngrade.stripeScheduledAt': stripeScheduledAt },
            });
            sub = await SellerSubscription.findById(sub._id);
            if (
                !sub
                || sub.pendingDowngrade?.operationKey !== downgradeQuote.operationKey
                || !validPendingDowngradeDate(sub.pendingDowngrade?.stripeScheduledAt)
            ) {
                throw pendingDowngradeError(
                    'The downgrade schedule changed after Stripe confirmed it.',
                    'PENDING_DOWNGRADE_SCHEDULE_CONFLICT'
                );
            }
        } catch (error) {
            if (
                !stripeDowngradeScheduled
                && isDefinitiveStripeMutationRejection(error)
            ) {
                await SellerSubscription.updateOne({
                    _id: sub._id,
                    stripeSubscriptionId: downgradeQuote.sourceStripeSubscriptionId,
                    'pendingDowngrade.toPlan': 'starter',
                    'pendingDowngrade.operationKey': downgradeQuote.operationKey,
                    'pendingDowngrade.stripeScheduledAt': null,
                }, {
                    $set: {
                        pendingDowngrade: { toPlan: null, scheduledAt: null, activationPending: false },
                        cancelledAt: null,
                    },
                });
            }
            throw error;
        }
        sub = await supersedeActivePlanChange(
            sub,
            'The seller scheduled an Elite to Starter downgrade before this plan change completed.',
        );

        // The outbox rows and this completion receipt commit together. A crash
        // after Stripe accepted the schedule simply replays the same operation
        // key and repairs this step without duplicate user messages.
        sub = await finalizePendingDowngradeScheduleNotification(
            sub,
            downgradeQuote.operationKey,
        );

        const bonusMsg = downgradeQuote.starterBonusEligible
            ? 'You will get bonus features for 6 months with the Starter plan.'
            : 'Bonus features are no longer available with the Starter plan for your account (you already used your 6-month Starter bonus period).';

        res.json({
            msg: 'Downgrade scheduled. Your plan will switch to Starter after the current Elite period ends.',
            bonusInfo: bonusMsg,
            reused: resumingDowngrade,
            recurringPrice: {
                amountMinor: downgradeQuote.targetUnitAmountMinor,
                currency: downgradeQuote.targetCurrency.toUpperCase(),
            },
        });
    } catch (error) {
        console.error('Downgrade to Starter error:', error);
        res.status(500).json({ msg: 'Failed to schedule downgrade.' });
    }
};

// Cancel a pending downgrade (keep Elite)
exports.cancelDowngrade = async (req, res) => {
    try {
        const sellerId = req.user.id;
        const sub = await SellerSubscription.findOne({ seller: sellerId });

        if (!sub || !sub.pendingDowngrade?.toPlan) {
            return res.status(400).json({ msg: 'No pending downgrade to cancel.' });
        }

        if (!stripe || !sub.stripeSubscriptionId) {
            return res.status(500).json({ msg: 'Payment system error.' });
        }

        // Undo the Stripe cancellation
        await stripe.subscriptions.update(sub.stripeSubscriptionId, {
            cancel_at_period_end: false,
        });

        sub.pendingDowngrade = { toPlan: null, scheduledAt: null, activationPending: false };
        sub.cancelledAt = null;
        await sub.save();

        res.json({ msg: 'Downgrade cancelled. You will remain on Rozare Elite.' });
    } catch (error) {
        console.error('Cancel downgrade error:', error);
        res.status(500).json({ msg: 'Failed to cancel downgrade.' });
    }
};

// CRON job: enqueue subscription lifecycle events. Channel delivery belongs to
// the notification outbox worker; these flags are only idempotent hand-off
// receipts and are updated after all four channel rows exist.
exports.processTrialExpirations = async () => {
    try {
        const now = new Date();
        const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
        const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const Cart = require('../models/Cart');
        const Product = require('../models/Product');
        const expiringSoon = await SellerSubscription.find({
            status: 'trial',
            trialEndDate: { $lte: threeDaysFromNow, $gt: now },
            warningEmailSent: { $ne: true },
        });
        for (const subscription of expiringSoon) {
            const notificationSubscription = await ensureTrialExpiringPricingSnapshot(subscription);
            if (
                !notificationSubscription
                || notificationSubscription.warningEmailSent
                || notificationSubscription.status !== 'trial'
            ) continue;
            await enqueueTrialExpiringNotification(notificationSubscription);
            await SellerSubscription.updateOne({
                _id: notificationSubscription._id,
                status: 'trial',
                trialEndDate: notificationSubscription.trialEndDate,
                warningEmailSent: { $ne: true },
                'lifecyclePricing.trialExpiring.eventAt': notificationSubscription.trialEndDate,
                'lifecyclePricing.trialExpiring.starterStandardAmountMinor': notificationSubscription.lifecyclePricing.trialExpiring.starterStandardAmountMinor,
                'lifecyclePricing.trialExpiring.starterFounderAmountMinor': notificationSubscription.lifecyclePricing.trialExpiring.starterFounderAmountMinor,
                'lifecyclePricing.trialExpiring.starterFreePeriodDays': notificationSubscription.lifecyclePricing.trialExpiring.starterFreePeriodDays,
            }, { $set: { warningEmailSent: true } });
        }

        const trialBlockCandidates = await SellerSubscription.find({
            $or: [
                { status: 'trial', trialEndDate: { $lte: now } },
                {
                    status: 'blocked',
                    trialBlockedNotificationEventAt: { $ne: null },
                    trialBlockedNotificationEnqueuedAt: null,
                },
            ],
        });
        let trialBlocksOutboxed = 0;
        for (const candidate of trialBlockCandidates) {
            let subscription = candidate;
            if (candidate.status === 'trial') {
                subscription = await SellerSubscription.findOneAndUpdate({
                    _id: candidate._id,
                    status: 'trial',
                    trialEndDate: candidate.trialEndDate,
                }, {
                    $set: {
                        status: 'blocked',
                        blockedAt: now,
                        blockedReason: 'Trial period expired. Subscribe to reactivate your store.',
                        trialBlockedNotificationEventAt: candidate.trialEndDate,
                    },
                }, { new: true, runValidators: true }) || await SellerSubscription.findById(candidate._id);
            }
            if (!subscription?.trialBlockedNotificationEventAt) continue;

            const store = await Store.findOne({ seller: subscription.seller });
            if (store) {
                store.isActive = false;
                store.blockedAt = subscription.blockedAt || now;
                const purchased = store.subdomainPurchase?.isPurchased
                    && store.subdomainPurchase?.expiresAt
                    && new Date(store.subdomainPurchase.expiresAt) > now;
                if (!purchased && !store.subdomainPurchase?.removalScheduledAt) {
                    store.subdomainPurchase = {
                        ...(store.subdomainPurchase?.toObject?.() || {}),
                        removalScheduledAt: new Date((subscription.blockedAt || now).getTime() + 7 * 24 * 60 * 60 * 1000),
                    };
                }
                await store.save();
            }
            const sellerProducts = await Product.find({ seller: subscription.seller }).select('_id');
            if (sellerProducts.length) {
                const productIds = sellerProducts.map(product => product._id);
                await Cart.updateMany(
                    { 'cartItems.product': { $in: productIds } },
                    { $pull: { cartItems: { product: { $in: productIds } } } },
                );
            }

            await enqueueTrialBlockedNotification(subscription);
            const marked = await SellerSubscription.updateOne({
                _id: subscription._id,
                status: 'blocked',
                trialBlockedNotificationEventAt: subscription.trialBlockedNotificationEventAt,
                trialBlockedNotificationEnqueuedAt: null,
            }, { $set: { trialBlockedNotificationEnqueuedAt: new Date() } });
            if (Number(marked.matchedCount ?? marked.n ?? 0) === 1) trialBlocksOutboxed += 1;
        }

        const subscriptionsEndingSoon = await SellerSubscription.find({
            status: { $in: ['active', 'free_period'] },
            cancelledAt: { $ne: null },
            currentPeriodEnd: { $lte: threeDaysFromNow, $gt: now },
            warningEmailSent: { $ne: true },
            $and: [
                { $or: [{ 'pendingDowngrade.toPlan': { $exists: false } }, { 'pendingDowngrade.toPlan': null }] },
                { $or: [{ 'pendingDowngrade.scheduledAt': { $exists: false } }, { 'pendingDowngrade.scheduledAt': null }] },
            ],
        });
        for (const subscription of subscriptionsEndingSoon) {
            await enqueueSubscriptionEndingNotification(subscription);
            await SellerSubscription.updateOne({
                _id: subscription._id,
                status: subscription.status,
                cancelledAt: subscription.cancelledAt,
                currentPeriodEnd: subscription.currentPeriodEnd,
                warningEmailSent: { $ne: true },
                'pendingDowngrade.toPlan': null,
            }, { $set: { warningEmailSent: true } });
        }

        const bonusExpiringSoon = await SellerSubscription.find({
            status: { $in: ['active', 'free_period', 'past_due'] },
            plan: { $ne: 'elite' },
            bonusFeaturesActive: true,
            bonusExpiryDate: { $lte: sevenDaysFromNow, $gt: now },
            bonusExpiryWarningEmailSent: { $ne: true },
        });
        for (const subscription of bonusExpiringSoon) {
            const notificationSubscription = await ensureBonusLifecyclePricingSnapshot(subscription, {
                kind: 'expiring',
                sourceDate: subscription.bonusExpiryDate,
            });
            if (
                !notificationSubscription
                || notificationSubscription.bonusExpiryWarningEmailSent
                || notificationSubscription.plan === 'elite'
                || !notificationSubscription.bonusFeaturesActive
            ) continue;
            await enqueueBonusLifecycleNotification(notificationSubscription, {
                kind: 'expiring',
                sourceDate: notificationSubscription.bonusExpiryDate,
            });
            await SellerSubscription.updateOne({
                _id: notificationSubscription._id,
                plan: { $ne: 'elite' },
                bonusFeaturesActive: true,
                bonusExpiryDate: notificationSubscription.bonusExpiryDate,
                bonusExpiryWarningEmailSent: { $ne: true },
                'lifecyclePricing.bonusExpiring.eventAt': notificationSubscription.bonusExpiryDate,
                'lifecyclePricing.bonusExpiring.eliteAmountMinor': notificationSubscription.lifecyclePricing.bonusExpiring.eliteAmountMinor,
                'lifecyclePricing.bonusExpiring.eliteFreePeriodDays': notificationSubscription.lifecyclePricing.bonusExpiring.eliteFreePeriodDays,
            }, { $set: { bonusExpiryWarningEmailSent: true } });
        }

        const bonusExpiryCandidates = await SellerSubscription.find({
            plan: { $ne: 'elite' },
            $or: [
                { bonusFeaturesActive: true, bonusExpiryDate: { $lte: now } },
                {
                    bonusExpiredNotificationEventAt: { $ne: null },
                    bonusExpiredNotificationEnqueuedAt: null,
                },
            ],
        });
        let bonusExpiredOutboxed = 0;
        for (const candidate of bonusExpiryCandidates) {
            let subscription = candidate;
            if (candidate.bonusFeaturesActive) {
                subscription = await SellerSubscription.findOneAndUpdate({
                    _id: candidate._id,
                    plan: { $ne: 'elite' },
                    bonusFeaturesActive: true,
                    bonusExpiryDate: candidate.bonusExpiryDate,
                }, {
                    $set: {
                        bonusFeaturesActive: false,
                        bonusFeaturesExpiredPermanently: true,
                        bonusExpiredNotificationEventAt: candidate.bonusExpiryDate,
                    },
                }, { new: true, runValidators: true }) || await SellerSubscription.findById(candidate._id);
            }
            if (!subscription?.bonusExpiredNotificationEventAt || subscription.plan === 'elite') continue;
            subscription = await ensureBonusLifecyclePricingSnapshot(subscription, {
                kind: 'expired',
                sourceDate: subscription.bonusExpiredNotificationEventAt,
            });
            if (subscription?.bonusExpiredNotificationEnqueuedAt) continue;
            await enqueueBonusLifecycleNotification(subscription, {
                kind: 'expired',
                sourceDate: subscription.bonusExpiredNotificationEventAt,
            });
            const marked = await SellerSubscription.updateOne({
                _id: subscription._id,
                plan: { $ne: 'elite' },
                bonusExpiredNotificationEventAt: subscription.bonusExpiredNotificationEventAt,
                bonusExpiredNotificationEnqueuedAt: null,
                'lifecyclePricing.bonusExpired.eventAt': subscription.bonusExpiredNotificationEventAt,
                'lifecyclePricing.bonusExpired.eliteAmountMinor': subscription.lifecyclePricing.bonusExpired.eliteAmountMinor,
                'lifecyclePricing.bonusExpired.eliteFreePeriodDays': subscription.lifecyclePricing.bonusExpired.eliteFreePeriodDays,
            }, { $set: { bonusExpiredNotificationEnqueuedAt: new Date() } });
            if (Number(marked.matchedCount ?? marked.n ?? 0) === 1) bonusExpiredOutboxed += 1;
        }

        const graceExpiryCandidates = await SellerSubscription.find({
            plan: 'starter',
            $or: [
                {
                    status: 'blocked',
                    bonusGraceDeadline: { $lte: now },
                    bonusFeaturesExpiredPermanently: { $ne: true },
                },
                {
                    bonusGraceExpiredNotificationEventAt: { $ne: null },
                    bonusGraceExpiredNotificationEnqueuedAt: null,
                },
            ],
        });
        let graceExpiredOutboxed = 0;
        for (const candidate of graceExpiryCandidates) {
            let subscription = candidate;
            if (!candidate.bonusFeaturesExpiredPermanently) {
                subscription = await SellerSubscription.findOneAndUpdate({
                    _id: candidate._id,
                    status: 'blocked',
                    plan: 'starter',
                    bonusGraceDeadline: candidate.bonusGraceDeadline,
                    bonusFeaturesExpiredPermanently: { $ne: true },
                }, {
                    $set: {
                        bonusFeaturesActive: false,
                        bonusFeaturesExpiredPermanently: true,
                        bonusGraceExpiredNotificationEventAt: candidate.bonusGraceDeadline,
                    },
                }, { new: true, runValidators: true }) || await SellerSubscription.findById(candidate._id);
            }
            if (!subscription?.bonusGraceExpiredNotificationEventAt || subscription.plan !== 'starter') continue;
            subscription = await ensureBonusLifecyclePricingSnapshot(subscription, {
                kind: 'removed',
                sourceDate: subscription.bonusGraceExpiredNotificationEventAt,
            });
            if (subscription?.bonusGraceExpiredNotificationEnqueuedAt) continue;
            await enqueueBonusLifecycleNotification(subscription, {
                kind: 'removed',
                sourceDate: subscription.bonusGraceExpiredNotificationEventAt,
            });
            const marked = await SellerSubscription.updateOne({
                _id: subscription._id,
                plan: 'starter',
                bonusGraceExpiredNotificationEventAt: subscription.bonusGraceExpiredNotificationEventAt,
                bonusGraceExpiredNotificationEnqueuedAt: null,
                'lifecyclePricing.bonusRemoved.eventAt': subscription.bonusGraceExpiredNotificationEventAt,
                'lifecyclePricing.bonusRemoved.eliteAmountMinor': subscription.lifecyclePricing.bonusRemoved.eliteAmountMinor,
                'lifecyclePricing.bonusRemoved.eliteFreePeriodDays': subscription.lifecyclePricing.bonusRemoved.eliteFreePeriodDays,
            }, {
                $set: {
                    bonusGraceExpiredNotificationEnqueuedAt: new Date(),
                    bonusGraceDeadline: null,
                },
            });
            if (Number(marked.matchedCount ?? marked.n ?? 0) === 1) graceExpiredOutboxed += 1;
        }

        console.log(
            `Subscription lifecycle check: ${expiringSoon.length} trial warnings, ${trialBlocksOutboxed} trial blocks, `
            + `${subscriptionsEndingSoon.length} ending warnings, ${bonusExpiringSoon.length} bonus warnings, `
            + `${bonusExpiredOutboxed} bonus expiries, ${graceExpiredOutboxed} grace expiries outboxed`,
        );
    } catch (error) {
        console.error('Process trial expirations error:', error);
    }
};


// Admin: Get all seller subscriptions
exports.getAllSubscriptionsForAdmin = async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ msg: 'Access denied. Admin only.' });
        }

        const subscriptions = await SellerSubscription.find()
            .populate('seller', 'username email')
            .sort({ createdAt: -1 });

        const subscriptionsWithStores = await Promise.all(
            subscriptions.map(async (sub) => {
                const store = await Store.findOne({ seller: sub.seller._id }).select('storeName storeSlug');
                return {
                    ...sub.toObject(),
                    store: store ? { name: store.storeName, slug: store.storeSlug } : null
                };
            })
        );

        res.status(200).json({
            msg: 'All subscriptions fetched successfully',
            subscriptions: subscriptionsWithStores
        });
    } catch (error) {
        console.error('Get all subscriptions error:', error);
        res.status(500).json({ msg: 'Failed to fetch subscriptions' });
    }
};

// Returns true if a seller is entitled to bonus features (Trial OR active bonusFeaturesActive OR Elite plan).
// Used by feature-gating helpers like sellerHasFeaturedProducts (bonus-only features).
const isEntitledToBonus = (sub) => {
    if (!sub) return false;
    if (sub.status === 'trial') {
        return sub.trialEndDate ? new Date() < sub.trialEndDate : true;
    }
    // Elite plan always has bonus features
    if (sub.plan === 'elite' && ['active', 'free_period'].includes(sub.status)) {
        return true;
    }
    // Check permanent expiry for non-elite
    if (sub.bonusFeaturesExpiredPermanently) {
        return false;
    }
    if (sub.bonusFeaturesActive) {
        return sub.bonusExpiryDate ? new Date() < sub.bonusExpiryDate : true;
    }
    return false;
};

// Check if seller has an active subscription or trial (for starter-level features like WhatsApp)
const isSellerActive = (sub) => {
    if (!sub) return false;
    if (sub.status === 'trial') {
        return sub.trialEndDate ? new Date() < sub.trialEndDate : true;
    }
    // Any active subscription status means they have starter features
    if (['free_period', 'active', 'past_due'].includes(sub.status)) {
        return true;
    }
    return false;
};

// Gating helper: WhatsApp order auto-verification — included in Starter plan (and trial)
exports.sellerHasWhatsAppVerify = async (sellerId) => {
    try {
        if (!sellerId) return false;
        const sub = await SellerSubscription.findOne({ seller: sellerId });
        return isSellerActive(sub);
    } catch (err) {
        console.error('sellerHasWhatsAppVerify:', err.message);
        return false;
    }
};

// One-time migration: mark existing paid/previously-paid sellers as having used their free period
// This prevents them from getting another free period on re-subscription
exports.migrateHasUsedFreePeriod = async () => {
    try {
        // Any seller whose subscribedAt is set (means they subscribed at some point)
        // should be marked as having used their free period
        const result = await SellerSubscription.updateMany(
            {
                subscribedAt: { $exists: true, $ne: null },
                hasUsedFreePeriod: { $ne: true },
            },
            { $set: { hasUsedFreePeriod: true } }
        );
        if (result.modifiedCount > 0) {
            console.log(`[migration] Marked ${result.modifiedCount} existing sellers as hasUsedFreePeriod=true`);
        }

        // Also migrate: any seller who ever had Starter bonus (active or expired) gets starterBonusPeriodUsed=true
        // A seller qualifies if: they were ever on starter plan AND bonusExpiryDate was set
        const starterBonusResult = await SellerSubscription.updateMany(
            {
                $or: [
                    { plan: 'starter', bonusExpiryDate: { $exists: true, $ne: null } },
                    { bonusFeaturesExpiredPermanently: true },
                    { bonusGraceDeadline: { $exists: true, $ne: null } },
                ],
                starterBonusPeriodUsed: { $ne: true },
            },
            { $set: { starterBonusPeriodUsed: true } }
        );
        if (starterBonusResult.modifiedCount > 0) {
            console.log(`[migration] Marked ${starterBonusResult.modifiedCount} existing sellers as starterBonusPeriodUsed=true`);
        }
    } catch (error) {
        console.error('Migration hasUsedFreePeriod error:', error);
    }
};

// Undo a scheduled cancellation before Stripe ends the subscription.
exports.resumeSubscription = async (req, res) => {
    try {
        const sellerId = req.user.id;
        const sub = await SellerSubscription.findOne({ seller: sellerId });

        if (!sub || !sub.stripeSubscriptionId || !['active', 'free_period'].includes(sub.status)) {
            return res.status(400).json({ msg: 'No active subscription is available to resume.' });
        }
        if (sub.pendingDowngrade?.toPlan) {
            return res.status(400).json({
                msg: 'This is a scheduled plan change. Use Keep Elite to cancel the downgrade.',
            });
        }
        if (!sub.cancelledAt) {
            return res.status(400).json({ msg: 'This subscription is not scheduled for cancellation.' });
        }
        if (!stripe) {
            return res.status(503).json({ msg: 'Payment system not configured.' });
        }

        const stripeSubscription = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
        if (stripeSubscription.status === 'canceled') {
            return res.status(409).json({
                msg: 'This subscription has already ended and cannot be resumed.',
            });
        }

        await stripe.subscriptions.update(sub.stripeSubscriptionId, {
            cancel_at_period_end: false,
        });
        sub.cancelledAt = null;
        await sub.save();

        return res.json({
            msg: sub.founderOffer?.active
                ? 'Subscription resumed. Your FIRST100 founder rate remains locked.'
                : 'Subscription resumed successfully.',
            founderOfferActive: Boolean(sub.founderOffer?.active),
        });
    } catch (error) {
        console.error('Resume subscription error:', error);
        return res.status(500).json({ msg: 'Failed to resume subscription. Please try again.' });
    }
};

// One-time launch migration: sellers already paying the previous $5.99/$12.99
// rates keep those prices as a FIRST100 founder entitlement.
exports.migrateFounderPromotion = async () => {
    try {
        const result = await migrateLegacyFounderSubscribers();
        if (result.migrated > 0) {
            console.log(`[migration] Granted FIRST100 founder pricing to ${result.migrated} existing seller subscription(s)`);
        }
    } catch (error) {
        console.error('Founder promotion migration error:', error);
    }
};

