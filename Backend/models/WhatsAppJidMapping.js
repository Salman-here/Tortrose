const mongoose = require('mongoose');

const whatsAppJidMappingSchema = new mongoose.Schema({
    phone: { type: String, required: true },
    lidJid: { type: String, required: true },
    instanceType: { type: String, enum: ['main', 'seller'], required: true },
    instanceName: { type: String, default: '' },
    source: { type: String, default: 'webhook' },
    lastSeenAt: { type: Date, default: Date.now },
}, { timestamps: true });

whatsAppJidMappingSchema.index({ phone: 1, instanceType: 1 }, { unique: true });
whatsAppJidMappingSchema.index({ lastSeenAt: 1 });

module.exports = mongoose.model('WhatsAppJidMapping', whatsAppJidMappingSchema);
