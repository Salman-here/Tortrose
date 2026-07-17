const mongoose = require('mongoose');

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
        amountUSD: { type: Number, required: true, min: 0.01 },
        sourceAmount: { type: Number, required: true, min: 0.01 },
        sourceCurrency: {
            type: String,
            enum: ['USD', 'PKR', 'EUR', 'GBP'],
            required: true,
        },
        referenceType: {
            type: String,
            enum: ['return_request', 'admin', 'system'],
            required: true,
        },
        referenceId: { type: String, required: true, trim: true },
        description: { type: String, trim: true, maxlength: 300, default: '' },
        completedAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

sellerBalanceTransactionSchema.index(
    { seller: 1, type: 1, referenceType: 1, referenceId: 1 },
    { unique: true }
);
sellerBalanceTransactionSchema.index({ seller: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('SellerBalanceTransaction', sellerBalanceTransactionSchema);
