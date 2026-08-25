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

const sellerBalanceTransactionSchema = new mongoose.Schema(
    {
        seller: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        type: {
            type: String,
            enum: ['return_refund', 'admin_adjustment', 'reversal'],
            required: true,
            index: true,
        },
        direction: {
            type: String,
            enum: ['debit', 'credit'],
            default: 'debit',
        },
        status: {
            type: String,
            enum: ['reserved', 'completed', 'reversed'],
            default: 'completed',
            index: true,
        },
        // A foreign-currency allocation can be positive in source minor units
        // while rounding below one USD cent. Preserve that source liability
        // instead of silently losing it.
        amountUSD: {
            type: Number,
            required: true,
            min: 0,
            set: strictMoneySetter,
            validate: {
                validator: isExactNonNegativeMoney,
                message: 'Seller balance USD amount must be finite, safe, and exact to cents',
            },
        },
        sourceAmount: {
            type: Number,
            required: true,
            min: 0,
            set: strictMoneySetter,
            validate: [
                {
                    validator: isExactNonNegativeMoney,
                    message: 'Seller balance source amount must be finite, safe, and exact to cents',
                },
                {
                    validator(value) {
                    // Exact cross-currency reallocation can move one USD cent
                    // without moving a source cent (or vice versa). Permit a
                    // zero component, but never a completely empty ledger row.
                        return value > 0 || this.amountUSD > 0;
                    },
                    message: 'A seller balance transaction must move source or USD money',
                },
            ],
        },
        sourceCurrency: {
            type: String,
            enum: ['USD', 'PKR', 'EUR', 'GBP'],
            required: true,
        },
        referenceType: {
            type: String,
            enum: ['return_request', 'stripe_payment', 'admin', 'system'],
            required: true,
        },
        referenceId: { type: String, required: true, trim: true },
        order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
        stripeEventId: { type: String, default: null, index: true },
        stripeEventType: { type: String, default: '' },
        stripeChargeId: { type: String, default: null, index: true },
        stripePaymentIntentId: { type: String, default: null, index: true },
        description: { type: String, trim: true, maxlength: 300, default: '' },
        completedAt: { type: Date, default: Date.now },
        metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    { timestamps: true }
);

sellerBalanceTransactionSchema.index(
    { seller: 1, type: 1, referenceType: 1, referenceId: 1 },
    { unique: true }
);
sellerBalanceTransactionSchema.index({ seller: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('SellerBalanceTransaction', sellerBalanceTransactionSchema);
