const mongoose = require('mongoose');

/**
 * Admin-authored broadcast job. The dispatcher polls for due jobs (`status: 'scheduled'`
 * and `nextRunAt <= now`), fans them out into Notification docs + Expo pushes, then
 * either marks them `sent` (one-shot) or computes the next `nextRunAt` (recurring).
 */
const broadcastJobSchema = new mongoose.Schema(
    {
        title: { type: String, required: true, maxlength: 140 },
        body: { type: String, required: true, maxlength: 1000 },
        category: {
            type: String,
            enum: ['announcement', 'promo', 'order', 'system', 'seller'],
            default: 'announcement',
        },
        linkTo: { type: String, default: '' },

        // Delivery channels — at least one must be selected.
        channels: {
            type: [String],
            enum: ['inapp', 'push', 'email', 'whatsapp'],
            default: ['inapp', 'push'],
            validate: {
                validator: (v) => Array.isArray(v) && v.length > 0,
                message: 'At least one notification channel must be selected.',
            },
        },

        // Targeting — combine `audience` with optional explicit user IDs.
        // 'all_users'   = role === 'user'
        // 'all_sellers' = role === 'seller'
        // 'both'        = role in ['user','seller']
        // 'specific'    = only userIds[]
        audience: {
            type: String,
            enum: ['all_users', 'all_sellers', 'both', 'specific'],
            default: 'all_users',
        },
        userIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

        // Schedule
        scheduleType: {
            type: String,
            enum: ['immediate', 'one_time', 'recurring'],
            default: 'immediate',
        },
        // For 'recurring': how often to repeat after the first run.
        recurrence: {
            type: String,
            enum: ['none', 'daily', 'weekly', 'monthly'],
            default: 'none',
        },
        // Preserve the intended calendar day for monthly schedules. For
        // example, a January 31 schedule runs on February 28/29 and then
        // returns to March 31 instead of permanently drifting to the 28th.
        recurrenceAnchorDay: {
            type: Number,
            min: 1,
            max: 31,
            default: null,
            validate: {
                validator: (value) => value == null || Number.isInteger(value),
                message: 'recurrenceAnchorDay must be a whole calendar day.',
            },
        },
        nextRunAt: { type: Date, index: true },
        // Optional stop date for recurring jobs; null = forever (until cancelled).
        endsAt: { type: Date, default: null },

        status: {
            type: String,
            enum: ['scheduled', 'sending', 'sent', 'cancelled', 'failed'],
            default: 'scheduled',
            index: true,
        },
        lastRunAt: { type: Date },
        runCount: { type: Number, min: 0, default: 0 },
        lastError: { type: String, default: '' },
        // A fencing lease lets another worker recover a crashed `sending` job
        // without allowing the stale worker to finalize over the replacement.
        leaseToken: { type: String, default: '', select: false },
        leaseAcquiredAt: { type: Date, default: null },
        leaseExpiresAt: { type: Date, default: null },
        leaseRecoveryCount: { type: Number, min: 0, default: 0 },
        // Per-run delivery stats (sum across runs for recurring).
        stats: {
            recipients: { type: Number, default: 0 },
            pushSent: { type: Number, default: 0 },
            emailSent: { type: Number, default: 0 },
            whatsappSent: { type: Number, default: 0 },
        },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { timestamps: true }
);

broadcastJobSchema.index({ status: 1, nextRunAt: 1 });
broadcastJobSchema.index({ status: 1, leaseExpiresAt: 1 });

module.exports = mongoose.model('BroadcastJob', broadcastJobSchema);
