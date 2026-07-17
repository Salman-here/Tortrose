const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            unique: true,
            index: true,
        },
        balances: {
            USD: { type: Number, default: 0, min: 0 },
            PKR: { type: Number, default: 0, min: 0 },
            EUR: { type: Number, default: 0, min: 0 },
            GBP: { type: Number, default: 0, min: 0 },
        },
        status: {
            type: String,
            enum: ['active', 'locked'],
            default: 'active',
            index: true,
        },
        lockedReason: { type: String, trim: true, maxlength: 300, default: '' },
    },
    { timestamps: true, optimisticConcurrency: true }
);

module.exports = mongoose.model('Wallet', walletSchema);
