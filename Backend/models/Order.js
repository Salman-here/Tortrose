const mongoose = require("mongoose");

const orderSchema = mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        guestEmail: { type: String, default: null },
        currency: { type: String, enum: ["USD", "PKR", "EUR", "GBP"], default: "USD" },
        orderId: { type: String, required: true },


        orderItems: [
            {
                productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
                // Snapshot of the product's seller at order time. Used to scope
                // seller dashboards correctly even if the product is later deleted.
                seller: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
                name: { type: String, default: '' },
                image: { type: String },
                price: { type: Number, required: true },
                sourcePrice: { type: Number, default: null },
                sourceCurrency: { type: String, enum: ["USD", "PKR", "EUR", "GBP"], default: null },
                // Verbatim seller-entered price + its currency at order time.
                // Used by dashboards so display in matching currency is exact
                // (avoids USD round-trip rounding drift like 1000 → 1001.36).
                priceOriginal: { type: Number, default: null },
                priceCurrency: { type: String, enum: ["USD", "PKR", "EUR", "GBP"], default: null },
                quantity: { type: Number, required: true },
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
            address: { type: String, required: true },
            city: { type: String, required: true },
            state: { type: String, required: true },
            postalCode: { type: String, required: true },
            country: { type: String, required: true, default: "Pakistan" }
        },

        shippingMethod: {
            name: { type: String, required: true },
            price: { type: Number, required: true },
            estimatedDays: { type: Number, required: true },
            seller: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
        },

        sellerShipping: [
            {
                seller: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
                shippingMethod: {
                    name: { type: String, required: true },
                    price: { type: Number, required: true },
                    estimatedDays: { type: Number, required: true }
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
            subtotal: { type: Number, required: true },
            shippingCost: { type: Number, required: true },
            tax: { type: Number, default: 0.00 },
            couponDiscount: { type: Number, default: 0 },
            totalAmount: { type: Number, required: true }
        },

        appliedCoupons: [
            {
                couponId: { type: mongoose.Schema.Types.ObjectId, ref: "Coupon" },
                code: { type: String },
                discountType: { type: String, enum: ["percentage", "fixed"] },
                discountValue: { type: Number },
                appliedDiscountAmount: { type: Number, default: null },
                currency: { type: String, uppercase: true, trim: true },
                sourceDiscountValue: { type: Number },
                sourceCurrency: { type: String, uppercase: true, trim: true },
                applicableProductIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],
            }
        ],

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
            walletTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction' }
        },

        // Stripe checkout session id — used by webhook handlers (expired/failed) to
        // locate the corresponding awaiting-payment order.
        stripeSessionId: { type: String, default: null, index: true },

        // True for stripe-mode orders that have been created in DB but the buyer
        // has not yet paid. These orders are HIDDEN from seller/user/admin
        // dashboards and listings until payment succeeds via webhook, and are
        // marked `cancelled` if the Stripe session expires or the buyer abandons.
        awaitingPayment: { type: Boolean, default: false, index: true },

        inventoryCommitted: { type: Boolean, default: false, index: true },
        paymentFulfilledAt: { type: Date, default: null, index: true },
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

module.exports = mongoose.model("Order", orderSchema);
