const mongoose = require('mongoose');

const sellerSettlementLockSchema = new mongoose.Schema(
    {
        seller: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            unique: true,
            index: true,
        },
        version: { type: Number, default: 0 },
    },
    { timestamps: true }
);

module.exports = mongoose.model('SellerSettlementLock', sellerSettlementLockSchema);
