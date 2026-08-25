const mongoose = require('mongoose');
const { isExactDecimalAtScale } = require('../services/moneyMath');

const strictActualNumberSetter = value => {
    if (value === null || value === undefined) return value;
    return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
};

const isNullableNonNegativeSafeInteger = value => (
    value === null || value === undefined || (Number.isSafeInteger(value) && value >= 0)
);

const isStoredFounderDiscount = (value, { nullable = false } = {}) => (
    (nullable && (value === null || value === undefined))
    || isExactDecimalAtScale(value, { scale: 2, min: 0, max: 100 })
);

const nullableMinorUnitField = ({ positive = false } = {}) => ({
    type: Number,
    default: null,
    min: 0,
    set: strictActualNumberSetter,
    validate: {
        validator: value => isNullableNonNegativeSafeInteger(value) && (
            !positive || value === null || value === undefined || value > 0
        ),
        message: positive
            ? 'Subscription price snapshot must be a positive safe minor-unit integer'
            : 'Subscription price snapshot must be a non-negative safe minor-unit integer',
    },
});

const nullableDayCountField = () => ({
    type: Number,
    default: null,
    min: 0,
    max: 365,
    set: strictActualNumberSetter,
    validate: {
        validator: value => (
            value === null
            || value === undefined
            || (Number.isSafeInteger(value) && value >= 0 && value <= 365)
        ),
        message: 'Subscription period snapshot must be a whole day count between 0 and 365',
    },
});

const safeEventTimestampField = () => ({
    type: Number,
    default: 0,
    min: 0,
    set: strictActualNumberSetter,
    validate: {
        validator: value => Number.isSafeInteger(value) && value >= 0,
        message: 'Stripe event timestamp must be a non-negative safe integer',
    },
});

const sellerSubscriptionSchema = new mongoose.Schema({
    seller: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true,
    },
    // Trial: starts when user becomes a seller (or creates store)
    trialStartDate: { type: Date, default: Date.now },
    trialEndDate: { type: Date }, // trialStartDate + 15 days

    // Subscription
    status: {
        type: String,
        enum: ['trial', 'free_period', 'active', 'past_due', 'cancelled', 'blocked'],
        default: 'trial',
    },
    planName: {
        type: String,
        default: 'Rozare Free Trial',
    },
    plan: {
        type: String,
        enum: ['free_trial', 'starter', 'elite'],
        default: 'free_trial',
    },
    // After subscription: introductory free period, then the plan's locked monthly rate.
    subscribedAt: { type: Date },
    freePeriodEndDate: { type: Date }, // subscribedAt + 30 days
    currentPeriodStart: { type: Date },
    currentPeriodEnd: { type: Date },

    // Bonus features (available for 6 months from subscription date)
    bonusExpiryDate: { type: Date }, // subscribedAt + 6 months
    bonusFeaturesActive: { type: Boolean, default: false },
    bonusFeaturesExpiredPermanently: { type: Boolean, default: false }, // After grace period, can only get back via Elite plan
    bonusExpiryWarningEmailSent: { type: Boolean, default: false }, // Track if we sent the "about to expire" notification
    // Durable lifecycle notification receipts. The event timestamp is frozen
    // when the entitlement transition happens; the enqueued timestamp is set
    // only after all configured outbox channel rows exist. This lets the cron
    // retry a crash between the state change and the outbox hand-off without
    // notifying historical rows that pre-date this workflow.
    bonusExpiredNotificationEventAt: { type: Date, default: null },
    bonusExpiredNotificationEnqueuedAt: { type: Date, default: null },
    bonusGraceExpiredNotificationEventAt: { type: Date, default: null },
    bonusGraceExpiredNotificationEnqueuedAt: { type: Date, default: null },

    // Catalog prices shown by lifecycle alerts are frozen before the first
    // outbox row is attempted. A deployment that changes the live catalog can
    // therefore resume a partial four-channel enqueue without changing money
    // evidence or creating an idempotency conflict.
    lifecyclePricing: {
        trialExpiring: {
            eventAt: { type: Date, default: null },
            starterStandardAmountMinor: nullableMinorUnitField({ positive: true }),
            starterFounderAmountMinor: nullableMinorUnitField({ positive: true }),
            starterFreePeriodDays: nullableDayCountField(),
        },
        bonusExpiring: {
            eventAt: { type: Date, default: null },
            eliteAmountMinor: nullableMinorUnitField({ positive: true }),
            eliteFreePeriodDays: nullableDayCountField(),
        },
        bonusExpired: {
            eventAt: { type: Date, default: null },
            eliteAmountMinor: nullableMinorUnitField({ positive: true }),
            eliteFreePeriodDays: nullableDayCountField(),
        },
        bonusRemoved: {
            eventAt: { type: Date, default: null },
            eliteAmountMinor: nullableMinorUnitField({ positive: true }),
            eliteFreePeriodDays: nullableDayCountField(),
        },
    },

    // PERMANENT FLAG: once seller has started their Starter bonus period, this is set to true forever.
    // Never resets, even on Elite upgrade/downgrade. Prevents exploit: Starter→expire→Elite→downgrade→fresh bonus.
    starterBonusPeriodUsed: { type: Boolean, default: false },

    // 3-day grace period: after account blocked, seller has 3 days to re-subscribe and keep remaining bonus time
    bonusGraceDeadline: { type: Date }, // blockedAt + 3 days; if seller re-subscribes before this, bonus continues
    bonusGraceNotificationSent: { type: Boolean, default: false }, // Track if grace period notification was sent

    // Stripe
    stripeCustomerId: { type: String },
    stripeSubscriptionId: { type: String },
    stripeProductId: { type: String },
    stripePriceId: { type: String },

    // Webhook identities and reversible payment-risk state. Checkout session
    // IDs prevent a retry from consuming a second free period. Invoice IDs and
    // periods prevent an older subscription/invoice from restoring a newer
    // failed or disputed billing state.
    processedCheckoutSessionIds: { type: [String], default: [] },
    paymentRisk: {
        suspended: { type: Boolean, default: false },
        reason: { type: String, default: '' },
        previousStatus: {
            type: String,
            enum: {
                values: ['trial', 'free_period', 'active', 'past_due', 'cancelled', 'blocked', null],
                message: 'paymentRisk.previousStatus is invalid',
            },
            default: null,
        },
        stripeSubscriptionId: { type: String, default: '' },
        latestFailureInvoiceId: { type: String, default: '' },
        latestFailurePeriodStart: { type: Date, default: null },
        latestFailureEventCreated: safeEventTimestampField(),
        latestSuccessfulInvoiceId: { type: String, default: '' },
        latestSuccessfulPeriodStart: { type: Date, default: null },
        latestSuccessfulEventCreated: safeEventTimestampField(),
        // Durable delivery intent for the current authoritative renewal
        // failure. The failure marker and this intent are written together, so
        // a webhook retry can finish only the channels that did not complete.
        // A later successful invoice supersedes the intent before recovery
        // delivery begins, preventing a delayed retry from warning an already
        // recovered seller.
        failureNotification: {
            invoiceId: { type: String, default: null },
            eventId: { type: String, default: null },
            stripeSubscriptionId: { type: String, default: null },
            planName: { type: String, default: null },
            amountDueMinor: nullableMinorUnitField({ positive: true }),
            currency: {
                type: String,
                enum: { values: ['USD', null] },
                default: null,
            },
            occurredAt: { type: Date, default: null },
            state: {
                type: String,
                enum: {
                    values: ['pending', 'processing', 'partial', 'outboxed', 'sent', 'superseded', null],
                    message: 'paymentRisk.failureNotification.state is invalid',
                },
                default: null,
            },
            token: { type: String, default: null },
            startedAt: { type: Date, default: null },
            completedAt: { type: Date, default: null },
            lastError: { type: String, default: '' },
            emailState: {
                type: String,
                enum: { values: ['pending', 'outboxed', 'sent', 'skipped', 'failed', null] },
                default: null,
            },
            whatsAppState: {
                type: String,
                enum: { values: ['pending', 'outboxed', 'sent', 'skipped', 'failed', null] },
                default: null,
            },
            inAppState: {
                type: String,
                enum: { values: ['pending', 'outboxed', 'sent', 'skipped', 'failed', null] },
                default: null,
            },
            pushState: {
                type: String,
                enum: { values: ['pending', 'outboxed', 'sent', 'skipped', 'failed', null] },
                default: null,
            },
        },
        updatedAt: { type: Date, default: null },
    },

    // Warning tracking
    warningEmailSent: { type: Boolean, default: false },
    trialBlockedNotificationEventAt: { type: Date, default: null },
    trialBlockedNotificationEnqueuedAt: { type: Date, default: null },
    blockedAt: { type: Date },
    blockedReason: { type: String, default: '' },

    // Deprecated compatibility field. -1 means seller AI chat is unlimited.
    aiMessageLimit: { type: Number, default: -1 },

    // Paid marketing add-ons attached to the seller subscription.
    metaAdsIncluded: { type: Boolean, default: false },

    // FIRST100 entitlement remains active across plan changes and is forfeited only
    // when the paid subscription actually ends.
    founderOffer: {
        active: { type: Boolean, default: false },
        code: { type: String, default: null },
        discountPercent: {
            type: Number,
            default: 0,
            min: 0,
            max: 100,
            set: strictActualNumberSetter,
            validate: {
                validator: value => isStoredFounderDiscount(value),
                message: 'Founder discount must be between 0 and 100 with at most two decimals',
            },
        },
        claimedAt: { type: Date, default: null },
        forfeitedAt: { type: Date, default: null },
        source: {
            type: String,
            enum: {
                values: ['coupon', 'legacy', null],
                message: 'founderOffer.source must be coupon, legacy, or null',
            },
            default: null,
        },
    },

    cancelledAt: { type: Date },

    // Track if seller ever used a free period (to prevent giving free period again on re-subscribe)
    hasUsedFreePeriod: { type: Boolean, default: false },

    // Downgrade scheduling: Elite → Starter at period end
    // When no downgrade is pending, toPlan is null/undefined
    pendingDowngrade: {
        toPlan: {
            type: String,
            enum: {
                values: ['starter', null],
                message: 'pendingDowngrade.toPlan must be "starter" or null',
            },
            default: null,
        },
        scheduledAt: { type: Date, default: null },
        // Immutable quote and operation identity captured when the seller
        // schedules the downgrade. Neither a later catalog edit nor a changed
        // founder flag may alter the eventual Stripe recurring amount.
        operationKey: { type: String, default: null, maxlength: 128 },
        sourceStripeSubscriptionId: { type: String, default: null, maxlength: 255 },
        targetPlanName: { type: String, default: null, maxlength: 120 },
        targetUnitAmountMinor: nullableMinorUnitField({ positive: true }),
        targetCurrency: {
            type: String,
            enum: { values: ['usd', null], message: 'pendingDowngrade.targetCurrency must be usd or null' },
            default: null,
        },
        founderRateApplied: { type: Boolean, default: null },
        founderDiscountPercent: {
            type: Number,
            default: null,
            min: 0,
            max: 100,
            set: strictActualNumberSetter,
            validate: {
                validator: value => isStoredFounderDiscount(value, { nullable: true }),
                message: 'pendingDowngrade founder discount must be between 0 and 100 with at most two decimals',
            },
        },
        founderOfferCode: { type: String, default: null, maxlength: 80 },
        starterBonusEligible: { type: Boolean, default: null },
        quoteFrozenAt: { type: Date, default: null },
        // Step receipts make the Stripe schedule + transactional outbox repairable
        // after a crash without sending a second schedule message.
        stripeScheduledAt: { type: Date, default: null },
        notificationEnqueuedAt: { type: Date, default: null },
        notificationCompletedAt: { type: Date, default: null },
        // Short database lease used while converting a cancelled Elite
        // subscription into Starter. It prevents duplicate webhook deliveries
        // from creating two paid Starter subscriptions.
        processingToken: { type: String, default: null },
        processingEventId: { type: String, default: null },
        processingStartedAt: { type: Date, default: null },
        // An automatic Elite -> Starter transition can return `incomplete`.
        // The one-time Starter bonus must begin only after its first paid
        // invoice, never merely because Stripe created an unpaid subscription.
        activationPending: { type: Boolean, default: false },
    },

    // Resumable cross-document projection. Webhooks persist this marker in the
    // same write as the authoritative subscription transition, then clear it
    // only after the matching Store mutation succeeds. Stripe retries can thus
    // finish a transition after a transient Store/database failure.
    pendingStoreSync: {
        kind: {
            type: String,
            enum: {
                values: ['checkout_activation', 'downgrade_block', 'downgrade_activation', null],
                message: 'pendingStoreSync.kind is invalid',
            },
            default: null,
        },
        eventId: { type: String, default: null },
        stripeSubscriptionId: { type: String, default: null },
        previousStripeSubscriptionId: { type: String, default: null },
        blockedAt: { type: Date, default: null },
    },

    // Permanent idempotency and recovery record for an ordinary Stripe
    // subscription cancellation. Stripe can deliver the same deletion more
    // than once (including under a different event id), so the ended
    // subscription id -- not the webhook id -- owns one immutable set of
    // cancellation/grace/removal timestamps. Step receipts let a retry finish
    // cross-document projections without extending customer-facing deadlines.
    cancellationTransition: {
        stripeSubscriptionId: { type: String, default: null },
        firstEventId: { type: String, default: null },
        cancelledAt: { type: Date, default: null },
        blockedAt: { type: Date, default: null },
        bonusGraceDeadline: { type: Date, default: null },
        subdomainRemovalScheduledAt: { type: Date, default: null },
        storeAppliedAt: { type: Date, default: null },
        cartCleanupAppliedAt: { type: Date, default: null },
        notificationEnqueuedAt: { type: Date, default: null },
        completedAt: { type: Date, default: null },
    },

    // Immutable facts used to deliver the latest subscription-activation
    // receipt after the entitlement and Store projection are durable. A
    // Stripe retry can finish the outbox write without recomputing the agreed
    // recurring price from a newer pricing catalog.
    activationNotification: {
        kind: {
            type: String,
            enum: {
                values: ['checkout_activation', 'automatic_downgrade', null],
                message: 'activationNotification.kind is invalid',
            },
            default: null,
        },
        sourceReference: { type: String, default: null, maxlength: 255 },
        stripeSubscriptionId: { type: String, default: null, maxlength: 255 },
        occurredAt: { type: Date, default: null },
        planName: { type: String, default: null, maxlength: 120 },
        recurringAmountMinor: nullableMinorUnitField({ positive: true }),
        currency: {
            type: String,
            enum: { values: ['USD', null], message: 'activationNotification.currency is invalid' },
            default: null,
        },
        freePeriodDays: {
            type: Number,
            default: 0,
            min: 0,
            max: 365,
            set: strictActualNumberSetter,
            validate: {
                validator: value => Number.isSafeInteger(value) && value >= 0 && value <= 365,
                message: 'activationNotification.freePeriodDays must be a safe whole-day count',
            },
        },
        freePeriodEndDate: { type: Date, default: null },
        notificationEnqueuedAt: { type: Date, default: null },
        completedAt: { type: Date, default: null },
    },

    // Durable lease/idempotency identity for Stripe plan changes. Paid
    // additions use Stripe pending updates, so the target and external Price /
    // Invoice identities must survive the browser disappearing during 3DS.
    planChangeAttempt: {
        idempotencyToken: { type: String, default: null },
        requestFingerprint: { type: String, default: null },
        changeKind: {
            type: String,
            enum: {
                values: ['upgrade', 'meta_addition', 'meta_removal', null],
                message: 'planChangeAttempt.changeKind is invalid',
            },
            default: null,
        },
        stripeSubscriptionId: { type: String, default: null },
        stripeSubscriptionItemId: { type: String, default: null },
        stripeProductId: { type: String, default: null },
        stripePriceId: { type: String, default: null },
        stripeInvoiceId: { type: String, default: null },
        // Immutable predecessor snapshot. Reversible payment events use this
        // to remove only the funded upgrade/add-on while preserving whatever
        // the seller had already paid for before the plan change.
        sourcePlan: {
            type: String,
            enum: {
                values: ['starter', 'elite', null],
                message: 'planChangeAttempt.sourcePlan is invalid',
            },
            default: null,
        },
        sourcePlanName: { type: String, default: null },
        sourceIncludeMetaAds: { type: Boolean, default: null },
        sourceUnitAmountMinor: nullableMinorUnitField({ positive: true }),
        sourceStripeProductId: { type: String, default: null },
        sourceStripePriceId: { type: String, default: null },
        sourceBonusFeaturesActive: { type: Boolean, default: null },
        sourceBonusExpiryDate: { type: Date, default: null },
        sourceBonusFeaturesExpiredPermanently: { type: Boolean, default: null },
        sourceBonusGraceDeadline: { type: Date, default: null },
        targetPlan: {
            type: String,
            enum: {
                values: ['elite', null],
                message: 'planChangeAttempt.targetPlan is invalid',
            },
            default: null,
        },
        targetPlanName: { type: String, default: null },
        targetIncludeMetaAds: { type: Boolean, default: null },
        targetUnitAmountMinor: nullableMinorUnitField({ positive: true }),
        // Exact durable projection owned by an entitlement reconciliation
        // lease. Stripe timeouts are outcome-indeterminate, so a retry must
        // replay these immutable parameters before a newer funded snapshot can
        // be rebound under a different idempotency key.
        fundedPlanSync: {
            leaseToken: { type: String, default: null },
            snapshotHash: { type: String, default: null },
            planChangeToken: { type: String, default: null },
            sellerId: { type: String, default: null },
            stripeSubscriptionId: { type: String, default: null },
            stripeSubscriptionItemId: { type: String, default: null },
            stripePriceId: { type: String, default: null },
            stripeProductId: { type: String, default: null },
            plan: {
                type: String,
                enum: { values: ['starter', 'elite', null], message: 'fundedPlanSync.plan is invalid' },
                default: null,
            },
            planName: { type: String, default: null },
            includeMetaAds: { type: Boolean, default: null },
            direction: {
                type: String,
                enum: {
                    values: ['funded', 'predecessor', null],
                    message: 'fundedPlanSync.direction is invalid',
                },
                default: null,
            },
            unitAmountMinor: nullableMinorUnitField(),
            idempotencyKey: { type: String, default: null },
            bonusFeaturesActive: { type: Boolean, default: null },
            bonusExpiryDate: { type: Date, default: null },
            bonusFeaturesExpiredPermanently: { type: Boolean, default: null },
            bonusGraceDeadline: { type: Date, default: null },
        },
        pendingUpdateExpiresAt: { type: Date, default: null },
        state: {
            type: String,
            enum: {
                values: ['processing', 'pending_payment', 'recoverable', 'applied', null],
                message: 'planChangeAttempt.state is invalid',
            },
            default: null,
        },
        processingToken: { type: String, default: null },
        startedAt: { type: Date, default: null },
        completedAt: { type: Date, default: null },
        lastError: { type: String, default: '' },
        // One durable delivery workflow is shared by HTTP and webhook
        // convergence. Per-channel receipts prevent a retry from repeating a
        // channel that already completed.
        notificationState: {
            type: String,
            enum: {
                values: ['pending', 'processing', 'partial', 'outboxed', 'sent', null],
                message: 'planChangeAttempt.notificationState is invalid',
            },
            default: null,
        },
        notificationToken: { type: String, default: null },
        notificationStartedAt: { type: Date, default: null },
        notificationCompletedAt: { type: Date, default: null },
        notificationLastError: { type: String, default: '' },
        notificationEmailState: {
            type: String,
            enum: { values: ['pending', 'outboxed', 'sent', 'skipped', 'failed', null] },
            default: null,
        },
        notificationWhatsAppState: {
            type: String,
            enum: { values: ['pending', 'outboxed', 'sent', 'skipped', 'failed', null] },
            default: null,
        },
        notificationInAppState: {
            type: String,
            enum: { values: ['pending', 'outboxed', 'sent', 'skipped', 'failed', null] },
            default: null,
        },
        notificationPushState: {
            type: String,
            enum: { values: ['pending', 'outboxed', 'sent', 'skipped', 'failed', null] },
            default: null,
        },
    },
}, { timestamps: true, optimisticConcurrency: true });

// Virtual: days remaining in trial
sellerSubscriptionSchema.virtual('trialDaysRemaining').get(function () {
    if (this.status !== 'trial') return 0;
    const now = new Date();
    const end = this.trialEndDate || new Date(this.trialStartDate.getTime() + 15 * 24 * 60 * 60 * 1000);
    const diff = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
    return Math.max(0, diff);
});

// Virtual: is trial expiring soon (3 days or less)
sellerSubscriptionSchema.virtual('isTrialExpiringSoon').get(function () {
    if (this.status !== 'trial') return false;
    return this.trialDaysRemaining <= 3 && this.trialDaysRemaining > 0;
});

// Virtual: is store blocked
sellerSubscriptionSchema.virtual('isBlocked').get(function () {
    return this.status === 'blocked';
});

// Virtual: is in free period after subscription
sellerSubscriptionSchema.virtual('isInFreePeriod').get(function () {
    if (this.status !== 'free_period') return false;
    return new Date() < this.freePeriodEndDate;
});

sellerSubscriptionSchema.set('toJSON', { virtuals: true });
sellerSubscriptionSchema.set('toObject', { virtuals: true });

sellerSubscriptionSchema.index({ status: 1 });
sellerSubscriptionSchema.index({ trialEndDate: 1 });

module.exports = mongoose.model('SellerSubscription', sellerSubscriptionSchema);
