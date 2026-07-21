
const users = require('../models/User')
const Cart = require('../models/Cart');
const Product = require('../models/Product');
const mongoose = require('mongoose');
const { isProductBlocked, publicProductFilter } = require('../services/productModerationService');
const { normalizeCurrency, convertAmount } = require('../services/currencyService');
const { getProductCurrency, getProductEffectivePrice } = require('../services/productPricingService');

// Stable string key for an option set, used to dedupe cart lines per variant combo
const optionsKey = (opts) => {
    if (!opts) return '';
    const obj = opts instanceof Map ? Object.fromEntries(opts) : opts;
    return Object.keys(obj).sort().map(k => `${k}:${obj[k]}`).join('|');
};

async function getUserCurrency(userId, fallback = 'USD') {
    const user = await users.findById(userId).select('currency').lean();
    return normalizeCurrency(user?.currency || fallback);
}

async function buildCartPayload(cart, userId, msg) {
    const currency = await getUserCurrency(userId);
    const items = cart?.cartItems || [];
    let totalCartPrice = 0;

    for (const item of items) {
        const product = item.product;
        if (!product) continue;
        const itemTotal = await convertAmount(
            getProductEffectivePrice(product) * (Number(item.qty) || 1),
            getProductCurrency(product, currency),
            currency
        );
        totalCartPrice += itemTotal;
    }

    return {
        msg,
        cart: items,
        totalCartPrice: Math.round(totalCartPrice * 100) / 100,
        totalCartCurrency: currency,
    };
}

exports.addToCart = async (req, res) => {
    const { id: userId } = req.user
    const { id } = req.params
    const { selectedColor, selectedOptions } = req.body || {}
    const incomingKey = optionsKey(selectedOptions);

    try {
        const product = await Product.findOne(publicProductFilter({ _id: id })).select('_id stock').lean();
        if (!product) {
            return res.status(404).json({ msg: 'Product is not available' });
        }

        const existingCart = await Cart.findOne({ user: userId })

        if (existingCart) {
            const item = existingCart.cartItems.find(item =>
                item.product.equals(id) &&
                item.selectedColor === (selectedColor || null) &&
                optionsKey(item.selectedOptions) === incomingKey
            )

            if (item) {
                await existingCart.populate('cartItems.product')
                return res.status(200).json(await buildCartPayload(existingCart, userId, 'Item already in cart'))
            }

            existingCart.cartItems.push({
                product: id,
                selectedColor: selectedColor || null,
                selectedOptions: selectedOptions || undefined,
            })
            await existingCart.populate('cartItems.product')
            await existingCart.save()
            return res.status(200).json(await buildCartPayload(existingCart, userId, 'Item added to cart'))

        }

        const newCart = new Cart({
            user: userId,
            cartItems: [
                {
                    product: id,
                    selectedColor: selectedColor || null,
                    selectedOptions: selectedOptions || undefined,
                }
            ]
        })
        await newCart.populate('cartItems.product')
        await newCart.save()
        res.status(200).json(await buildCartPayload(newCart, userId, 'Item added to cart'))
    } catch (error) {
        console.error('Error adding to cart:', error.message);
        res.status(500).json({ msg: 'Server error while adding to cart' });
    }
}

exports.mergeGuestCart = async (req, res) => {
    const { id: userId } = req.user;
    const incomingItems = Array.isArray(req.body?.items) ? req.body.items.slice(0, 100) : [];

    try {
        if (incomingItems.length === 0) {
            const existingCart = await Cart.findOne({ user: userId });
            if (!existingCart) {
                return res.status(200).json({
                    msg: 'No guest cart items to merge',
                    cart: [],
                    totalCartPrice: 0,
                    totalCartCurrency: await getUserCurrency(userId),
                });
            }
            await existingCart.populate('cartItems.product');
            return res.status(200).json(await buildCartPayload(existingCart, userId, 'Cart is up to date'));
        }

        const normalized = incomingItems
            .map((item) => ({
                productId: String(item?.productId || item?.product?._id || '').trim(),
                qty: Math.max(1, Math.min(99, Math.floor(Number(item?.qty) || 1))),
                selectedColor: item?.selectedColor ? String(item.selectedColor).slice(0, 100) : null,
                selectedOptions: item?.selectedOptions && typeof item.selectedOptions === 'object'
                    ? Object.fromEntries(
                        Object.entries(item.selectedOptions)
                            .filter(([key, value]) => key && value !== undefined && value !== null)
                            .slice(0, 25)
                            .map(([key, value]) => [String(key).slice(0, 100), String(value).slice(0, 200)])
                    )
                    : undefined,
            }))
            .filter((item) => mongoose.Types.ObjectId.isValid(item.productId));

        const productIds = [...new Set(normalized.map((item) => item.productId))];
        const products = await Product.find(publicProductFilter({ _id: { $in: productIds } }))
            .select('_id stock')
            .lean();
        const productsById = new Map(products.map((product) => [String(product._id), product]));

        let cart = await Cart.findOne({ user: userId });
        if (!cart) cart = new Cart({ user: userId, cartItems: [] });

        for (const item of normalized) {
            const product = productsById.get(item.productId);
            if (!product || Number(product.stock) < 1) continue;

            const itemKey = optionsKey(item.selectedOptions);
            const existingItem = cart.cartItems.find((cartItem) =>
                String(cartItem.product?._id || cartItem.product) === item.productId &&
                (cartItem.selectedColor || null) === item.selectedColor &&
                optionsKey(cartItem.selectedOptions) === itemKey
            );
            const stock = Math.max(1, Number(product.stock) || 1);

            if (existingItem) {
                existingItem.qty = Math.min(stock, (Number(existingItem.qty) || 1) + item.qty);
            } else {
                cart.cartItems.push({
                    product: product._id,
                    qty: Math.min(stock, item.qty),
                    selectedColor: item.selectedColor,
                    selectedOptions: item.selectedOptions,
                });
            }
        }

        await cart.save();
        await cart.populate('cartItems.product');
        return res.status(200).json(await buildCartPayload(cart, userId, 'Guest cart merged'));
    } catch (error) {
        console.error('Error merging guest cart:', error.message);
        return res.status(500).json({ msg: 'Failed to merge guest cart' });
    }
};

exports.getCart = async (req, res) => {
    try {

        const { id: userId } = req.user

        const userCart = await Cart.findOne({ user: userId })
        if (!userCart) return res.status(200).json({ msg: 'No cart found', cart: [], totalCartPrice: 0, totalCartCurrency: await getUserCurrency(userId) })

        await userCart.populate('cartItems.product')

        // Filter out items with null/deleted/blocked products
        const validCartItems = userCart.cartItems.filter(item => item.product !== null && !isProductBlocked(item.product));

        // If items were removed, update the cart
        if (validCartItems.length !== userCart.cartItems.length) {
            userCart.cartItems = validCartItems;
            await userCart.save();
        }

        res.status(200).json(await buildCartPayload(userCart, userId, 'cart fetched successfully'))
    } catch (error) {
        console.error('error while fetching cart:::', error);
        res.status(500).json({ msg: 'Failed to fetch user cart' })
    }
}


exports.qtyIncrement = async (req, res) => {
    const { id } = req.params
    const { id: userId } = req.user

    try {

        const userCart = await Cart.findOne({ user: userId })

        await userCart.populate('cartItems.product')

        // console.log('user cart:::', userCart);
        const cartItem = userCart.cartItems.find(item => item._id.equals(id))
        // console.log('cart to increase qty', cartItem);
        if (cartItem.qty == cartItem.product.stock) return res.status(409).json({ msg: 'You have reached stock limit' })

        cartItem.qty += 1
        // console.log(userCart);

        await userCart.save()
        res.status(200).json(await buildCartPayload(userCart, userId, 'quantity increased'))
    } catch (error) {
        console.error('Error increasing quantity:', error.message);
        res.status(500).json({ msg: 'Failed to increase quantity' });
    }
}



exports.qtyDecrement = async (req, res) => {
    const { id } = req.params
    const { id: userId } = req.user

    try {
        const userCart = await Cart.findOne({ user: userId })

        // console.log('user cart:::', userCart);
        const cartItem = userCart.cartItems.find(item => item._id.equals(id))
        // console.log('cart to increase qty', cartItem);

        if (cartItem.qty == 1) return res.status(401).json({ msg: 'Quantity cannot be less than 1' })
        cartItem.qty -= 1
        // console.log(userCart);
        await userCart.populate('cartItems.product')

        await userCart.save()
        res.status(200).json(await buildCartPayload(userCart, userId, 'quantity decreased'))
    } catch (error) {
        console.error('Error decreasing quantity:', error.message);
        res.status(500).json({ msg: 'Failed to decrease quantity' });

    }
}

exports.removeCartItem = async (req, res) => {
    // console.log(req.params.id);
    const { id } = req.params
    const { id: userId } = req.user

    try {
        let userCart = await Cart.findOne({ user: userId })
        userCart.cartItems = userCart.cartItems.filter(item => {
            const isCartLine = item._id?.equals?.(id);
            const isProduct = item.product?.equals?.(id);
            return !(isCartLine || isProduct);
        })
        // console.log('from remove item', userCart);
        await userCart.populate('cartItems.product')

        await userCart.save()
        res.status(200).json(await buildCartPayload(userCart, userId, 'Item removed from cart'))
    } catch (error) {
        console.error('Error removing cart item:', error.message);
        res.status(500).json({ msg: 'Failed remove cart item' });
    }
}

exports.clearCart = async (req, res) => {
    const { id: userId } = req.user
    // console.log('userCart', userCart);

    try {

        const userCart = await Cart.findOne({ user: userId })
        if (!userCart) return res.status(404).json({ msg: 'cart not found' })
        userCart.cartItems = []
        await userCart.populate('cartItems.product')

        await userCart.save()
        res.status(200).json(await buildCartPayload(userCart, userId, 'cart cleared'))
    } catch (error) {
        console.error('Error clearing cart:', error.message);
        res.status(500).json({ msg: ' Failed to clear cart' });
    }
}
