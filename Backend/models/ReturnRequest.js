const mongoose = require('mongoose');

const RETURN_STATUSES = [
    'requested',
    'approved',
    'pickup_scheduled',
    'picked_up',
    'in_transit_to_seller',
    'received_by_seller',
    'under_review',
    'accepted_pending_payment',
    'returned',
    'replacement_approved',
    'rejected',
    'cancelled_by_buyer',
];

const returnItemSchema = new mongoose.Schema(
    {
        orderItemId: { type: mongoose.Schema.Types.ObjectId, required: true },
        productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
        name: { type: String, required: true, trim: true, maxlength: 300 },
        image: { type: String, default: '' },
        quantity: { type: Number, required: true, min: 1 },
        purchasedQuantity: { type: Number, required: true, min: 1 },
        unitPrice: { type: Number, required: true, min: 0 },
        lineSubtotal: { type: Number, required: true, min: 0 },
        selectedColor: { type: String, default: null },
        selectedOptions: { type: Map, of: String, default: undefined },
    },
    { _id: false }
);

const statusHistorySchema = new mongoose.Schema(
    {
        status: { type: String, enum: RETURN_STATUSES, required: true },
        note: { type: String, trim: true, maxlength: 1000, default: '' },
        changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        actorRole: {
            type: String,
            enum: ['buyer', 'seller', 'admin', 'system'],
            required: true,
        },
        changedAt: { type: Date, default: Date.now },
    },
    { _id: false }
);

const returnRequestSchema = new mongoose.Schema(
    {
        returnNumber: { type: String, required: true, unique: true, index: true },
        requestKey: { type: String, unique: true, sparse: true, index: true },
        order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
        orderId: { type: String, required: true, index: true },
        buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', default: null },
        storeName: { type: String, trim: true, maxlength: 120, default: '' },
        currency: {
            type: String,
            enum: ['USD', 'PKR', 'EUR', 'GBP'],
            required: true,
        },
        items: { type: [returnItemSchema], required: true, validate: value => value.length > 0 },
        reasonCategory: {
            type: String,
            enum: ['damaged', 'defective', 'wrong_item', 'not_as_described', 'size_or_fit', 'changed_mind', 'other'],
            required: true,
        },
        reasonDetails: { type: String, required: true, trim: true, minlength: 10, maxlength: 1500 },
        status: { type: String, enum: RETURN_STATUSES, default: 'requested', index: true },
        statusHistory: { type: [statusHistorySchema], default: [] },
        requestedAt: { type: Date, default: Date.now },
        requestedNotificationSentAt: { type: Date, default: null },
        notificationKeys: { type: [String], default: [] },
        eligibilityDeadline: { type: Date, required: true, index: true },
        policySnapshot: {
            returnsEnabled: { type: Boolean, required: true },
            returnDuration: { type: Number, required: true, min: 1 },
            refundType: {
                type: String,
                enum: ['full_refund', 'replacement_only', 'store_credit'],
                required: true,
            },
            policyDescription: { type: String, default: '' },
        },
        refund: {
            itemSubtotal: { type: Number, required: true, min: 0 },
            taxAmount: { type: Number, required: true, min: 0 },
            shippingAmount: { type: Number, required: true, min: 0 },
            discountAmount: { type: Number, required: true, min: 0 },
            totalAmount: { type: Number, required: true, min: 0 },
        },
        settlement: {
            attempt: { type: Number, default: 0, min: 0 },
            fundingSource: {
                type: String,
                enum: ['seller_balance', 'card', 'replacement', null],
                default: null,
            },
            status: {
                type: String,
                enum: ['not_started', 'pending_payment', 'completed', 'failed', 'not_required'],
                default: 'not_started',
                index: true,
            },
            stripeSessionId: { type: String, default: null, index: true, sparse: true },
            stripePaymentIntentId: { type: String, default: null, index: true, sparse: true },
            walletTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction', default: null },
            sellerBalanceTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'SellerBalanceTransaction', default: null },
            settledAt: { type: Date, default: null },
            notificationSentAt: { type: Date, default: null },
            failureReason: { type: String, trim: true, maxlength: 500, default: '' },
        },
        sellerNote: { type: String, trim: true, maxlength: 1000, default: '' },
        buyerCancelledAt: { type: Date, default: null },
    },
    { timestamps: true, optimisticConcurrency: true }
);

returnRequestSchema.index({ seller: 1, status: 1, createdAt: -1 });
returnRequestSchema.index({ buyer: 1, createdAt: -1 });
returnRequestSchema.index({ order: 1, seller: 1, createdAt: -1 });

module.exports = mongoose.model('ReturnRequest', returnRequestSchema);
module.exports.RETURN_STATUSES = RETURN_STATUSES;
