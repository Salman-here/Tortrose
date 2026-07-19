const mongoose = require('mongoose');

const claimSchema = new mongoose.Schema({
    seller: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    claimedAt: { type: Date, required: true },
    source: {
        type: String,
        enum: ['coupon', 'legacy'],
        default: 'coupon',
    },
    checkoutSessionId: { type: String, default: null },
}, { _id: false });

const reservationSchema = new mongoose.Schema({
    seller: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    token: { type: String, required: true },
    checkoutSessionId: { type: String, default: null },
    createdAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
}, { _id: false });

const subscriptionPromotionSchema = new mongoose.Schema({
    code: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true,
    },
    name: { type: String, required: true },
    discountPercent: { type: Number, required: true },
    maxRedemptions: { type: Number, required: true },
    claims: { type: [claimSchema], default: [] },
    reservations: { type: [reservationSchema], default: [] },
    legacyMigrationCompletedAt: { type: Date, default: null },
}, { timestamps: true });

subscriptionPromotionSchema.index({ 'reservations.expiresAt': 1 });

module.exports = mongoose.model('SubscriptionPromotion', subscriptionPromotionSchema);
