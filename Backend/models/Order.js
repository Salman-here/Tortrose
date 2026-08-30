const mongoose = require("mongoose");
const { roundMoney } = require('../services/moneyMath');
const { parseStrictFiniteNumber } = require('../services/numericInputService');
const { canonicalizeShippingPhone } = require('../services/orderBuyerContactService');

const LONG_PUBLIC_ORDER_ID_PATTERN = /^ORD-\d{13}-[0-9A-F]{6,32}$/;
const SHORT_PUBLIC_ORDER_ID_PATTERN = /^ORD-\d{13}$/;

const strictNumberSetter = value => {
    if (value === null || value === undefined) return value;
    const parsed = parseStrictFiniteNumber(value);
    return parsed === null ? Number.NaN : parsed;
};

const isExactNonNegativeMoney = value => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
    try {
        return roundMoney(value) === value;
    } catch (_) {
        return false;
    }
};

const isNullableExactNonNegativeMoney = value => (
    value === null || value === undefined || isExactNonNegativeMoney(value)
);

const isFiniteNonNegativeNumber = value => (
    typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= Number.MAX_SAFE_INTEGER / 1_000_000
);

const finiteNonNegativeField = ({ required = false, default: defaultValue } = {}) => ({
    type: Number,
    ...(required ? { required: true } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    min: 0,
    set: strictNumberSetter,
    validate: {
        validator: value => (
            (!required && (value === null || value === undefined))
            || isFiniteNonNegativeNumber(value)
        ),
        message: 'Stored informational order amount must be finite, safe, and non-negative',
    },
});

const isPositiveFiniteRate = value => (
    value === null
    || value === undefined
    || (typeof value === 'number' && Number.isFinite(value) && value > 0)
);

const exactMoneyField = ({ required = false, default: defaultValue } = {}) => ({
    type: Number,
    ...(required ? { required: true } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    min: 0,
    set: strictNumberSetter,
    validate: {
        validator: required ? isExactNonNegativeMoney : isNullableExactNonNegativeMoney,
        message: 'Stored order money must be finite, safe, non-negative, and exact to cents',
    },
});

const nullableRateField = defaultValue => ({
    type: Number,
    default: defaultValue,
    set: strictNumberSetter,
    validate: {
        validator: isPositiveFiniteRate,
        message: 'Stored exchange rates must be finite positive numbers',
    },
});

const orderSchema = mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        guestEmail: { type: String, default: null },
        currency: { type: String, enum: ["USD", "PKR", "EUR", "GBP"], default: "USD" },
        // Immutable checkout-time USD rate table. Transaction accounting uses
        // this snapshot so historical revenue and a later full refund cancel
        // exactly even when live FX rates have changed. Catalog/display
        // conversion remains live and is intentionally separate.
        exchangeRateSnapshot: {
            _id: false,
            base: { type: String, enum: ["USD"], default: "USD" },
            rates: {
                _id: false,
                USD: {
                    ...nullableRateField(1),
                    validate: {
                        validator: value => value === 1,
                        message: 'The USD snapshot rate must equal 1',
                    },
                },
                PKR: nullableRateField(null),
                EUR: nullableRateField(null),
                GBP: nullableRateField(null),
            },
            capturedAt: { type: Date, default: null },
            source: { type: String, default: "", maxlength: 80 },
            fallback: { type: Boolean, default: false },
        },
        orderId: {
            type: String,
            required: true,
            validate: {
                validator(value) {
                    if (this.orderIdVersion === 2) return LONG_PUBLIC_ORDER_ID_PATTERN.test(value);
                    if (this.orderIdVersion === 3) return SHORT_PUBLIC_ORDER_ID_PATTERN.test(value);
                    return typeof value === 'string' && value.length > 0;
                },
                message: 'The versioned public order id format is invalid.',
            },
        },
        // Version 2/3 public ids are created only by code that also carries the
        // immutable Mongo _id through payment/provider metadata. Historical
        // rows deliberately remain unversioned until a read-only duplicate
        // preflight proves that they are safe to promote. This lets the
        // database reject every new duplicate without pretending that legacy
        // display ids are already globally unique.
        orderIdVersion: {
            type: Number,
            enum: [2, 3],
            default: null,
            immutable: true,
        },
        // A client-generated key makes retries/double taps return the original
        // checkout instead of creating a second order or charging stock twice.
        checkoutIdempotencyKey: { type: String, default: null, trim: true },


        orderItems: [
            {
                productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
                // Snapshot of the product's seller at order time. Used to scope
                // seller dashboards correctly even if the product is later deleted.
                seller: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
                name: { type: String, default: '' },
                image: { type: String },
                // Converted display unit price can be fractional when an exact
                // buyer-currency line subtotal is divided across many units.
                // `lineSubtotal` is the authoritative exact-cent charge.
                price: finiteNonNegativeField({ required: true }),
                // Authoritative item total in the order currency. FX is applied
                // to the native line (price x quantity) before cent rounding;
                // `price` remains a display-oriented converted unit snapshot.
                lineSubtotal: exactMoneyField({ default: null }),
                sourcePrice: exactMoneyField({ default: null }),
                sourceCurrency: { type: String, enum: ["USD", "PKR", "EUR", "GBP"], default: null },
                sourceLineSubtotal: exactMoneyField({ default: null }),
                // Verbatim seller-entered price + its currency at order time.
                // Used by dashboards so display in matching currency is exact
                // (avoids USD round-trip rounding drift like 1000 → 1001.36).
                priceOriginal: exactMoneyField({ default: null }),
                priceCurrency: { type: String, enum: ["USD", "PKR", "EUR", "GBP"], default: null },
                quantity: {
                    type: Number,
                    required: true,
                    min: 1,
                    set: strictNumberSetter,
                    validate: { validator: value => Number.isSafeInteger(value) && value > 0, message: 'Order quantity must be a positive safe whole number' },
                },
                selectedColor: { type: String, default: null },
                selectedOptions: { type: Map, of: String, default: undefined },
                returnPolicySnapshotVersion: { type: Number, default: 0 },
                returnPolicy: {
                    returnsEnabled: { type: Boolean, default: false },
                    returnDuration: { type: Number, default: 0 },
                    refundType: {
                        type: String,
                        enum: ['none', 'full_refund', 'replacement_only', 'store_credit'],
                        default: 'none'
                    },
                    warrantyEnabled: { type: Boolean, default: false },
                    warrantyDuration: { type: Number, default: 0 },
                    warrantyDescription: { type: String, default: '' },
                    policyDescription: { type: String, default: '' }
                },
            }
        ],

        shippingInfo: {
            fullName: { type: String, required: true },
            email: { type: String, required: true },
            phone: { type: String, required: true },
            phoneE164: {
                type: String,
                validate: {
                    validator: value => value === undefined || /^\+[1-9]\d{7,14}$/.test(value),
                    message: 'Shipping phoneE164 must be a valid international phone number'
                }
            },
            address: { type: String, required: true },
            city: { type: String, required: true },
            state: { type: String, required: true },
            postalCode: { type: String, required: true },
            country: { type: String, required: true },
            countryCode: { type: String, default: '' }
        },

        shippingMethod: {
            name: { type: String, required: true },
            price: exactMoneyField({ required: true }),
            estimatedDays: {
                type: Number,
                required: true,
                min: 1,
                set: strictNumberSetter,
                validate: { validator: value => Number.isSafeInteger(value) && value > 0, message: 'Shipping days must be a positive safe whole number' },
            },
            seller: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
        },

        sellerShipping: [
            {
                seller: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
                shippingMethod: {
                    name: { type: String, required: true },
                    price: exactMoneyField({ required: true }),
                    estimatedDays: {
                        type: Number,
                        required: true,
                        min: 1,
                        set: strictNumberSetter,
                        validate: { validator: value => Number.isSafeInteger(value) && value > 0, message: 'Seller shipping days must be a positive safe whole number' },
                    },
                    // Preserve the seller-configured native shipping amount.
                    // `price` is the exact cent allocation charged in the
                    // buyer's order currency.
                    sourceCost: exactMoneyField({ default: null }),
                    sourceCurrency: {
                        type: String,
                        enum: ["USD", "PKR", "EUR", "GBP"],
                        default: null,
                    }
                }
            }
        ],

        // Each seller owns fulfillment for only their portion of a multi-seller
        // order. Seller dashboards use this status instead of mutating another
        // seller's delivery state.
        sellerFulfillment: [
            {
                seller: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
                status: {
                    type: String,
                    enum: ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"],
                    default: "pending"
                },
                deliveredAt: { type: Date, default: null },
                updatedAt: { type: Date, default: Date.now }
            }
        ],

        // Commerce policies are snapshotted at checkout so a seller cannot
        // shorten a buyer's return window after the purchase.
        sellerPolicies: [
            {
                seller: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
                store: { type: mongoose.Schema.Types.ObjectId, ref: "Store", default: null },
                storeName: { type: String, default: '' },
                paymentPolicy: {
                    type: String,
                    enum: ['online_and_cod', 'advance_only'],
                    default: 'online_and_cod'
                },
                returnPolicy: {
                    returnsEnabled: { type: Boolean, default: false },
                    returnDuration: { type: Number, default: 0 },
                    refundType: {
                        type: String,
                        enum: ['none', 'full_refund', 'replacement_only', 'store_credit'],
                        default: 'none'
                    },
                    warrantyEnabled: { type: Boolean, default: false },
                    warrantyDuration: { type: Number, default: 0 },
                    warrantyDescription: { type: String, default: '' },
                    policyDescription: { type: String, default: '' }
                }
            }
        ],

        orderSummary: {
            subtotal: exactMoneyField({ required: true }),
            shippingCost: exactMoneyField({ required: true }),
            tax: exactMoneyField({ default: 0 }),
            couponDiscount: exactMoneyField({ default: 0 }),
            totalAmount: exactMoneyField({ required: true })
        },

        // Versioned, immutable-in-practice seller ownership of the exact order
        // total. `amountUSDMinor` is allocated across the whole order in one
        // conversion, so independent seller rounding can never create or lose
        // a USD cent. Revenue, returns, and payment reversals all consume this
        // same frozen snapshot.
        sellerSettlementVersion: {
            type: Number,
            default: 0,
            min: 0,
            immutable: true,
            set: strictNumberSetter,
            validate: {
                validator: value => Number.isSafeInteger(value) && value >= 0,
                message: 'Seller settlement version must be a non-negative safe integer',
            },
        },
        sellerSettlement: [
            {
                _id: false,
                seller: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "User",
                    required: true,
                    immutable: true,
                },
                sourceCurrency: {
                    type: String,
                    enum: ["USD", "PKR", "EUR", "GBP"],
                    required: true,
                    immutable: true,
                },
                sourceAmountMinor: {
                    type: Number,
                    required: true,
                    min: 0,
                    immutable: true,
                    set: strictNumberSetter,
                    validate: {
                        validator: Number.isSafeInteger,
                        message: 'Seller settlement source amount must be safe minor units',
                    },
                },
                amountUSDMinor: {
                    type: Number,
                    required: true,
                    min: 0,
                    immutable: true,
                    set: strictNumberSetter,
                    validate: {
                        validator: Number.isSafeInteger,
                        message: 'Seller settlement USD amount must be safe minor units',
                    },
                },
            }
        ],

        appliedCoupons: [
            {
                couponId: { type: mongoose.Schema.Types.ObjectId, ref: "Coupon" },
                // Immutable coupon owner at checkout. Version-1 coupon scopes
                // must stay inside this seller's snapshotted order lines.
                seller: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
                code: { type: String },
                discountType: { type: String, enum: ["percentage", "fixed"] },
                discountValue: {
                    type: Number,
                    min: 0,
                    set: strictNumberSetter,
                    validate: {
                        validator(value) {
                            if (!isFiniteNonNegativeNumber(value)) return false;
                            return this.discountType === 'percentage'
                                ? value <= 100
                                : isExactNonNegativeMoney(value);
                        },
                        message: 'Stored coupon value must be a valid percentage or exact fixed-money amount',
                    },
                },
                appliedDiscountAmount: exactMoneyField({ default: null }),
                currency: { type: String, enum: ["USD", "PKR", "EUR", "GBP"], uppercase: true, trim: true },
                sourceDiscountValue: {
                    type: Number,
                    min: 0,
                    set: strictNumberSetter,
                    validate: {
                        validator(value) {
                            if (!isFiniteNonNegativeNumber(value)) return false;
                            return this.discountType === 'percentage'
                                ? value <= 100
                                : isExactNonNegativeMoney(value);
                        },
                        message: 'Stored source coupon value must be a valid percentage or exact fixed-money amount',
                    },
                },
                sourceCurrency: { type: String, enum: ["USD", "PKR", "EUR", "GBP"], uppercase: true, trim: true },
                applicableProductIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],
                couponTermsFingerprint: { type: String, minlength: 64, maxlength: 64 },
            }
        ],

        // Version 1 means coupon capacity was reserved atomically before the
        // payment attempt. It distinguishes new safe checkouts from legacy
        // orders created before the reservation lifecycle existed.
        couponUsageVersion: {
            type: Number,
            default: 0,
            min: 0,
            set: strictNumberSetter,
            validate: { validator: value => Number.isSafeInteger(value) && value >= 0, message: 'Coupon usage version must be a non-negative safe integer' },
        },

        tracking: {
            tiktokPlaceOrderEventId: { type: String, default: null },
            tiktokPurchaseEventId: { type: String, default: null },
            pageUrl: { type: String, default: '' },
            referrer: { type: String, default: '' },
            ttclid: { type: String, default: '' },
            ttp: { type: String, default: '' },
        },

        orderStatus: {
            type: String,
            enum: ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"],
            default: "pending"
        },

        paymentMethod: {
            type: String,
            required: true,
            enum: ["cash_on_delivery", "stripe", "wallet"],
            default: 'stripe'
        },

        paymentResult: {
            paymentIntentId: String,
            emailAddress: String,
            walletTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction' },
            // A captured legacy payment whose stock can no longer be committed
            // is refunded through a deterministic Stripe request. Persist the
            // external reference before any local cancellation so webhook
            // retries can only recover the refund, never fulfill the order.
            stockRefundId: { type: String, default: null },
            stockRefundStatus: { type: String, default: '' },
            stockRefundAmountMinor: {
                type: Number,
                default: null,
                min: 0,
                set: strictNumberSetter,
                validate: {
                    validator: value => (
                        value === null
                        || value === undefined
                        || (Number.isSafeInteger(value) && value >= 0)
                    ),
                    message: 'Stripe stock refund amount must be safe minor units',
                },
            },
            stockRefundCurrency: {
                type: String,
                enum: ["USD", "PKR", "EUR", "GBP", null],
                uppercase: true,
                trim: true,
                default: null,
            },
            stockRefundAt: { type: Date, default: null },
            failureCode: { type: String, default: '' },
            failureMessage: { type: String, default: '' },
            failureAt: { type: Date, default: null },
        },

        paymentFlow: {
            type: String,
            enum: ['checkout_session', 'payment_sheet'],
            default: 'checkout_session',
            index: true,
        },
        // Durable boundary around Stripe object creation. `creating` means the
        // deterministic Stripe request may already have succeeded even when its
        // ID was not persisted yet, so cancellation must fail closed and replay
        // must recover that same request.
        paymentSetupState: {
            type: String,
            enum: ['unknown', 'not_started', 'creating', 'ready', 'refunding', 'closed', 'complete'],
            default: 'unknown',
            index: true,
        },
        paymentSetupStartedAt: { type: Date, default: null },
        paymentSetupCompletedAt: { type: Date, default: null },
        clientSurface: {
            type: String,
            enum: ['web', 'mobile', 'unknown'],
            default: 'unknown',
        },
        stripeMode: { type: String, enum: ['test', 'live'], default: null },
        stripeCustomerId: { type: String, default: null, index: true },
        stripePaymentIntentId: { type: String, default: null },
        // Freeze every hosted-create parameter that can otherwise change
        // between an ambiguous request and its deterministic replay.
        stripeCheckoutSuccessUrl: { type: String, default: null, maxlength: 2048 },
        stripeCheckoutCancelUrl: { type: String, default: null, maxlength: 2048 },
        paymentExpiresAt: { type: Date, default: null, index: true },
        paymentCancelledAt: { type: Date, default: null },
        checkoutRequestFingerprint: { type: String, default: null, select: false },

        // Stripe checkout session id — used by webhook handlers (expired/failed) to
        // locate the corresponding awaiting-payment order.
        stripeSessionId: { type: String, default: null },

        // True for stripe-mode orders that have been created in DB but the buyer
        // has not yet paid. These orders are HIDDEN from seller/user/admin
        // dashboards and listings until payment succeeds via webhook, and are
        // marked `cancelled` if the Stripe session expires or the buyer abandons.
        awaitingPayment: { type: Boolean, default: false, index: true },

        inventoryCommitted: { type: Boolean, default: false, index: true },
        paymentFulfilledAt: { type: Date, default: null, index: true },
        cartCleanupCompletedAt: { type: Date, default: null },
        paymentProcessingStartedAt: { type: Date, default: null, index: true },
        stripeWebhookEventId: { type: String, default: null },
        returnVersion: { type: Number, default: 0 },

        isPaid: {
            type: Boolean,
            required: true,
            default: false
        },
        paidAt: {
            type: Date
        },
        isDelivered: {
            type: Boolean,
            required: true,
            default: false
        },
        deliveredAt: {
            type: Date
        },

        instructions: { type: String },

        confirmation: {
            token: { type: String, default: null, index: true },
            tokenExpiresAt: { type: Date, default: null },
            confirmedAt: { type: Date, default: null },
            // NOTE: `confirmedVia` is dual-purpose — it tracks the channel/actor for BOTH confirmations
            // and declines. When a buyer declines, confirmedVia still records who initiated the decision
            // (e.g., 'whatsapp' for a WhatsApp decline, 'email' for an email decline). The actual
            // action (confirm vs decline) is determined by checking confirmedAt vs declinedAt.
            // The `decidedVia` field below is more semantically clear for new code.
            confirmedVia: { type: String, enum: ['email', 'whatsapp', 'manual', 'dashboard', 'admin', 'stripe_payment', 'wallet_payment', null], default: null },
            declinedAt: { type: Date, default: null },
            voteChangeCount: { type: Number, default: 0 },
            lockMessageSent: { type: Boolean, default: false },
            // Populated when buyer confirms on WhatsApp then later cancels from their dashboard
            cancelledFromDashboardAt: { type: Date, default: null },
            cancelledFromDashboardNote: { type: String, default: '' },
            // Email send tracking
            emailSentAt: { type: Date, default: null },
            emailSentSuccess: { type: Boolean, default: null }, // null=not attempted, true/false
            emailError: { type: String, default: '' },
            // WhatsApp send tracking
            whatsappSentAt: { type: Date, default: null },
            whatsappSentSuccess: { type: Boolean, default: null },
            whatsappError: { type: String, default: '' },
            // Who confirmed/declined first and when
            decidedAt: { type: Date, default: null },
            decidedVia: { type: String, enum: ['email', 'whatsapp', 'dashboard', 'admin', 'manual', null], default: null },
        }
    },
    { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// The whole array is immutable after insertion as well as each monetary field.
// Legacy backfill is the only exception and opts in explicitly through the
// compare-and-set helper in orderMoneyService.
orderSchema.path('sellerSettlement').immutable(true);

// Every newly persisted order owns an immutable, unambiguous international
// buyer destination. This protects future writers that bypass the two current
// checkout controllers and prevents the schema's historical Pakistan default
// from changing a buyer's country silently.
orderSchema.pre('validate', function freezeBuyerPhoneDestination(next) {
    if (!this.isNew) return next();
    try {
        const snapshot = canonicalizeShippingPhone(this.shippingInfo);
        if (this.shippingInfo.phoneE164 && this.shippingInfo.phoneE164 !== snapshot.e164) {
            const error = new Error('Shipping phone and phoneE164 destinations do not match.');
            error.statusCode = 400;
            error.code = 'SHIPPING_PHONE_MISMATCH';
            return next(error);
        }
        this.shippingInfo.phone = snapshot.e164;
        this.shippingInfo.phoneE164 = snapshot.e164;
        this.shippingInfo.countryCode = snapshot.countryCode;
        return next();
    } catch (error) {
        return next(error);
    }
});

orderSchema.pre('save', function rejectFrozenSettlementMutation(next) {
    if (
        !this.isNew
        && Number(this.sellerSettlementVersion || 0) > 0
        && (
            this.isModified('sellerSettlement')
            || this.isModified('sellerSettlementVersion')
        )
    ) {
        const error = new Error('The frozen seller settlement cannot be changed.');
        error.code = 'SELLER_SETTLEMENT_IMMUTABLE';
        return next(error);
    }
    return next();
});

// Human-friendly label for the admin/seller UI. Example:
//   "Confirmed by buyer via Rozare WhatsApp automation"
//   "Cancelled by buyer via Rozare WhatsApp automation"
//   "Confirmed by buyer via email link"
orderSchema.virtual('confirmationSourceLabel').get(function () {
    const via = this.confirmation?.confirmedVia;
    const confirmed = !!this.confirmation?.confirmedAt;
    const declined = !!this.confirmation?.declinedAt;
    const cancelledFromDash = !!this.confirmation?.cancelledFromDashboardAt;

    // Special case: confirmed then cancelled from email page or account
    if (cancelledFromDash && confirmed) {
        const note = this.confirmation?.cancelledFromDashboardNote || '';
        const cancelledFrom = note.includes('account') || note.includes('dashboard')
            ? 'account' : 'email';
        const confirmedChannel = via === 'whatsapp' ? 'WhatsApp' : (via === 'email' ? 'email' : via);
        return `Cancelled by buyer from ${cancelledFrom} (was confirmed via ${confirmedChannel})`;
    }

    if (!via) return '';
    const action = confirmed ? 'Confirmed' : declined ? 'Cancelled' : '';
    if (!action) return '';
    if (via === 'whatsapp')  return `${action} by buyer via Rozare WhatsApp automation`;
    if (via === 'email')     return `${action} by buyer via email confirmation link`;
    if (via === 'manual')    return `${action} manually`;
    if (via === 'dashboard') return `${action} by buyer from dashboard`;
    if (via === 'admin')     return `${action} by admin`;
    return `${action} by buyer`;
});

orderSchema.index({ awaitingPayment: 1, orderStatus: 1, 'orderItems.seller': 1, createdAt: -1 });
orderSchema.index({ awaitingPayment: 1, orderStatus: 1, 'orderItems.productId': 1, createdAt: -1 });
orderSchema.index({ 'sellerFulfillment.seller': 1, 'sellerFulfillment.status': 1, createdAt: -1 });
orderSchema.index(
    { orderId: 1 },
    { name: 'idx_order_public_id_lookup' }
);
orderSchema.index(
    { orderId: 1, orderIdVersion: 1 },
    {
        unique: true,
        partialFilterExpression: { orderIdVersion: 2 },
        name: 'uniq_modern_order_public_id',
    }
);
orderSchema.index(
    { orderId: 1, orderIdVersion: 1 },
    {
        unique: true,
        partialFilterExpression: { orderIdVersion: 3 },
        name: 'uniq_short_order_public_id',
    }
);
orderSchema.index(
    { stripeSessionId: 1 },
    {
        unique: true,
        partialFilterExpression: { stripeSessionId: { $type: 'string' } },
        name: 'uniq_order_stripe_session',
    }
);
orderSchema.index(
    { stripePaymentIntentId: 1 },
    {
        unique: true,
        partialFilterExpression: { stripePaymentIntentId: { $type: 'string' } },
        name: 'uniq_order_stripe_payment_intent',
    }
);
orderSchema.index(
    { user: 1, checkoutIdempotencyKey: 1 },
    {
        unique: true,
        partialFilterExpression: { checkoutIdempotencyKey: { $type: 'string' } },
        name: 'uniq_user_checkout_attempt',
    }
);

module.exports = mongoose.model("Order", orderSchema);
