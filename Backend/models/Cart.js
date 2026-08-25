const mongoose = require('mongoose')
const { roundMoney } = require('../services/moneyMath')

const cartIntegrityError = (message, code) => {
    const error = new Error(message)
    error.code = code
    error.status = 409
    error.statusCode = 409
    return error
}

const requireCartQuantity = (value) => {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw cartIntegrityError(
            'The cart contains an invalid stored quantity.',
            'CART_QUANTITY_INVALID',
        )
    }
    return value
}

const strictCartQuantitySetter = value => {
    if (value === null || value === undefined) return value
    return typeof value === 'number' ? value : Number.NaN
}

const strictCartMoneySetter = value => {
    if (value === null || value === undefined) return value
    return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
}

const isExactCartMoney = value => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false
    try {
        return roundMoney(value) === value
    } catch (_) {
        return false
    }
}

const cartItemSchema = mongoose.Schema({
    product: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true
    },
    qty: {
        type: Number,
        default: 1,
        min: 1,
        set: strictCartQuantitySetter,
        validate: { validator: Number.isSafeInteger, message: 'Cart quantity must be a safe whole number' }
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
        min: 0,
        set: strictCartMoneySetter,
        validate: {
            validator: isExactCartMoney,
            message: 'Cart total must be finite, safe, non-negative, and exact to cents',
        },
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
        const { isSupportedCurrency, getExchangeRateSnapshot } = require('../services/currencyService');
        const { getProductCurrency, getProductEffectivePrice } = require('../services/productPricingService');
        const { sumMoney } = require('../services/moneyMath');
        const { priceOrderItemLines } = require('../services/orderLinePricingService');

        await this.populate('cartItems.product')
        const user = await User.findById(this.user).select('currency').lean();
        const rawTargetCurrency = user?.currency === null || user?.currency === undefined
            ? 'USD'
            : user.currency
        if (
            typeof rawTargetCurrency !== 'string'
            || !rawTargetCurrency
            || rawTargetCurrency !== rawTargetCurrency.trim().toUpperCase()
            || !isSupportedCurrency(rawTargetCurrency)
        ) {
            throw cartIntegrityError(
                'The stored account currency is invalid.',
                'USER_CURRENCY_INVALID',
            )
        }
        const targetCurrency = rawTargetCurrency

        const nativeLines = this.cartItems.flatMap((item) => {
            const product = item.product;
            if (!product) return [];
            return [{
                sourcePrice: getProductEffectivePrice(product),
                // Currency-less legacy Product.price is canonical USD; buyer
                // display currency must never redefine its stored meaning.
                sourceCurrency: getProductCurrency(product, 'USD'),
                quantity: requireCartQuantity(item.qty),
            }];
        });
        const rateSnapshot = await getExchangeRateSnapshot();
        const pricedLines = priceOrderItemLines({
            items: nativeLines,
            targetCurrency,
            exchangeRates: rateSnapshot.rates,
            exchangeRatesFallback: false,
        });
        const subtotal = sumMoney(pricedLines.map(line => line.lineSubtotal));

        this.totalCartPrice = subtotal
        this.totalCartCurrency = targetCurrency

        next()
    } catch (err) {
        next(err)
    }
})

module.exports = mongoose.model('Cart', cartSchema)
