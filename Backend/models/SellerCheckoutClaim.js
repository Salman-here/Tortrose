const mongoose = require('mongoose');

/**
 * One short-lived Checkout creation lease per seller and billing flow.
 *
 * Stripe idempotency keys only deduplicate requests carrying the same key. This
 * database lease chooses that key atomically before Stripe is called, so two
 * app instances cannot create two separately payable Checkout Sessions.
 */
const sellerCheckoutClaimSchema = new mongoose.Schema({
    seller: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    flow: {
        type: String,
        enum: ['subscription', 'subdomain'],
        required: true,
    },
    requestFingerprint: { type: String, required: true },
    token: { type: String, required: true },
    sessionId: { type: String, default: '' },
    sessionUrl: { type: String, default: '' },
    expiresAt: { type: Date, required: true },
}, {
    timestamps: true,
    versionKey: false,
});

sellerCheckoutClaimSchema.index({ seller: 1, flow: 1 }, { unique: true });
sellerCheckoutClaimSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('SellerCheckoutClaim', sellerCheckoutClaimSchema);
