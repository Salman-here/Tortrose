
const users = require('../models/User')
const Cart = require('../models/Cart');
const Product = require('../models/Product');
const mongoose = require('mongoose');
const { isProductBlocked, publicProductFilter } = require('../services/productModerationService');
const { isSupportedCurrency, getExchangeRateSnapshot } = require('../services/currencyService');
const { getProductCurrency, getProductEffectivePrice } = require('../services/productPricingService');
const { sumMoney } = require('../services/moneyMath');
const { priceOrderItemLines } = require('../services/orderLinePricingService');
const { parsePositiveSafeInteger } = require('../services/numericInputService');

const cartDataIntegrityError = (message, code = 'CART_DATA_INVALID') => {
    const error = new Error(message);
    error.code = code;
    error.status = 409;
    error.statusCode = 409;
    return error;
};

const requireCanonicalCurrency = (value, code) => {
    if (
        typeof value !== 'string'
        || !value
        || value !== value.trim().toUpperCase()
        || !isSupportedCurrency(value)
    ) {
        throw cartDataIntegrityError('The stored account currency is invalid.', code);
    }
    return value;
};

const requireStoredCartQuantity = (value) => {
    if (value === null || value === undefined) return 1;
    if (!Number.isSafeInteger(value) || value < 1) {
        throw cartDataIntegrityError(
            'The cart has an invalid stored quantity. Remove the affected item and add it again.',
            'CART_QUANTITY_INVALID',
        );
    }
    return value;
};

const requireStoredProductStock = (value) => {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw cartDataIntegrityError(
            'A product has invalid stored stock and cannot be added to the cart.',
            'PRODUCT_STOCK_INVALID',
        );
    }
    return value;
};

const assertPersistedCartQuantities = async (cart, { ignoreIdentifiers = [] } = {}) => {
    if (!cart?._id) return;
    const rawCart = await Cart.collection.findOne(
        { _id: cart._id },
        { projection: { cartItems: 1 } },
    );
    if (!rawCart || !Array.isArray(rawCart.cartItems)) {
        throw cartDataIntegrityError('The cart has invalid stored items.');
    }
    const ignored = new Set(ignoreIdentifiers.map(value => String(value)));
    rawCart.cartItems.forEach((item) => {
        if (ignored.has(String(item?._id)) || ignored.has(String(item?.product))) return;
        requireStoredCartQuantity(item?.qty);
    });
};

const sendCartError = (res, error, fallbackMessage) => res
    .status(error?.statusCode || 500)
    .json({
        msg: error?.statusCode ? error.message : fallbackMessage,
        ...(error?.code ? { code: error.code } : {}),
    });

// Stable string key for an option set, used to dedupe cart lines per variant combo
const optionsKey = (opts) => {
    if (!opts) return '';
    const obj = opts instanceof Map ? Object.fromEntries(opts) : opts;
    return Object.keys(obj).sort().map(k => `${k}:${obj[k]}`).join('|');
};

async function getUserCurrency(userId, fallback = 'USD') {
    const user = await users.findById(userId).select('currency').lean();
    const rawCurrency = user?.currency === null || user?.currency === undefined
        ? fallback
        : user.currency;
    return requireCanonicalCurrency(rawCurrency, 'USER_CURRENCY_INVALID');
}

async function buildCartPayload(cart, userId, msg) {
    const items = cart?.cartItems;
    if (!Array.isArray(items)) {
        throw cartDataIntegrityError('The cart has invalid stored items.');
    }
    const currency = await getUserCurrency(userId);
    const nativeLines = items.flatMap((item) => {
        const product = item.product;
        if (!product) return [];
        return [{
            sourcePrice: getProductEffectivePrice(product),
            // Pre-native-currency products were stored canonically in USD.
            sourceCurrency: getProductCurrency(product, 'USD'),
            quantity: requireStoredCartQuantity(item.qty),
        }];
    });
    const rateSnapshot = await getExchangeRateSnapshot();
    const pricedLines = priceOrderItemLines({
        items: nativeLines,
        targetCurrency: currency,
        exchangeRates: rateSnapshot.rates,
        // Cart totals are presentation snapshots. Checkout separately requires
        // trusted live rates for every cross-currency monetary write.
        exchangeRatesFallback: false,
    });
    const totalCartPrice = sumMoney(pricedLines.map(line => line.lineSubtotal));

    return {
        msg,
        cart: items,
        totalCartPrice,
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
        if (requireStoredProductStock(product.stock) < 1) {
            return res.status(409).json({ msg: 'Product is out of stock' });
        }

        const existingCart = await Cart.findOne({ user: userId })

        if (existingCart) {
            await assertPersistedCartQuantities(existingCart);
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
        sendCartError(res, error, 'Server error while adding to cart');
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
            await assertPersistedCartQuantities(existingCart);
            await existingCart.populate('cartItems.product');
            return res.status(200).json(await buildCartPayload(existingCart, userId, 'Cart is up to date'));
        }

        const invalidQuantity = incomingItems.find(item => (
            parsePositiveSafeInteger(item?.qty, { fallback: 1 }) === null
        ));
        if (invalidQuantity) {
            return res.status(400).json({ msg: 'Cart quantity must be a positive safe whole number.' });
        }

        const normalized = incomingItems
            .map((item) => ({
                productId: String(item?.productId || item?.product?._id || '').trim(),
                qty: Math.min(99, parsePositiveSafeInteger(item?.qty, { fallback: 1 })),
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
        products.forEach(product => requireStoredProductStock(product.stock));
        const productsById = new Map(products.map((product) => [String(product._id), product]));

        let cart = await Cart.findOne({ user: userId });
        if (cart) {
            await assertPersistedCartQuantities(cart);
        } else {
            cart = new Cart({ user: userId, cartItems: [] });
        }

        for (const item of normalized) {
            const product = productsById.get(item.productId);
            if (!product || product.stock < 1) continue;

            const itemKey = optionsKey(item.selectedOptions);
            const existingItem = cart.cartItems.find((cartItem) =>
                String(cartItem.product?._id || cartItem.product) === item.productId &&
                (cartItem.selectedColor || null) === item.selectedColor &&
                optionsKey(cartItem.selectedOptions) === itemKey
            );
            const stock = product.stock;

            if (existingItem) {
                const existingQuantity = requireStoredCartQuantity(existingItem.qty);
                const combinedQuantity = existingQuantity + item.qty;
                if (!Number.isSafeInteger(combinedQuantity)) {
                    throw cartDataIntegrityError(
                        'The cart quantity is outside the supported range.',
                        'CART_QUANTITY_INVALID',
                    );
                }
                existingItem.qty = Math.min(stock, combinedQuantity);
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
        return sendCartError(res, error, 'Failed to merge guest cart');
    }
};

exports.getCart = async (req, res) => {
    try {

        const { id: userId } = req.user

        const userCart = await Cart.findOne({ user: userId })
        if (!userCart) return res.status(200).json({ msg: 'No cart found', cart: [], totalCartPrice: 0, totalCartCurrency: await getUserCurrency(userId) })

        await assertPersistedCartQuantities(userCart)
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
        sendCartError(res, error, 'Failed to fetch user cart')
    }
}


exports.qtyIncrement = async (req, res) => {
    const { id } = req.params
    const { id: userId } = req.user

    try {

        const userCart = await Cart.findOne({ user: userId })

        if (!userCart) {
            return res.status(404).json({ msg: 'cart not found' })
        }

        await assertPersistedCartQuantities(userCart)
        await userCart.populate('cartItems.product')

        // console.log('user cart:::', userCart);
        const cartItem = userCart.cartItems.find(item => item._id.equals(id))
        if (!cartItem) {
            return res.status(404).json({ msg: 'Cart item not found' })
        }
        if (!cartItem.product || isProductBlocked(cartItem.product)) {
            return res.status(404).json({ msg: 'Product is not available' })
        }
        // console.log('cart to increase qty', cartItem);
        const stock = requireStoredProductStock(cartItem.product.stock)
        const quantity = requireStoredCartQuantity(cartItem.qty)
        if (stock < 1) return res.status(409).json({ msg: 'Product is out of stock' })
        if (quantity >= stock) return res.status(409).json({ msg: 'You have reached stock limit' })

        cartItem.qty = quantity + 1
        // console.log(userCart);

        await userCart.save()
        res.status(200).json(await buildCartPayload(userCart, userId, 'quantity increased'))
    } catch (error) {
        console.error('Error increasing quantity:', error.message);
        sendCartError(res, error, 'Failed to increase quantity');
    }
}



exports.qtyDecrement = async (req, res) => {
    const { id } = req.params
    const { id: userId } = req.user

    try {
        const userCart = await Cart.findOne({ user: userId })

        if (!userCart) {
            return res.status(404).json({ msg: 'cart not found' })
        }

        await assertPersistedCartQuantities(userCart)
        // console.log('user cart:::', userCart);
        const cartItem = userCart.cartItems.find(item => item._id.equals(id))
        if (!cartItem) {
            return res.status(404).json({ msg: 'Cart item not found' })
        }
        // console.log('cart to increase qty', cartItem);

        const quantity = requireStoredCartQuantity(cartItem.qty)
        if (quantity <= 1) return res.status(409).json({ msg: 'Quantity cannot be less than 1' })
        cartItem.qty = quantity - 1
        // console.log(userCart);
        await userCart.populate('cartItems.product')

        await userCart.save()
        res.status(200).json(await buildCartPayload(userCart, userId, 'quantity decreased'))
    } catch (error) {
        console.error('Error decreasing quantity:', error.message);
        sendCartError(res, error, 'Failed to decrease quantity');

    }
}

exports.removeCartItem = async (req, res) => {
    // console.log(req.params.id);
    const { id } = req.params
    const { id: userId } = req.user

    try {
        let userCart = await Cart.findOne({ user: userId })
        if (!userCart) {
            return res.status(404).json({ msg: 'cart not found' })
        }
        // Removing the affected line is a safe recovery path for a corrupt
        // quantity. Every other persisted line must still validate so this
        // operation cannot silently repair unrelated data through hydration.
        await assertPersistedCartQuantities(userCart, { ignoreIdentifiers: [id] })
        const matchingItem = userCart.cartItems.find(item => {
            const isCartLine = item._id?.equals?.(id);
            const isProduct = item.product?.equals?.(id);
            return isCartLine || isProduct;
        });
        if (!matchingItem) {
            return res.status(404).json({ msg: 'Cart item not found' })
        }
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
        sendCartError(res, error, 'Failed remove cart item');
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
        sendCartError(res, error, 'Failed to clear cart');
    }
}

exports.__private = {
    buildCartPayload,
    getUserCurrency,
    requireStoredCartQuantity,
    requireStoredProductStock,
};
