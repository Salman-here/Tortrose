const mongoose = require('mongoose');

const aiChatDailyUsageSchema = new mongoose.Schema({
    // A deterministic per-day subject key makes MongoDB's built-in _id index
    // the concurrency boundary; enforcement does not depend on a later index migration.
    _id: { type: String, required: true },
    subjectType: { type: String, enum: ['user', 'guest'], required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    ipHash: { type: String, default: null },
    role: { type: String, required: true },
    date: { type: String, required: true },
    messageCount: { type: Number, default: 0, min: 0 },
    requestReceipts: {
        type: [{
            _id: false,
            keyHash: { type: String, required: true },
            contentFingerprint: { type: String, required: true },
            consumedAt: { type: Date, default: Date.now },
        }],
        default: [],
    },
    expiresAt: { type: Date, required: true },
}, { timestamps: true });

aiChatDailyUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AIChatDailyUsage', aiChatDailyUsageSchema);
