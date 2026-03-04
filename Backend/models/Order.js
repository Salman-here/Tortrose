const mongoose = require("mongoose");

const orderSchema = mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        orderId: { type: String, required: true },
        

        orderItems: [
            {
                productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
                name: { type: String, required: true },
                image: { type: String },
                price: { type: Number, required: true },
                quantity: { type: Number, required: true },
                // _id: false 
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

        orderSummary: {
            subtotal: { type: Number, required: true },
            shippingCost: { type: Number, required: true },
            tax: { type: Number, default: 0.00 },
            totalAmount: { type: Number, required: true }
        },

        orderStatus: {
            type: String,
            enum: ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"],
            default: "pending"
        },

        paymentMethod: {
            type: String,
            required: true,
            enum: ["cash_on_delivery", "stripe"],
            default: 'stripe'
        },

        paymentResult: {
            paymentIntentId: String,
            emailAddress: String
        },

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

        instructions: { type: String }
    },
    { timestamps: true }
);





module.exports = mongoose.model("Order", orderSchema);
