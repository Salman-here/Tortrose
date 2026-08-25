const mongoose = require('mongoose');
const { roundMoney } = require('../services/moneyMath');
const { parseStrictFiniteNumber } = require('../services/numericInputService');

const strictNumberSetter = value => {
    if (value === null || value === undefined) return value;
    const parsed = parseStrictFiniteNumber(value);
    return parsed === null ? Number.NaN : parsed;
};

const isExactNonNegativeMoney = value => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
    try {
        return roundMoney(value) === value;
    } catch (_) {
        return false;
    }
};

const isExactPositiveMoney = value => isExactNonNegativeMoney(value) && value > 0;

const isValidPercentage = value => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100) return false;
    try {
        return roundMoney(value, 6) === value;
    } catch (_) {
        return false;
    }
};

const couponSchema = mongoose.Schema(
    {
        seller: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        code: {
            type: String,
            required: true,
            uppercase: true,
            trim: true,
            minlength: 3,
            maxlength: 32,
            match: /^[A-Z0-9_-]+$/,
        },
        // 'percentage' or 'fixed'
        discountType: {
            type: String,
            enum: ['percentage', 'fixed'],
            required: true,
        },
        discountValue: {
            type: Number,
            required: true,
            min: 0.01,
            set: strictNumberSetter,
            validate: {
                validator(value) {
                    return this.discountType === 'percentage'
                        ? isValidPercentage(value)
                        : isExactPositiveMoney(value);
                },
                message: 'Coupon discount must be an exact positive cent amount or a percentage from 0 to 100 with at most six decimals',
            },
        },
        currency: {
            type: String,
            enum: ['USD', 'PKR', 'EUR', 'GBP'],
            uppercase: true,
            trim: true,
            default: 'USD',
        },
        // Which products: 'all' = all seller products, 'selected' = specific products
        applicableTo: {
            type: String,
            enum: ['all', 'selected'],
            default: 'all',
        },
        // If applicableTo is 'selected', list the product IDs
        applicableProducts: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'Product',
            },
        ],
        // Maximum number of times this coupon can be used (total across all users)
        maxUses: {
            type: Number,
            default: null, // null = unlimited
            min: 1,
            set: strictNumberSetter,
            validate: {
                validator: value => value === null || (Number.isSafeInteger(value) && value > 0),
                message: 'Coupon max uses must be a positive safe whole number',
            },
        },
        // How many times it has been used
        usedCount: {
            type: Number,
            default: 0,
            min: 0,
            set: strictNumberSetter,
            validate: { validator: value => Number.isSafeInteger(value) && value >= 0, message: 'Coupon used count must be a non-negative safe whole number' },
        },
        // Max uses per single user
        maxUsesPerUser: {
            type: Number,
            default: 1,
            min: 1,
            set: strictNumberSetter,
            validate: { validator: value => Number.isSafeInteger(value) && value > 0, message: 'Coupon per-user limit must be a positive safe whole number' },
        },
        // Track which users used it and how many times
        usedBy: [
            {
                user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
                count: {
                    type: Number,
                    default: 1,
                    min: 1,
                    set: strictNumberSetter,
                    validate: { validator: value => Number.isSafeInteger(value) && value > 0, message: 'Coupon usage count must be a positive safe whole number' },
                },
            },
        ],
        // Minimum order amount to apply this coupon (for the applicable products subtotal)
        minOrderAmount: {
            type: Number,
            default: 0,
            min: 0,
            set: strictNumberSetter,
            validate: {
                validator: isExactNonNegativeMoney,
                message: 'Coupon minimum order amount must be finite, safe, non-negative, and exact to cents',
            },
        },
        // Maximum discount amount (caps the discount for percentage type)
        maxDiscountAmount: {
            type: Number,
            default: null, // null = no cap
            min: 0.01,
            set: strictNumberSetter,
            validate: {
                validator: value => value === null || value === undefined || isExactPositiveMoney(value),
                message: 'Coupon maximum discount must be finite, safe, positive, and exact to cents',
            },
        },
        // Validity period
        startDate: {
            type: Date,
            default: Date.now,
        },
        expiryDate: {
            type: Date,
            required: true,
            validate: {
                validator(value) {
                    return !this.startDate || new Date(value) > new Date(this.startDate);
                },
                message: 'Coupon expiry date must be after its start date',
            },
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        description: {
            type: String,
            default: '',
            maxlength: 1000,
        },
    },
    { timestamps: true, optimisticConcurrency: true }
);

// Ensure coupon code is unique per seller
couponSchema.index({ seller: 1, code: 1 }, { unique: true });

// Virtual to check if coupon is currently valid
couponSchema.virtual('isValid').get(function () {
    const now = new Date();
    return (
        this.isActive &&
        now >= this.startDate &&
        now <= this.expiryDate &&
        (this.maxUses === null || this.usedCount < this.maxUses)
    );
});

couponSchema.set('toJSON', { virtuals: true });
couponSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Coupon', couponSchema);
