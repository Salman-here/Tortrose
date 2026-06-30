const mongoose = require('mongoose');

const sellerWithdrawalRequestSchema = new mongoose.Schema(
    {
        seller: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        amount: {
            type: Number,
            required: true,
            min: 0.01,
        },
        currency: {
            type: String,
            enum: ['USD', 'PKR', 'EUR', 'GBP'],
            default: 'USD',
        },
        requestedAmount: { type: Number, default: 0 },
        requestedCurrency: {
            type: String,
            enum: ['USD', 'PKR', 'EUR', 'GBP'],
            default: 'USD',
        },
        status: {
            type: String,
            enum: ['pending', 'approved', 'processing', 'paid', 'rejected', 'cancelled'],
            default: 'pending',
            index: true,
        },
        paymentAccountSnapshot: {
            accountHolderName: { type: String, default: '' },
            bankName: { type: String, default: '' },
            accountNumberLast4: { type: String, default: '' },
            ibanLast4: { type: String, default: '' },
            swiftCode: { type: String, default: '' },
            country: { type: String, default: '' },
            currency: { type: String, default: 'USD' },
        },
        sellerNote: { type: String, trim: true, maxlength: 500, default: '' },
        adminNote: { type: String, trim: true, maxlength: 1000, default: '' },
        processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        processedAt: { type: Date },
    },
    { timestamps: true }
);

sellerWithdrawalRequestSchema.index({ seller: 1, status: 1, createdAt: -1 });
sellerWithdrawalRequestSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('SellerWithdrawalRequest', sellerWithdrawalRequestSchema);
