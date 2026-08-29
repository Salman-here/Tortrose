const mongoose = require('mongoose');

const whatsAppTestNumberSchema = new mongoose.Schema({
    number: {
        type: String,
        required: true,
        unique: true,
        trim: true,
    },
    slot: {
        type: Number,
        required: true,
        unique: true,
        min: 1,
        max: 50,
    },
    label: { type: String, default: '', maxlength: 120 },
    isActive: { type: Boolean, default: true, index: true },
    provisionedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lastUsedAt: { type: Date, default: null },
}, { timestamps: true });

whatsAppTestNumberSchema.index({ isActive: 1, slot: 1 });

module.exports = mongoose.model('WhatsAppTestNumber', whatsAppTestNumberSchema);
