const mongoose = require('mongoose')

const cartItemSchema = mongoose.Schema({
    product: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true
    },
    qty: {
        type: Number,
        default: 1,
        min: 1
    },
    selectedColor: {
        type: String,
        default: null
    },
    // Flexible options map e.g. { Size: 'L', Color: 'Red', Material: 'Cotton' }
    selectedOptions: {
        type: Map,
        of: String,
        default: undefined,
    },
})

const cartSchema = mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true,
    },
    cartItems: [cartItemSchema],
    // A bounded, server-managed receipt list makes fulfilled-order cleanup
    // idempotent. Stripe may deliver the same webhook more than once and a
    // client may retry COD/Wallet checkout after a lost response.
    fulfilledOrderIds: {
        type: [mongoose.Schema.Types.ObjectId],
        default: [],
        select: false,
    },
    totalCartPrice: {
        type: Number,
        default: 0,
    },
    totalCartCurrency: {
        type: String,
        enum: ['USD', 'PKR', 'EUR', 'GBP'],
        default: 'USD',
    },
})



// To Recalculate totalCartPrice
cartSchema.pre('save', async function (next) {
    try {
        const User = require('./User');
        const { normalizeCurrency, convertAmount } = require('../services/currencyService');
        const { getProductCurrency, getProductEffectivePrice } = require('../services/productPricingService');

        await this.populate('cartItems.product')
        const user = await User.findById(this.user).select('currency').lean();
        const targetCurrency = normalizeCurrency(user?.currency || this.totalCartCurrency || 'USD');

        let subtotal = 0;
        for (const item of this.cartItems) {
            const product = item.product;
            if (!product) continue;

            const price = getProductEffectivePrice(product) * (Number(item.qty) || 1);
            subtotal += await convertAmount(price, getProductCurrency(product, targetCurrency), targetCurrency);
        }

        this.totalCartPrice = Math.round(subtotal * 100) / 100
        this.totalCartCurrency = targetCurrency

        next()
    } catch (err) {
        next(err)
    }
})

module.exports = mongoose.model('Cart', cartSchema)
