const mongoose = require('mongoose');

const sellerAdRequestSchema = new mongoose.Schema(
    {
        seller: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        store: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Store',
            default: null,
            index: true,
        },
        products: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
        }],
        requestType: {
            type: String,
            enum: ['start', 'update', 'stop'],
            default: 'start',
            index: true,
        },
        status: {
            type: String,
            enum: ['pending', 'approved', 'rejected'],
            default: 'pending',
            index: true,
        },
        active: {
            type: Boolean,
            default: false,
            index: true,
        },
        channels: {
            tiktok: { type: Boolean, default: true },
            meta: { type: Boolean, default: false },
        },
        sellerNote: {
            type: String,
            trim: true,
            maxlength: 500,
            default: '',
        },
        adminNote: {
            type: String,
            trim: true,
            maxlength: 1000,
            default: '',
        },
        reviewedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
        reviewedAt: {
            type: Date,
            default: null,
        },
    },
    { timestamps: true }
);

sellerAdRequestSchema.index({ seller: 1, status: 1, createdAt: -1 });
sellerAdRequestSchema.index({ seller: 1, active: 1, updatedAt: -1 });
sellerAdRequestSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('SellerAdRequest', sellerAdRequestSchema);
