const mongoose = require('mongoose');
const { isExactDecimalAtScale } = require('../services/moneyMath');

const STRIPE_CHECKOUT_SESSION_ID = /^cs_[A-Za-z0-9_]+$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Mongoose's built-in Number, String, and Date casts accept values such as
// booleans and numeric/date strings. Promotion capacity and ownership fields
// are persistence authorities, so malformed input must fail instead of being
// silently normalized at this boundary.
const strictNumberSetter = value => {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError('Promotion numeric fields require a finite number.');
    }
    return value;
};

const strictDateSetter = value => {
    if (value === null || value === undefined) return value;
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw new TypeError('Promotion timestamp fields require a valid Date.');
    }
    return value;
};

const strictStringSetter = value => {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'string') {
        throw new TypeError('Promotion identifier fields require a string.');
    }
    return value;
};

const isValidDate = value => value instanceof Date && Number.isFinite(value.getTime());

const isStripeCompatiblePercent = value => {
    // Stripe accepts a positive percent_off up to 100 with two-decimal
    // precision. The shared boundary also rejects coercible scalars and
    // magnitudes that cannot round-trip through exact decimal storage.
    return value > 0 && isExactDecimalAtScale(value, { scale: 2, min: 0, max: 100 });
};

const isValidCheckoutSessionId = value => value === null || value === undefined || (
    typeof value === 'string'
    && value.length >= 4
    && value.length <= 255
    && STRIPE_CHECKOUT_SESSION_ID.test(value)
);

const claimSchema = new mongoose.Schema({
    seller: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        immutable: true,
    },
    claimedAt: {
        type: Date,
        required: true,
        immutable: true,
        set: strictDateSetter,
        validate: {
            validator: isValidDate,
            message: 'Promotion claim timestamp must be a valid Date',
        },
    },
    source: {
        type: String,
        enum: ['coupon', 'legacy'],
        default: 'coupon',
        immutable: true,
        set: strictStringSetter,
    },
    checkoutSessionId: {
        type: String,
        default: null,
        immutable: true,
        set: strictStringSetter,
        validate: {
            validator: isValidCheckoutSessionId,
            message: 'Promotion claim Checkout Session id is invalid',
        },
    },
}, { _id: false });

const reservationSchema = new mongoose.Schema({
    seller: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        immutable: true,
    },
    token: {
        type: String,
        required: true,
        immutable: true,
        minlength: 36,
        maxlength: 36,
        match: UUID_V4,
        set: strictStringSetter,
    },
    checkoutSessionId: {
        type: String,
        default: null,
        set: strictStringSetter,
        validate: {
            validator: isValidCheckoutSessionId,
            message: 'Promotion reservation Checkout Session id is invalid',
        },
    },
    createdAt: {
        type: Date,
        required: true,
        immutable: true,
        set: strictDateSetter,
        validate: {
            validator: isValidDate,
            message: 'Promotion reservation creation timestamp must be a valid Date',
        },
    },
    expiresAt: {
        type: Date,
        required: true,
        set: strictDateSetter,
        validate: [
            {
                validator: isValidDate,
                message: 'Promotion reservation expiry timestamp must be a valid Date',
            },
            {
                validator(value) {
                    // A positional query update cannot load the sibling
                    // createdAt field. New/replaced reservations are validated
                    // as subdocuments and must always have a positive window.
                    if (this instanceof mongoose.Query) return true;
                    return isValidDate(this.createdAt) && value > this.createdAt;
                },
                message: 'Promotion reservation expiry must be after creation',
            },
        ],
    },
}, { _id: false });

const subscriptionPromotionSchema = new mongoose.Schema({
    code: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true,
        minlength: 3,
        maxlength: 32,
        match: /^[A-Z0-9_-]+$/,
        set: strictStringSetter,
    },
    name: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 80,
        set: strictStringSetter,
    },
    discountPercent: {
        type: Number,
        required: true,
        min: 0.01,
        max: 100,
        set: strictNumberSetter,
        validate: {
            validator: isStripeCompatiblePercent,
            message: 'Promotion discount must be a finite positive percentage up to 100 with at most two decimals',
        },
    },
    maxRedemptions: {
        type: Number,
        required: true,
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
        set: strictNumberSetter,
        validate: {
            validator: value => Number.isSafeInteger(value) && value > 0,
            message: 'Promotion redemption limit must be a positive safe whole number',
        },
    },
    claims: { type: [claimSchema], default: [] },
    reservations: { type: [reservationSchema], default: [] },
    legacyMigrationCompletedAt: {
        type: Date,
        default: null,
        set: strictDateSetter,
        validate: {
            validator: value => value === null || value === undefined || isValidDate(value),
            message: 'Promotion migration timestamp must be a valid Date',
        },
    },
}, { timestamps: true });

subscriptionPromotionSchema.index({ 'reservations.expiresAt': 1 });

module.exports = mongoose.model('SubscriptionPromotion', subscriptionPromotionSchema);
