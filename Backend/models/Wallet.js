const mongoose = require('mongoose');
const { roundMoney } = require('../services/moneyMath');
const { parseStrictFiniteNumber } = require('../services/numericInputService');

const strictMoneySetter = value => {
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

const walletBalanceField = () => ({
    type: Number,
    default: 0,
    min: 0,
    set: strictMoneySetter,
    validate: {
        validator: isExactNonNegativeMoney,
        message: 'Wallet balance must be finite, safe, non-negative, and exact to cents',
    },
});

const walletSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            unique: true,
            index: true,
        },
        balances: {
            USD: walletBalanceField(),
            PKR: walletBalanceField(),
            EUR: walletBalanceField(),
            GBP: walletBalanceField(),
        },
        status: {
            type: String,
            enum: ['active', 'locked'],
            default: 'active',
            index: true,
        },
        lockedReason: { type: String, trim: true, maxlength: 300, default: '' },
        lockSource: {
            type: String,
            enum: ['payment_risk', 'manual', 'system'],
            default: null,
            index: true,
        },
    },
    { timestamps: true, optimisticConcurrency: true }
);

module.exports = mongoose.model('Wallet', walletSchema);
