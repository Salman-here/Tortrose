const mongoose = require('mongoose');

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
        amount: { type: Number, required: true, min: 0.01 },
        currency: {
            type: String,
            enum: ['USD', 'PKR', 'EUR', 'GBP'],
            required: true,
            index: true,
        },
        balanceAfter: { type: Number, default: null },
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
