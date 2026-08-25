const mongoose = require('mongoose');
const { roundMoney, toMinorUnits } = require('../services/moneyMath');
const { parseStrictFiniteNumber } = require('../services/numericInputService');

const strictNumberSetter = value => {
    if (value === null || value === undefined) return value;
    const parsed = parseStrictFiniteNumber(value);
    return parsed === null ? Number.NaN : parsed;
};

const isFiniteNonNegativeNumber = value => (
    typeof value === 'number' && Number.isFinite(value) && value >= 0
);

const isPositiveSafeInteger = value => Number.isSafeInteger(value) && value > 0;

const isExactNonNegativeMoney = value => {
    if (!isFiniteNonNegativeNumber(value)) return false;
    try {
        return roundMoney(value) === value;
    } catch (_) {
        return false;
    }
};

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
        quantity: {
            type: Number, required: true, min: 1, immutable: true, set: strictNumberSetter,
            validate: { validator: isPositiveSafeInteger, message: 'Return quantity must be a positive safe integer' },
        },
        purchasedQuantity: {
            type: Number, required: true, min: 1, immutable: true, set: strictNumberSetter,
            validate: { validator: isPositiveSafeInteger, message: 'Purchased quantity must be a positive safe integer' },
        },
        // Unit price can be fractional after an exact partial-line allocation;
        // it is informational and must not be forced to cents.
        unitPrice: {
            type: Number, required: true, min: 0, immutable: true, set: strictNumberSetter,
            validate: { validator: isFiniteNonNegativeNumber, message: 'Return unit price must be finite and non-negative' },
        },
        lineSubtotal: {
            type: Number, required: true, min: 0, immutable: true, set: strictNumberSetter,
            validate: { validator: isExactNonNegativeMoney, message: 'Return line subtotal must be finite, safe, and exact to cents' },
        },
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
        // Versioned, buyer-scoped digest of the caller's complete idempotency
        // key. New requests never store or truncate the raw transport key.
        requestKey: {
            type: String,
            unique: true,
            sparse: true,
            index: true,
            immutable: true,
            maxlength: 128,
        },
        // Binds an idempotency key to the exact logical request. A replay with
        // different order/seller/items/reason must fail with 409 instead of
        // returning and re-notifying an unrelated historical return.
        requestFingerprint: {
            type: String,
            immutable: true,
            select: false,
            maxlength: 64,
            validate: {
                validator: value => value === undefined || /^[a-f0-9]{64}$/u.test(value),
                message: 'Return request fingerprint must be a SHA-256 digest',
            },
        },
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
            immutable: true,
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
            itemSubtotal: {
                type: Number, required: true, min: 0, immutable: true, set: strictNumberSetter,
                validate: { validator: isExactNonNegativeMoney, message: 'Return item subtotal must be finite, safe, and exact to cents' },
            },
            taxAmount: {
                type: Number, required: true, min: 0, immutable: true, set: strictNumberSetter,
                validate: { validator: isExactNonNegativeMoney, message: 'Return tax amount must be finite, safe, and exact to cents' },
            },
            shippingAmount: {
                type: Number, required: true, min: 0, immutable: true, set: strictNumberSetter,
                validate: { validator: isExactNonNegativeMoney, message: 'Return shipping amount must be finite, safe, and exact to cents' },
            },
            discountAmount: {
                type: Number, required: true, min: 0, immutable: true, set: strictNumberSetter,
                validate: { validator: isExactNonNegativeMoney, message: 'Return discount amount must be finite, safe, and exact to cents' },
            },
            totalAmount: {
                type: Number, required: true, min: 0, immutable: true, set: strictNumberSetter,
                validate: { validator: isExactNonNegativeMoney, message: 'Return total must be finite, safe, and exact to cents' },
            },
        },
        settlement: {
            attempt: {
                type: Number,
                default: 0,
                min: 0,
                set: strictNumberSetter,
                validate: {
                    validator: value => Number.isSafeInteger(value) && value >= 0,
                    message: 'Return settlement attempt must be a non-negative safe integer',
                },
            },
            // `creating` is a durable external-call boundary. Stripe may have
            // accepted the deterministic Checkout Session request even if the
            // following Mongo reference write failed, so missing references in
            // this state must be recovered rather than treated as never started.
            setupState: {
                type: String,
                enum: ['unknown', 'creating', 'ready', 'closed', 'complete'],
                default: 'unknown',
                index: true,
            },
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
            stripeMode: {
                type: String,
                enum: ['test', 'live', null],
                default: null,
            },
            stripeSetupStartedAt: { type: Date, default: null },
            stripeExpiresAt: { type: Date, default: null },
            clientSurface: {
                type: String,
                enum: ['web', 'mobile'],
                default: 'web',
            },
            stripeCustomerEmail: { type: String, trim: true, maxlength: 320, default: '' },
            stripeSuccessUrl: { type: String, trim: true, maxlength: 2048, default: '' },
            stripeCancelUrl: { type: String, trim: true, maxlength: 2048, default: '' },
            stripeSessionId: { type: String, default: null, index: true, sparse: true },
            stripePaymentIntentId: { type: String, default: null, index: true, sparse: true },
            walletTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction', default: null },
            sellerBalanceTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'SellerBalanceTransaction', default: null },
            settledAt: { type: Date, default: null },
            // Version 1 means this request won the seller-locked, settlement-
            // time allocation of the original seller shipping charge.
            shippingAllocationVersion: {
                type: Number,
                default: 0,
                set: strictNumberSetter,
                validate: {
                    validator: value => value === 0 || value === 1,
                    message: 'Return shipping allocation version must be 0 or 1',
                },
            },
            shippingAllocatedAt: { type: Date, default: null },
            notificationSentAt: { type: Date, default: null },
            failureReason: { type: String, trim: true, maxlength: 500, default: '' },
            riskRefundId: { type: String, default: null, index: true, sparse: true },
            riskRefundStatus: { type: String, trim: true, maxlength: 40, default: '' },
            riskRefundAmountMinor: {
                type: Number,
                default: null,
                min: 0,
                set: strictNumberSetter,
                validate: {
                    validator: value => value === null || (Number.isSafeInteger(value) && value >= 0),
                    message: 'Return safety-refund money must be a non-negative safe integer',
                },
            },
            riskRefundCurrency: {
                type: String,
                enum: ['USD', 'PKR', 'EUR', 'GBP', ''],
                default: '',
            },
            riskRefundedAt: { type: Date, default: null },
        },
        sellerNote: { type: String, trim: true, maxlength: 1000, default: '' },
        buyerCancelledAt: { type: Date, default: null },
    },
    { timestamps: true, optimisticConcurrency: true }
);

returnRequestSchema.pre('validate', function validateFrozenReturnMoney(next) {
    const refund = this.refund || {};
    const moneyValues = [
        refund.itemSubtotal,
        refund.taxAmount,
        refund.shippingAmount,
        refund.discountAmount,
        refund.totalAmount,
    ];
    if (moneyValues.every(isExactNonNegativeMoney)) {
        const itemMinor = toMinorUnits(refund.itemSubtotal);
        const grossMinor = itemMinor
            + toMinorUnits(refund.taxAmount)
            + toMinorUnits(refund.shippingAmount);
        const discountMinor = toMinorUnits(refund.discountAmount);
        const totalMinor = toMinorUnits(refund.totalAmount);
        if (discountMinor > grossMinor || grossMinor - discountMinor !== totalMinor) {
            this.invalidate('refund.totalAmount', 'Return total must reconcile with its frozen components');
        }
        const lineMinor = (this.items || []).reduce((sum, item) => (
            isExactNonNegativeMoney(item?.lineSubtotal)
                ? sum + toMinorUnits(item.lineSubtotal)
                : sum
        ), 0);
        if ((this.items || []).every(item => isExactNonNegativeMoney(item?.lineSubtotal)) && lineMinor !== itemMinor) {
            this.invalidate('refund.itemSubtotal', 'Return item subtotal must equal its frozen line subtotals');
        }
    }
    (this.items || []).forEach((item, index) => {
        if (
            isPositiveSafeInteger(item?.quantity)
            && isPositiveSafeInteger(item?.purchasedQuantity)
            && item.quantity > item.purchasedQuantity
        ) {
            this.invalidate(`items.${index}.quantity`, 'Return quantity cannot exceed purchased quantity');
        }
    });
    const shippingVersion = this.settlement?.shippingAllocationVersion;
    const shippingAllocatedAt = this.settlement?.shippingAllocatedAt;
    if (shippingVersion === 1) {
        if (!isExactNonNegativeMoney(refund.shippingAmount) || refund.shippingAmount <= 0) {
            this.invalidate(
                'settlement.shippingAllocationVersion',
                'A shipping allocation marker requires a positive exact shipping refund',
            );
        }
        if (!(shippingAllocatedAt instanceof Date) || Number.isNaN(shippingAllocatedAt.getTime())) {
            this.invalidate(
                'settlement.shippingAllocatedAt',
                'A shipping allocation marker requires its allocation time',
            );
        }
    } else if (shippingAllocatedAt) {
        this.invalidate(
            'settlement.shippingAllocatedAt',
            'A shipping allocation time requires allocation version 1',
        );
    }
    if (this.settlement?.riskRefundStatus === 'succeeded') {
        const expectedMinor = isExactNonNegativeMoney(refund.totalAmount)
            ? toMinorUnits(refund.totalAmount)
            : null;
        if (
            !/^re_[A-Za-z0-9_]+$/.test(String(this.settlement?.riskRefundId || ''))
            || !Number.isSafeInteger(this.settlement?.riskRefundAmountMinor)
            || this.settlement.riskRefundAmountMinor <= 0
            || this.settlement.riskRefundAmountMinor !== expectedMinor
            || this.settlement?.riskRefundCurrency !== this.currency
            || !(this.settlement?.riskRefundedAt instanceof Date)
            || Number.isNaN(this.settlement.riskRefundedAt.getTime())
        ) {
            this.invalidate(
                'settlement.riskRefundStatus',
                'A completed return safety refund requires exact provider id, money, currency, and time',
            );
        }
    }
    next();
});

returnRequestSchema.index({ seller: 1, status: 1, createdAt: -1 });
returnRequestSchema.index({ buyer: 1, createdAt: -1 });
returnRequestSchema.index({ order: 1, seller: 1, createdAt: -1 });

module.exports = mongoose.model('ReturnRequest', returnRequestSchema);
module.exports.RETURN_STATUSES = RETURN_STATUSES;
