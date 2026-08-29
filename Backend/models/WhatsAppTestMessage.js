const mongoose = require('mongoose');

const whatsAppTestMessageSchema = new mongoose.Schema({
    number: { type: String, required: true, index: true, trim: true },
    direction: {
        type: String,
        enum: ['outbound', 'inbound'],
        required: true,
        index: true,
    },
    instanceName: { type: String, default: '', maxlength: 120, index: true },
    instanceType: { type: String, default: '', maxlength: 40 },
    messageType: {
        type: String,
        enum: ['text', 'media', 'poll', 'list', 'buttons'],
        required: true,
        index: true,
    },
    text: { type: String, default: '', maxlength: 12000 },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    messageId: { type: String, required: true, unique: true, index: true, maxlength: 160 },
    sourceMessage: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'WhatsAppTestMessage',
        default: null,
        index: true,
    },
    actionId: { type: String, default: '', maxlength: 300 },
    actionLabel: { type: String, default: '', maxlength: 300 },
    processingStatus: {
        type: String,
        enum: ['captured', 'processing', 'processed', 'failed'],
        default: 'captured',
        index: true,
    },
    processingError: { type: String, default: '', maxlength: 1200 },
    processedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    expiresAt: {
        type: Date,
        default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        index: { expires: 0 },
    },
}, { timestamps: true });

whatsAppTestMessageSchema.index({ number: 1, createdAt: -1 });
whatsAppTestMessageSchema.index({ direction: 1, createdAt: -1 });

module.exports = mongoose.model('WhatsAppTestMessage', whatsAppTestMessageSchema);
