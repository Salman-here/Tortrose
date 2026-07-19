const mongoose = require('mongoose');

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
        default: 'Rozare Starter',
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

    // PERMANENT FLAG: once seller has started their Starter bonus period, this is set to true forever.
    // Never resets, even on Elite upgrade/downgrade. Prevents exploit: Starter→expire→Elite→downgrade→fresh bonus.
    starterBonusPeriodUsed: { type: Boolean, default: false },

    // 3-day grace period: after account blocked, seller has 3 days to re-subscribe and keep remaining bonus time
    bonusGraceDeadline: { type: Date }, // blockedAt + 3 days; if seller re-subscribes before this, bonus continues
    bonusGraceNotificationSent: { type: Boolean, default: false }, // Track if grace period notification was sent

    // Stripe
    stripeCustomerId: { type: String },
    stripeSubscriptionId: { type: String },
    stripePriceId: { type: String },

    // Warning tracking
    warningEmailSent: { type: Boolean, default: false },
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
        discountPercent: { type: Number, default: 0 },
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
    },
}, { timestamps: true });

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
