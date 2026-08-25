const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true
    },
    otp: {
        type: String,
        required: true
    },
    userData: {
        username: String,
        email: String,
        password: String,
        role: String,
        isVerified: Boolean,
        // Direct seller signup freezes the chosen native listing currency at
        // send-OTP time. It is optional only so verification records created
        // before this field existed can finish using the explicit legacy USD
        // fallback in sellerOnboardingCurrencyService.
        productCurrency: { type: String, enum: ['USD', 'PKR', 'EUR', 'GBP'] },
        // Bound email-change OTPs to the seller who requested them. These
        // fields are explicit because Mongoose drops unknown nested fields in
        // strict mode, which previously made every email-change code fail.
        sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        type: { type: String, enum: ['email-change'] }
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 600 // OTP expires after 10 minutes
    }
});

// Index for faster lookups
otpSchema.index({ email: 1, createdAt: 1 });

module.exports = mongoose.model('OTP', otpSchema);
