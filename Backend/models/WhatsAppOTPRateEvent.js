const mongoose = require('mongoose');

/**
 * Durable send-quota event. OTP proofs are intentionally deleted on success,
 * so they cannot also be the source of truth for a one-hour send limit.
 */
const whatsAppOtpRateEventSchema = new mongoose.Schema({
    scope: { type: String, required: true },
    slot: { type: Number, required: true },
    token: { type: String, required: true },
    number: { type: String, default: '', index: true },
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
}, { versionKey: false });

whatsAppOtpRateEventSchema.index({ scope: 1, slot: 1 }, { unique: true });
whatsAppOtpRateEventSchema.index({ number: 1, createdAt: -1 });
whatsAppOtpRateEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('WhatsAppOTPRateEvent', whatsAppOtpRateEventSchema);
