const mongoose = require('mongoose');

const complaintSchema = new mongoose.Schema({
    // Reports may be submitted before sign-in. Authenticated reporters remain
    // linked to their account; anonymous reports are still rate limited and
    // retain only the moderation snapshot needed for review.
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    category: {
        type: String,
        enum: [
            'product_issue',
            'order_issue',
            'delivery',
            'refund',
            'seller_complaint',
            'website_bug',
            'suggestion',
            'ai_response',
            'review_report',
            'store_report',
            'other'
        ],
        required: true
    },
    subject: { type: String, required: true, maxlength: 200 },
    message: { type: String, required: true, maxlength: 2000 },
    status: {
        type: String,
        enum: ['open', 'in_progress', 'resolved', 'closed'],
        default: 'open'
    },
    priority: {
        type: String,
        enum: ['low', 'medium', 'high', 'urgent'],
        default: 'medium'
    },
    adminResponse: { type: String, default: '' },
    relatedOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    relatedProduct: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    report: {
        kind: {
            type: String,
            enum: ['ai_response', 'product', 'review', 'store', 'seller'],
        },
        reason: {
            type: String,
            enum: ['inappropriate', 'harmful', 'misleading', 'spam', 'illegal', 'other'],
        },
        details: { type: String, maxlength: 1000, default: '' },
        sourceId: { type: String, maxlength: 200, default: '' },
        conversationId: { type: mongoose.Schema.Types.ObjectId, default: null },
        messageId: { type: mongoose.Schema.Types.ObjectId, default: null },
        contentSnapshot: { type: String, maxlength: 4000, default: '' },
        targetUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        relatedReview: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreReview', default: null },
        relatedStore: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', default: null },
        reporterType: { type: String, enum: ['account', 'anonymous'], default: 'account' },
    },
}, { timestamps: true });

complaintSchema.index({ user: 1, createdAt: -1 });
complaintSchema.index({ category: 1, status: 1 });
complaintSchema.index({ 'report.kind': 1, 'report.sourceId': 1, createdAt: -1 });
complaintSchema.index({ 'report.targetUser': 1, status: 1 });

module.exports = mongoose.model('Complaint', complaintSchema);
