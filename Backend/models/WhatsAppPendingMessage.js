const mongoose = require('mongoose');

const whatsAppPendingMessageSchema = new mongoose.Schema({
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
    orderId: { type: String, default: '', index: true }, // human-readable ORD-xxxx
    confirmationToken: { type: String, default: 'n/a' }, // mirror of order.confirmation.token
    dedupeKey: { type: String, default: null, unique: true, sparse: true, index: true },

    // 'confirmation' = COD confirm/cancel poll (Yes/No buttons)
    // 'info'         = post-payment buyer notification (text only, no buttons)
    // 'custom_info'  = durable order-owned transactional text
    // 'generic_info' = durable current-user text with no mutable Order dependency
    messageType: { type: String, enum: ['confirmation', 'info', 'custom_info', 'generic_info'], default: 'confirmation', index: true },
    messageBody: { type: String, default: '', maxlength: 4000 },
    // Frozen interactive payloads copied from the notification outbox. Queue
    // retries parse these strings instead of rebuilding financial text from a
    // later Order read.
    interactiveButtonsPayloadJson: { type: String, default: '', maxlength: 20000, immutable: true },
    interactiveListPayloadJson: { type: String, default: '', maxlength: 20000, immutable: true },

    phone: { type: String, required: true, index: true }, // normalized E.164 digits, e.g. 9230012345678
    buyerName: { type: String, default: '' },

    // Evolution API artifacts
    summaryMessageId: { type: String, default: '' },
    pollMessageId: { type: String, default: '', index: true },

    status: {
        type: String,
        enum: ['queued', 'sending', 'sent', 'voted_yes', 'voted_no', 'failed', 'failed_invalid_number', 'expired'],
        default: 'queued',
        index: true,
    },

    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: '' },

    // A database lease makes `sending` recoverable after a process restart.
    // The lease token also prevents a worker whose lease expired while it was
    // talking to Evolution from overwriting a later worker's state.
    leaseToken: { type: String, default: null, maxlength: 80 },
    leaseOwner: { type: String, default: '', maxlength: 120 },
    leaseExpiresAt: { type: Date, default: null, index: true },

    sentAt: { type: Date, default: null },
    repliedAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: () => new Date() }, // for queue scheduling
}, { timestamps: true });

whatsAppPendingMessageSchema.pre('validate', function validateMessageOwner(next) {
    const orderOwned = ['confirmation', 'info', 'custom_info'].includes(this.messageType);
    if (orderOwned && (!this.order || !String(this.orderId || '').trim())) {
        this.invalidate('order', 'Order-owned WhatsApp jobs require an order identity');
    }
    if (this.messageType === 'generic_info' && (this.order || String(this.orderId || '').trim())) {
        this.invalidate('order', 'Generic WhatsApp jobs cannot claim an order owner');
    }
    if (
        ['custom_info', 'generic_info'].includes(this.messageType)
        && (!this.messageBody || this.messageBody !== this.messageBody.trim())
    ) {
        this.invalidate('messageBody', 'Durable text WhatsApp jobs require a normalized message snapshot');
    }
    next();
});

whatsAppPendingMessageSchema.index({ status: 1, nextAttemptAt: 1, leaseExpiresAt: 1 });

module.exports = mongoose.model('WhatsAppPendingMessage', whatsAppPendingMessageSchema);
