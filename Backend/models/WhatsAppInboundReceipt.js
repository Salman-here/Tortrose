'use strict';

const mongoose = require('mongoose');

const whatsAppInboundReceiptSchema = new mongoose.Schema({
    instanceName: { type: String, required: true, trim: true },
    messageId: { type: String, required: true, trim: true },
    phone: { type: String, default: '', index: true },
    status: {
        type: String,
        enum: ['processing', 'completed', 'failed'],
        required: true,
        default: 'processing',
        index: true,
    },
    attempts: { type: Number, default: 1 },
    processingToken: { type: String, required: true, select: false },
    processingStartedAt: { type: Date, required: true },
    completedAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
    expiresAt: { type: Date, required: true },
}, { timestamps: true });

whatsAppInboundReceiptSchema.index(
    { instanceName: 1, messageId: 1 },
    { unique: true }
);
whatsAppInboundReceiptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('WhatsAppInboundReceipt', whatsAppInboundReceiptSchema);
