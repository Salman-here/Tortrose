const mongoose = require('mongoose');

/**
 * Persistent in-app notification (one document per recipient per delivery).
 * Used by the admin broadcaster + future event-driven notifications.
 */
const notificationSchema = new mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        title: { type: String, required: true, maxlength: 140 },
        body: { type: String, required: true, maxlength: 1000 },
        // Free-form bucket — used by the bell, mobile inbox, and the admin broadcaster.
        category: {
            type: String,
            enum: ['announcement', 'promo', 'order', 'system', 'seller'],
            default: 'announcement',
            index: true,
        },
        // Optional deep link / route to open when the user taps the notification.
        linkTo: { type: String, default: '' },
        // Source — distinguishes admin broadcasts from auto-generated notifs.
        source: {
            type: String,
            enum: ['admin_broadcast', 'system'],
            default: 'system',
            index: true,
        },
        broadcastJob: { type: mongoose.Schema.Types.ObjectId, ref: 'BroadcastJob', index: true },
        sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        read: { type: Boolean, default: false, index: true },
        readAt: { type: Date },
        // Optional event idempotency key for retry-safe system notifications.
        dedupeKey: { type: String, trim: true, select: false },
    },
    { timestamps: true }
);

notificationSchema.index({ user: 1, read: 1, createdAt: -1 });
notificationSchema.index(
    { dedupeKey: 1 },
    { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } }
);

module.exports = mongoose.model('Notification', notificationSchema);
