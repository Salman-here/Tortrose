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
            enum: ['pending', 'completed', 'failed', 'cancelled', 'reversed'],
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
            enum: ['stripe_checkout', 'order', 'return_request', 'admin', 'system'],
            required: true,
        },
        referenceId: { type: String, required: true, trim: true, index: true },
        idempotencyKey: { type: String, required: true, unique: true, index: true },
        stripeSessionId: { type: String, default: null, index: true, sparse: true },
        stripePaymentIntentId: { type: String, default: null, index: true, sparse: true },
        failureReason: { type: String, trim: true, maxlength: 500, default: '' },
        metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
        completedAt: { type: Date, default: null },
        notificationSentAt: { type: Date, default: null },
    },
    { timestamps: true }
);

walletTransactionSchema.index({ user: 1, createdAt: -1 });
walletTransactionSchema.index({ user: 1, currency: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);
