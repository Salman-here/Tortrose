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

const walletTransactionSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        wallet: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Wallet',
            default: null,
            index: true,
        },
        type: {
            type: String,
            enum: ['top_up', 'order_payment', 'return_refund', 'reversal', 'admin_adjustment'],
            required: true,
            index: true,
        },
        direction: {
            type: String,
            enum: ['credit', 'debit'],
            required: true,
        },
        status: {
            type: String,
            enum: ['pending', 'completed', 'failed', 'cancelled', 'expired', 'reversed'],
            default: 'pending',
            index: true,
        },
        amount: {
            type: Number,
            required: true,
            min: 0.01,
            set: strictMoneySetter,
            validate: {
                validator(value) {
                    return isExactNonNegativeMoney(value) && value > 0;
                },
                message: 'Wallet transaction amount must be finite, safe, positive, and exact to cents',
            },
        },
        currency: {
            type: String,
            enum: ['USD', 'PKR', 'EUR', 'GBP'],
            required: true,
            index: true,
        },
        balanceAfter: {
            type: Number,
            default: null,
            set: strictMoneySetter,
            validate: {
                validator(value) {
                    return value === null || value === undefined || isExactNonNegativeMoney(value);
                },
                message: 'Wallet transaction balance must be finite, safe, non-negative, and exact to cents',
            },
        },
        description: { type: String, trim: true, maxlength: 300, default: '' },
        referenceType: {
            type: String,
            enum: ['stripe_checkout', 'stripe_payment_intent', 'stripe_dispute', 'stripe_refund', 'order', 'return_request', 'admin', 'system'],
            required: true,
        },
        referenceId: { type: String, required: true, trim: true, index: true },
        idempotencyKey: { type: String, required: true, unique: true, index: true },
        stripeSessionId: { type: String, default: null },
        stripePaymentIntentId: { type: String, default: null },
        stripeCustomerId: { type: String, default: null, index: true },
        stripeChargeId: { type: String, default: null, index: true },
        stripeMode: { type: String, enum: ['test', 'live'], default: null },
        paymentFlow: { type: String, enum: ['checkout_session', 'payment_sheet'], default: 'checkout_session' },
        // Durable boundary around Stripe object creation. `creating` means the
        // deterministic Stripe request may already have succeeded even if the
        // returned ID was not persisted, so cleanup must recover instead of
        // assuming that no external payment object exists.
        paymentSetupState: {
            type: String,
            enum: ['unknown', 'not_started', 'creating', 'ready', 'closed', 'complete'],
            default: 'unknown',
            index: true,
        },
        paymentSetupStartedAt: { type: Date, default: null },
        paymentSetupCompletedAt: { type: Date, default: null },
        clientSurface: { type: String, enum: ['web', 'mobile', 'unknown'], default: 'unknown' },
        paymentExpiresAt: { type: Date, default: null, index: true },
        stripeWebhookEventId: { type: String, default: null },
        failureReason: { type: String, trim: true, maxlength: 500, default: '' },
        metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
        completedAt: { type: Date, default: null },
        notificationSentAt: { type: Date, default: null },
    },
    { timestamps: true }
);

walletTransactionSchema.pre('validate', function validateTopUpSetupState(next) {
    if (this.type !== 'top_up') return next();

    const hasSession = typeof this.stripeSessionId === 'string' && this.stripeSessionId.length > 0;
    const hasIntent = typeof this.stripePaymentIntentId === 'string' && this.stripePaymentIntentId.length > 0;
    const isHostedRiskBlocked = (
        this.paymentFlow === 'checkout_session'
        && this.status === 'reversed'
        && this.paymentSetupState === 'closed'
        && this.metadata?.paymentRiskBlockedBeforeCompletion === true
    );
    if (
        hasSession
        && hasIntent
        && !(this.paymentFlow === 'checkout_session' && (this.status === 'completed' || isHostedRiskBlocked))
    ) {
        this.invalidate(
            'paymentSetupState',
            'A Wallet top-up cannot reference both a Checkout Session and a PaymentIntent.'
        );
    }
    if (this.paymentFlow === 'payment_sheet' && hasSession) {
        this.invalidate('stripeSessionId', 'PaymentSheet top-ups cannot reference a Checkout Session.');
    }
    if (
        this.paymentFlow === 'checkout_session'
        && hasIntent
        && this.status !== 'completed'
        && !isHostedRiskBlocked
    ) {
        // A completed hosted Checkout stores its underlying PaymentIntent for
        // refund/dispute reconciliation. Before settlement, only the Session
        // is an authoritative setup reference.
        this.invalidate('stripePaymentIntentId', 'Hosted top-ups cannot attach a PaymentIntent before settlement.');
    }
    if (this.paymentSetupState === 'not_started' && (hasSession || hasIntent)) {
        this.invalidate('paymentSetupState', 'A not-started Wallet top-up cannot have a Stripe reference.');
    }
    if (this.paymentSetupState === 'ready') {
        const hasFlowReference = this.paymentFlow === 'payment_sheet' ? hasIntent : hasSession;
        if (!hasFlowReference) {
            this.invalidate('paymentSetupState', 'A ready Wallet top-up requires its Stripe reference.');
        }
    }
    if (this.paymentSetupState === 'complete' && this.status !== 'completed') {
        this.invalidate('paymentSetupState', 'Only a completed Wallet top-up can have complete setup state.');
    }
    return next();
});

walletTransactionSchema.index({ user: 1, createdAt: -1 });
walletTransactionSchema.index({ user: 1, currency: 1, status: 1, createdAt: -1 });
walletTransactionSchema.index(
    { stripeSessionId: 1 },
    {
        unique: true,
        partialFilterExpression: { stripeSessionId: { $type: 'string' } },
        name: 'uniq_wallet_stripe_session',
    }
);
walletTransactionSchema.index(
    { stripePaymentIntentId: 1 },
    {
        unique: true,
        partialFilterExpression: { stripePaymentIntentId: { $type: 'string' } },
        name: 'uniq_wallet_stripe_payment_intent',
    }
);

module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);
