const mongoose = require('mongoose');

const sellerPaymentAccountSchema = new mongoose.Schema(
    {
        seller: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            unique: true,
        },
        accountHolderName: { type: String, required: true, trim: true, maxlength: 120 },
        bankName: { type: String, required: true, trim: true, maxlength: 120 },
        accountNumber: { type: String, trim: true, select: false, maxlength: 80 },
        accountNumberLast4: { type: String, trim: true, maxlength: 4 },
        iban: { type: String, trim: true, select: false, maxlength: 80 },
        ibanLast4: { type: String, trim: true, maxlength: 4 },
        swiftCode: { type: String, trim: true, uppercase: true, maxlength: 20, default: '' },
        country: { type: String, trim: true, maxlength: 80, default: '' },
        countryCode: {
            type: String,
            trim: true,
            uppercase: true,
            maxlength: 2,
            match: /^[A-Z]{2}$/,
            default: undefined,
        },
        currency: {
            type: String,
            enum: ['USD', 'PKR', 'EUR', 'GBP'],
            default: 'USD',
        },
        payoutInstructions: { type: String, trim: true, maxlength: 500, default: '' },
        isActive: { type: Boolean, default: true, index: true },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    { timestamps: true }
);

module.exports = mongoose.model('SellerPaymentAccount', sellerPaymentAccountSchema);
