// const { default: mongoose } = require('mongoose');
const Cart = require('../models/Cart');
const Order = require('../models/Order');
const Product = require('../models/Product')
const { stripe } = require('../config/stripe');
const TaxConfig = require('../models/TaxConfig');
const { calculateTax } = require('./taxController');
const { recordCouponUsage } = require('./couponController');
const { sendEmail } = require('./mailController');
const { orderConfirmationEmail, orderStatusUpdateEmail, newOrderSellerEmail, buyerOrderConfirmationRequestEmail } = require('../utils/emailTemplates');
const { generateConfirmationToken } = require('./orderConfirmationController');
const { sellerHasWhatsAppVerify } = require('./subscriptionController');
const { enqueueOrderConfirmation } = require('../services/whatsapp/queue');
const WhatsAppConfig = require('../models/WhatsAppConfig');
const { configKeyFor } = require('../services/whatsapp/gatewayMode');
const User = require('../models/User');
const { notifySeller } = require('../services/whatsapp/sellerNotificationService');
const sellerTemplates = require('../services/whatsapp/sellerMessageTemplates');
const { trackOrderEvent } = require('../services/tiktokEventsApi');
const { publicProductFilter } = require('../services/productModerationService');
const { CURRENCIES, normalizeCurrency, convertAmount } = require('../services/currencyService');
const { getProductCurrency, getProductEffectivePrice } = require('../services/productPricingService');
const { isStoreVisibleToBuyer, normalizeBuyerLocation } = require('../services/storeVisibilityService');
const { formatItemOptionsText, orderItemName, toPlainOptions } = require('../utils/orderPresentation');

const toId = (value) => value?.toString?.() || String(value || '');
const optionsKey = (opts) => {
    const plain = toPlainOptions(opts);
    return Object.keys(plain)
        .filter(key => plain[key])
        .sort()
        .map(key => `${key}:${plain[key]}`)
        .join('|');
};
const STRIPE_SUPPORTED_CURRENCIES = new Set(
    [
        ...Object.keys(CURRENCIES),
        ...String(process.env.STRIPE_SUPPORTED_CURRENCIES || '')
        .split(',')
        .map(code => normalizeCurrency(code)),
    ]
);
const STRIPE_ZERO_DECIMAL_CURRENCIES = new Set([
    'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
    'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

const toStripeMinorUnits = (amount, currency) => {
    const value = Math.max(0, Number(amount) || 0);
    return STRIPE_ZERO_DECIMAL_CURRENCIES.has(String(currency || '').toUpperCase())
        ? Math.round(value)
        : Math.round(value * 100);
};

const getSellerProductIds = async (sellerId) => {
    const ids = await Product.find({ seller: sellerId }).distinct('_id');
    return ids.map(toId);
};

// True if any orderItem belongs to this seller (snapshot first, fallback to live product list).
const itemBelongsToSeller = (item, sellerId, sellerProductIds) => {
    if (item.seller && toId(item.seller) === toId(sellerId)) return true;
    return sellerProductIds.includes(toId(item.productId));
};

const orderHasSellerProduct = (order, sellerProductIds, sellerId) =>
    (order.orderItems || []).some(item => itemBelongsToSeller(item, sellerId, sellerProductIds));

// Build a seller-scoped view of an order:
//  - only this seller's items
//  - only this seller's shipping line
//  - proportional tax share
//  - coupon discount allocated only to this seller's products
const buildSellerOrderView = (order, sellerProductIds, sellerId) => {
    const sellerOrderItems = (order.orderItems || []).filter(item =>
        itemBelongsToSeller(item, sellerId, sellerProductIds)
    );

    const sellerSubtotal = sellerOrderItems.reduce((sum, item) =>
        sum + ((Number(item.price) || 0) * (Number(item.quantity) || 0)), 0
    );

    const sellerShippingInfo = (order.sellerShipping || []).find(
        ss => toId(ss.seller) === toId(sellerId)
    );
    const sellerShipping = Number(sellerShippingInfo?.shippingMethod?.price) || 0;

    const summary = order.orderSummary || {};
    const totalOrderValue = Number(summary.subtotal) || 0;
    const sellerProportion = totalOrderValue > 0 ? sellerSubtotal / totalOrderValue : 0;
    const sellerTax = (Number(summary.tax) || 0) * sellerProportion;

    // Coupon discount allocated to ONLY this seller's items (by product id).
    const sellerItemIds = new Set(sellerOrderItems.map(it => toId(it.productId)));
    let sellerCouponDiscount = 0;
    (order.appliedCoupons || []).forEach(c => {
        const couponItemIds = (c.applicableProductIds || []).map(toId).filter(pid => sellerItemIds.has(pid));
        if (couponItemIds.length === 0) return;
        // Subtotal of seller items that this coupon applies to
        const applicableSubtotal = sellerOrderItems
            .filter(it => couponItemIds.includes(toId(it.productId)))
            .reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 0), 0);
        if (applicableSubtotal <= 0) return;
        if (c.discountType === 'percentage') {
            sellerCouponDiscount += (applicableSubtotal * (Number(c.discountValue) || 0)) / 100;
        } else {
            // Fixed amount — pro-rate across all items the coupon covers globally.
            const allCouponItems = (order.orderItems || []).filter(it =>
                (c.applicableProductIds || []).map(toId).includes(toId(it.productId))
            );
            const allCouponSubtotal = allCouponItems.reduce(
                (s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 0), 0
            );
            if (allCouponSubtotal > 0) {
                sellerCouponDiscount += (Number(c.discountValue) || 0) * (applicableSubtotal / allCouponSubtotal);
            }
        }
    });

    const sellerTotal = sellerSubtotal + sellerShipping + sellerTax - sellerCouponDiscount;

    const obj = order.toObject();
    return {
        ...obj,
        orderItems: sellerOrderItems,
        // Strip other sellers' shipping selections from the seller's view
        sellerShipping: sellerShippingInfo ? [sellerShippingInfo] : [],
        shippingMethod: sellerShippingInfo
            ? { ...sellerShippingInfo.shippingMethod, seller: sellerId }
            : obj.shippingMethod,
        orderSummary: {
            subtotal: Math.round(sellerSubtotal * 100) / 100,
            shippingCost: Math.round(sellerShipping * 100) / 100,
            tax: Math.round(sellerTax * 100) / 100,
            couponDiscount: Math.round(sellerCouponDiscount * 100) / 100,
            totalAmount: Math.round(sellerTotal * 100) / 100,
            _originalTotal: summary.totalAmount
        }
    };
};

const getSellerScopedOrders = async (query, sellerId, sort = null) => {
    const sellerProductIds = await getSellerProductIds(sellerId);

    // Match either by snapshot seller (new orders) OR by current product ownership (legacy).
    const sellerScope = sellerProductIds.length > 0
        ? { $or: [{ 'orderItems.seller': sellerId }, { 'orderItems.productId': { $in: sellerProductIds } }] }
        : { 'orderItems.seller': sellerId };

    const dbQuery = { ...query, ...sellerScope };
    const finder = Order.find(dbQuery);
    if (sort) finder.sort(sort);
    const orders = await finder;
    return orders.map(order => buildSellerOrderView(order, sellerProductIds, sellerId));
};

// Enqueue WhatsApp confirmation if admin connected AND any seller in the order has the bonus
const maybeEnqueueWhatsAppConfirmation = async (order, productItems) => {
    try {
        if (!order?.confirmation?.token) {
            console.warn(`[order] WhatsApp skip for ${order?.orderId}: no confirmation token`);
            return;
        }
        const cfg = await WhatsAppConfig.findOne({ singletonKey: configKeyFor('main') });
        if (!cfg || cfg.status !== 'connected') {
            // WhatsApp not connected — track it on the order
            await Order.updateOne({ _id: order._id }, {
                $set: {
                    'confirmation.whatsappSentAt': new Date(),
                    'confirmation.whatsappSentSuccess': false,
                    'confirmation.whatsappError': cfg ? `WhatsApp status: ${cfg.status} (not connected)` : 'WhatsApp not configured',
                }
            });
            console.warn(`[order] WhatsApp skip for ${order.orderId}: not connected (status: ${cfg?.status || 'no config'})`);
            return;
        }

        const sellerIds = [...new Set((productItems || []).map(p => p.seller?.toString()).filter(Boolean))];
        let entitled = false;
        for (const sid of sellerIds) {
            if (await sellerHasWhatsAppVerify(sid)) { entitled = true; break; }
        }
        if (!entitled) {
            // No seller has the WhatsApp bonus — track it
            await Order.updateOne({ _id: order._id }, {
                $set: {
                    'confirmation.whatsappSentAt': new Date(),
                    'confirmation.whatsappSentSuccess': false,
                    'confirmation.whatsappError': 'No seller in this order has the WhatsApp verification bonus enabled',
                }
            });
            console.warn(`[order] WhatsApp skip for ${order.orderId}: no seller has WhatsApp bonus`);
            return;
        }

        const result = await enqueueOrderConfirmation(order);
        if (!result) {
            await Order.updateOne({ _id: order._id }, {
                $set: {
                    'confirmation.whatsappSentAt': new Date(),
                    'confirmation.whatsappSentSuccess': false,
                    'confirmation.whatsappError': 'Failed to enqueue — possibly invalid phone number',
                }
            });
            console.warn(`[order] WhatsApp enqueue returned null for ${order.orderId}`);
            return;
        }
        console.log(`[order] WhatsApp confirmation enqueued for ${order.orderId}`);
    } catch (err) {
        console.error('maybeEnqueueWhatsAppConfirmation:', err.message);
        // Track the error on the order
        try {
            await Order.updateOne({ _id: order._id }, {
                $set: {
                    'confirmation.whatsappSentAt': new Date(),
                    'confirmation.whatsappSentSuccess': false,
                    'confirmation.whatsappError': `Enqueue error: ${err.message}`,
                }
            });
        } catch (trackErr) {
            console.error('Failed to track WA enqueue error:', trackErr.message);
        }
    }
};


exports.placeOrder = async (req, res) => {
    const { order } = req.body;
    // console.log(order);

    const userId = req.user?.id || null;

    try {
        if (
            !order ||
            !order.orderItems ||
            !Array.isArray(order.orderItems) ||
            order.orderItems.length === 0
        ) {
            return res.status(400).json({ msg: "Order must have at least one item" });
        }

        if (
            !order.shippingInfo ||
            !order.paymentMethod ||
            !order.orderSummary ||
            !order.shippingMethod
        ) {
            return res.status(400).json({ msg: "Missing required order details" });
        }

        // console.log(order.orderItems);

        const orderUser = userId ? await User.findById(userId).select('currency').lean() : null;
        const orderCurrency = normalizeCurrency(order.currency || orderUser?.currency || 'USD');

        const productIds = order.orderItems.map(item => item.id)
        // console.log(productIds);
        // return
        const orderItems = await Product.find(publicProductFilter({ _id: { $in: productIds } }))
        const uniqueProductIds = [...new Set(productIds.map(toId).filter(Boolean))];
        if (orderItems.length !== uniqueProductIds.length) {
            return res.status(400).json({ msg: 'One or more products in this order are no longer available.' });
        }
        const productById = new Map(orderItems.map(product => [toId(product._id), product]));
        const sellerIdsInOrder = [...new Set(orderItems.map(product => toId(product.seller)).filter(Boolean))];
        if (sellerIdsInOrder.length > 0) {
            const Store = require('../models/Store');
            const stores = await Store.find({ seller: { $in: sellerIdsInOrder }, isActive: true }).select('seller storeName visibility');
            const storeBySeller = new Map(stores.map(store => [toId(store.seller), store]));
            const buyerLocation = normalizeBuyerLocation({
                ...(order.buyerLocation || {}),
                country: order.buyerLocation?.country || order.shippingInfo?.country,
                region: order.buyerLocation?.region || order.shippingInfo?.state,
                city: order.buyerLocation?.city || order.shippingInfo?.city,
                town: order.buyerLocation?.town,
                lat: order.buyerLocation?.lat,
                lng: order.buyerLocation?.lng,
            });
            for (const sellerId of sellerIdsInOrder) {
                const store = storeBySeller.get(sellerId);
                if (!store || !isStoreVisibleToBuyer(store, buyerLocation)) {
                    return res.status(400).json({
                        msg: 'One or more products in this order are not available in your selected delivery area.',
                    });
                }
            }
        }

        const normalizedOrderItems = await Promise.all(order.orderItems.map(async (item) => {
            const product = productById.get(toId(item.id));
            if (!product) return null;
            const quantity = Math.max(1, Number(item.quantity) || 1);
            if (quantity > product.stock) {
                const err = new Error(`Only ${product.stock} unit${product.stock !== 1 ? 's' : ''} of "${product.name}" are available.`);
                err.statusCode = 400;
                throw err;
            }
            const sourceCurrency = getProductCurrency(product, orderCurrency);
            const sourcePrice = getProductEffectivePrice(product);
            const orderPrice = await convertAmount(sourcePrice, sourceCurrency, orderCurrency);
            return {
                productId: product._id,
                seller: product.seller || null,
                name: product.name,
                image: product.image,
                price: orderPrice,
                sourcePrice,
                sourceCurrency,
                priceOriginal: sourcePrice,
                priceCurrency: sourceCurrency,
                quantity,
                selectedColor: item.selectedColor || null,
                selectedOptions: item.selectedOptions || undefined,
            };
        }));

        // Calculate subtotal from current product records in the order currency.
        const subtotal = normalizedOrderItems.reduce((acc, item) => {
            return acc + item.price * item.quantity
        }, 0)

        // Calculate total shipping cost from all sellers
        let shippingCost = 0;
        if (order.sellerShipping && Array.isArray(order.sellerShipping) && order.sellerShipping.length > 0) {
            // Sum up shipping costs from all sellers
            shippingCost = order.sellerShipping.reduce((sum, sellerShip) => {
                return sum + (sellerShip.shippingMethod.price || 0);
            }, 0);
        } else {
            // Fallback to single shipping method (backward compatibility)
            shippingCost = order.shippingMethod.price || 0;
        }

        // Fetch tax configuration and calculate tax
        let tax = 0;
        const taxConfig = await TaxConfig.findOne({ isActive: true });
        if (taxConfig) {
            tax = calculateTax(subtotal, taxConfig);
        }

        // Calculate coupon discount from frontend
        const couponDiscount = order.orderSummary?.couponDiscount || 0;

        // Final total
        const subtotalRounded = Math.round(subtotal * 100) / 100;
        const shippingCostRounded = Math.round(shippingCost * 100) / 100;
        const taxRounded = Math.round(tax * 100) / 100;
        const couponDiscountRounded = Math.round(Number(couponDiscount || 0) * 100) / 100;
        const totalAmount = Math.max(0, Math.round((subtotalRounded + shippingCostRounded + taxRounded - couponDiscountRounded) * 100) / 100);
        // console.log("cartItems::::", cartItems);


        const newOrder = new Order({
            ...(userId ? { user: userId } : {}),
            guestEmail: !userId ? order.shippingInfo.email : null,
            currency: orderCurrency,
            orderId: `ORD-${Date.now()}`,

            orderItems: normalizedOrderItems,

            shippingInfo: {
                fullName: order.shippingInfo.fullName,
                email: order.shippingInfo.email,
                phone: order.shippingInfo.phone,
                address: order.shippingInfo.address,
                city: order.shippingInfo.city,
                state: order.shippingInfo.state,
                postalCode: order.shippingInfo.postalCode,
                country: order.shippingInfo.country,
            },

            shippingMethod: {
                name: order.shippingMethod.name,
                price: order.shippingMethod.price,
                estimatedDays: order.shippingMethod.estimatedDays,
                seller: order.shippingMethod.seller || null
            },

            orderSummary: {
                subtotal: subtotalRounded,
                shippingCost: shippingCostRounded,
                tax: taxRounded,
                couponDiscount: couponDiscountRounded,
                totalAmount: totalAmount,
            },

            appliedCoupons: order.appliedCoupons || [],

            tracking: {
                tiktokPlaceOrderEventId: order.tracking?.tiktokPlaceOrderEventId || null,
                tiktokPurchaseEventId: order.tracking?.tiktokPurchaseEventId || null,
                pageUrl: order.tracking?.pageUrl || '',
                referrer: order.tracking?.referrer || '',
                ttclid: order.tracking?.ttclid || '',
                ttp: order.tracking?.ttp || '',
            },

            // ✅ Schema expects just string ("stripe" | "cash_on_delivery")
            paymentMethod: order.paymentMethod,
        });



        // Add seller shipping info if provided (for multi-seller orders)
        if (order.sellerShipping && Array.isArray(order.sellerShipping)) {
            newOrder.sellerShipping = order.sellerShipping;
        }

        if (order.instructions && order.instructions !== '') newOrder.instructions = order.instructions

        // Always attach a confirmation token so WhatsApp/email auto-verify can use it.
        // Email-confirm flow only triggers for COD; WhatsApp poll only for COD.
        // Online-paid orders are auto-confirmed in the Stripe webhook.
        const isCOD = newOrder.paymentMethod === 'cash_on_delivery';
        {
            const { token, tokenExpiresAt } = generateConfirmationToken();
            newOrder.confirmation = { token, tokenExpiresAt, confirmedAt: null, confirmedVia: null, declinedAt: null };
        }

        // CRITICAL: Stripe orders start as "awaiting payment" and are HIDDEN from
        // every dashboard until the Stripe webhook confirms payment. This prevents
        // abandoned-checkout orders from appearing as real orders to sellers.
        if (!isCOD) {
            newOrder.awaitingPayment = true;
        }

        await newOrder.save();

        // Send order confirmation email to buyer — ONLY for COD here.
        // For Stripe orders, the buyer + seller emails are sent from the Stripe
        // webhook (server.js) after payment is actually confirmed.
        if (isCOD) {
            try {
                const confirmUrl = `${process.env.FRONTEND_URL || 'https://rozare.com'}/orders/confirm/${newOrder.confirmation.token}`;
                const emailData = buyerOrderConfirmationRequestEmail(newOrder, confirmUrl);
                await sendEmail({ to: newOrder.shippingInfo.email, ...emailData });
                newOrder.confirmation.emailSentAt = new Date();
                newOrder.confirmation.emailSentSuccess = true;
                await newOrder.save();
            } catch (emailErr) {
                console.error('Failed to send order confirmation email:', emailErr.message);
                newOrder.confirmation.emailSentAt = new Date();
                newOrder.confirmation.emailSentSuccess = false;
                newOrder.confirmation.emailError = emailErr.message || 'Unknown email error';
                await newOrder.save();
            }

            // Send new order notification to each seller (COD only — for Stripe this happens in webhook)
            try {
                const sellerIds = [...new Set(orderItems.map(p => p.seller?.toString()).filter(Boolean))];
                for (const sellerId of sellerIds) {
                    const seller = await User.findById(sellerId);
                    // Send each seller a view scoped to ONLY their items + their totals
                    const sellerProductIds = orderItems
                        .filter(p => toId(p.seller) === toId(sellerId))
                        .map(p => toId(p._id));
                    const scopedOrder = buildSellerOrderView(newOrder, sellerProductIds, sellerId);
                    if (seller?.email) {
                        const sellerEmailData = newOrderSellerEmail(scopedOrder, seller.username);
                        await sendEmail({ to: seller.email, ...sellerEmailData });
                    }
                    notifySeller(sellerId, 'new_order', sellerTemplates.new_order(scopedOrder)).catch(e =>
                        console.error('[whatsapp] seller new order notification failed:', e.message)
                    );
                }
            } catch (emailErr) {
                console.error('Failed to send seller notification email:', emailErr.message);
            }

            // 🟢 Enqueue WhatsApp confirmation poll ONLY for COD orders.
            await maybeEnqueueWhatsAppConfirmation(newOrder, orderItems);
        }

        // Record coupon usage
        if (userId && order.appliedCoupons && order.appliedCoupons.length > 0) {
            for (const couponData of order.appliedCoupons) {
                if (couponData.couponId) {
                    await recordCouponUsage(couponData.couponId, userId);
                }
            }
        }


        // const domainURL = process.env.FRONTEND_URL || 'http://localhost:5173'

        if (newOrder.paymentMethod === 'cash_on_delivery') {
            // Reduce stock for cash on delivery orders
            for (const item of newOrder.orderItems) {
                await Product.findByIdAndUpdate(
                    item.productId,
                    { $inc: { stock: -item.quantity } }
                );
            }

            trackOrderEvent({
                event: 'PlaceAnOrder',
                req,
                order: newOrder,
                eventId: newOrder.tracking?.tiktokPlaceOrderEventId,
                tracking: newOrder.tracking || {},
            }).catch(() => {});

            return res.status(200).json({
                msg: 'Order placed successfully',
                orderId: newOrder.orderId,
                order: {
                    orderId: newOrder.orderId,
                    totalAmount: newOrder.orderSummary.totalAmount,
                    currency: newOrder.currency,
                    email: newOrder.shippingInfo.email
                }
            });
        }

        if (!STRIPE_SUPPORTED_CURRENCIES.has(newOrder.currency)) {
            await Order.deleteOne({ _id: newOrder._id });
            return res.status(400).json({
                msg: `Card payments are not available in ${newOrder.currency} yet. Please choose cash on delivery or switch checkout currency.`,
            });
        }
        const stripeCurrency = newOrder.currency.toLowerCase();

        const line_items = [
            ...newOrder.orderItems.map(item => ({
                price_data: {
                    currency: stripeCurrency,
                    product_data: {
                        name: item.name,
                        images: item.image ? [item.image] : undefined
                    },
                    unit_amount: toStripeMinorUnits(item.price, newOrder.currency)
                },
                quantity: item.quantity
            })),


            // SHIPPING
            {
                price_data: {
                    currency: stripeCurrency,
                    product_data: {
                        name: `${newOrder.shippingMethod.name} Shipping`,
                    },
                    unit_amount: toStripeMinorUnits(newOrder.shippingMethod.price, newOrder.currency)
                },
                quantity: 1
            },

            // TAX (only if tax > 0)
            ...(newOrder.orderSummary.tax > 0 ? [{
                price_data: {
                    currency: stripeCurrency,
                    product_data: {
                        name: taxConfig && taxConfig.type === 'percentage'
                            ? `Tax (${taxConfig.value}%)`
                            : 'Tax',
                    },
                    unit_amount: toStripeMinorUnits(newOrder.orderSummary.tax, newOrder.currency)
                },
                quantity: 1
            }] : [])
        ]

        // console.log(line_items);

        // Support mobile deep-link redirects when platform === 'mobile'
        const isMobile = order.platform === 'mobile';
        const successUrl = isMobile
            ? `rozare://payment-success?session_id={CHECKOUT_SESSION_ID}&orderId=${newOrder.orderId}`
            : `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = isMobile
            ? `rozare://payment-cancel?orderId=${newOrder.orderId}`
            : `${process.env.FRONTEND_URL}/checkout`;

        if (!stripe) {
            // Stripe not configured — clean up the awaiting order so it doesn't linger
            await Order.deleteOne({ _id: newOrder._id });
            return res.status(500).json({ msg: "Online payments are not configured. Please contact support." });
        }

        // Apply coupon discount on Stripe via a one-off coupon (line items can't be negative).
        let stripeDiscounts = undefined;
        const couponDiscountAmount = Number(newOrder.orderSummary.couponDiscount) || 0;
        if (couponDiscountAmount > 0) {
            try {
                const amountOff = toStripeMinorUnits(couponDiscountAmount, newOrder.currency);
                if (amountOff > 0) {
                    const stripeCoupon = await stripe.coupons.create({
                        amount_off: amountOff,
                        currency: stripeCurrency,
                        duration: 'once',
                        name: 'Coupon discount',
                    });
                    stripeDiscounts = [{ coupon: stripeCoupon.id }];
                }
            } catch (couponErr) {
                console.error('Failed to create Stripe coupon:', couponErr.message);
            }
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            line_items,
            ...(stripeDiscounts ? { discounts: stripeDiscounts } : {}),
            success_url: successUrl,
            cancel_url: cancelUrl,
            // Auto-expire abandoned checkouts after 30 minutes (Stripe min) so the
            // `checkout.session.expired` webhook can mark the order as cancelled.
            expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
            metadata: {
                orderId: newOrder.orderId,
                tiktokPurchaseEventId: newOrder.tracking?.tiktokPurchaseEventId || '',
            }
        })

        // Persist the Stripe session id so webhook handlers can locate this order
        // when the buyer abandons / the session expires.
        newOrder.stripeSessionId = session.id;
        await newOrder.save();

        trackOrderEvent({
            event: 'PlaceAnOrder',
            req,
            order: newOrder,
            eventId: newOrder.tracking?.tiktokPlaceOrderEventId,
            tracking: newOrder.tracking || {},
        }).catch(() => {});

        return res.status(201).json({
            id: session.id,
            url: session.url,
            order: {
                orderId: newOrder.orderId,
                totalAmount: newOrder.orderSummary.totalAmount,
                currency: newOrder.currency,
            },
        });
    } catch (error) {
        console.error("Stripe session error:::", error);
        return res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : "Server error while creating checkout session. Try again!"
        });
    }
}



exports.getOrders = async (req, res) => {
    const { role, id: userId } = req.user
    const { search, paymentStatus, status, startDate, endDate } = { ...req.query }

    // Hide awaiting-payment Stripe orders from seller/admin dashboards.
    let query = { awaitingPayment: { $ne: true } }
    if (search) {
        query.$or = [
            { "shippingInfo.fullName": { $regex: search, $options: 'i' } },
            { orderId: { $regex: search, $options: 'i' } }
        ]
    }

    if (status) {
        query.orderStatus = status
    }

    if (paymentStatus) {
        query.isPaid = paymentStatus === 'paid' ? true : false
    }

    // Apply date range filtering
    if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            query.createdAt.$lte = end;
        }
    }

    try {
        let orders

        if (role === 'seller') {
            orders = await getSellerScopedOrders(query, userId)
        } else if (role === 'admin') {
            orders = await Order.find(query)
        } else {
            return res.status(403).json({ msg: 'Admin or seller access required for this order list' })
        }

        res.status(200).json({ msg: 'Orders fetched successfully', orders: orders })

    } catch (error) {
        console.error("Error fetching Order:", error);
        return res.status(500).json({ msg: "Server error while fetching orders" });
    }
}

/**
 * GET /api/order/export — download orders in CSV, PDF, or Excel format.
 * Query params: search, paymentStatus, status, startDate, endDate, format (csv|pdf|excel)
 * Includes store branding for sellers and Rozare branding for admins.
 */
exports.exportOrders = async (req, res) => {
    const { role, id: userId } = req.user;
    const { search, paymentStatus, status, startDate, endDate, format = 'csv' } = req.query;
    const Store = require('../models/Store');
    const User = require('../models/User');

    // Hide awaiting-payment Stripe orders from exports.
    let query = { awaitingPayment: { $ne: true } };
    if (search) {
        query.$or = [
            { "shippingInfo.fullName": { $regex: search, $options: 'i' } },
            { orderId: { $regex: search, $options: 'i' } }
        ];
    }
    if (status) query.orderStatus = status;
    if (paymentStatus) query.isPaid = paymentStatus === 'paid';
    if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            query.createdAt.$lte = end;
        }
    }

    try {
        if (role !== 'seller' && role !== 'admin') {
            return res.status(403).json({ msg: 'Admin or seller access required to export orders' });
        }

        // Get branding info
        let brandName = 'Rozare';
        let storeName = '';
        let sellerName = '';
        if (role === 'seller') {
            const store = await Store.findOne({ seller: userId }).select('storeName').lean();
            const user = await User.findById(userId).select('username').lean();
            storeName = store?.storeName || '';
            sellerName = user?.username || '';
            brandName = storeName || sellerName || 'Rozare';
        }

        let orders;
        if (role === 'seller') {
            orders = await getSellerScopedOrders(query, userId, { createdAt: -1 });
        } else {
            orders = await Order.find(query).sort({ createdAt: -1 });
        }

        // Normalize orders to plain objects
        const rows = orders.map(order => {
            const o = order.toObject ? order.toObject() : order;
            return {
                orderId: o.orderId || '',
                date: new Date(o.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
                customer: o.shippingInfo?.fullName || '',
                email: o.shippingInfo?.email || '',
                phone: o.shippingInfo?.phone || '',
                city: o.shippingInfo?.city || '',
                country: o.shippingInfo?.country || '',
                status: (o.orderStatus || '').charAt(0).toUpperCase() + (o.orderStatus || '').slice(1),
                payment: o.isPaid ? 'Paid' : 'Unpaid',
                paymentMethod: o.paymentMethod === 'cash_on_delivery' ? 'COD' : 'Stripe',
                items: (o.orderItems || []).map(i => {
                    const options = formatItemOptionsText(i);
                    return `${orderItemName(i)}${options ? ` (${options})` : ''} x${i.quantity}`;
                }).join(', '),
                itemCount: (o.orderItems || []).reduce((sum, i) => sum + i.quantity, 0),
                subtotal: o.orderSummary?.subtotal?.toFixed(2) || '0.00',
                shipping: o.orderSummary?.shippingCost?.toFixed(2) || '0.00',
                tax: o.orderSummary?.tax?.toFixed(2) || '0.00',
                total: o.orderSummary?.totalAmount?.toFixed(2) || '0.00',
            };
        });

        const dateStr = new Date().toISOString().split('T')[0];
        const generatedDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        const filterDesc = [
            status ? `Status: ${status.charAt(0).toUpperCase() + status.slice(1)}` : null,
            paymentStatus ? `Payment: ${paymentStatus}` : null,
            startDate ? `From: ${startDate}` : null,
            endDate ? `To: ${endDate}` : null,
        ].filter(Boolean).join(' | ') || 'All Orders';

        // Totals
        const totalSubtotal = rows.reduce((s, r) => s + parseFloat(r.subtotal), 0).toFixed(2);
        const totalShipping = rows.reduce((s, r) => s + parseFloat(r.shipping), 0).toFixed(2);
        const totalTax = rows.reduce((s, r) => s + parseFloat(r.tax), 0).toFixed(2);
        const grandTotal = rows.reduce((s, r) => s + parseFloat(r.total), 0).toFixed(2);
        const totalItems = rows.reduce((s, r) => s + r.itemCount, 0);

        // ── CSV Format ──
        if (format === 'csv') {
            const lines = [];
            lines.push(`"${brandName} - Order Report"`);
            if (storeName && role === 'seller') lines.push(`"Store: ${storeName}"`);
            lines.push(`"Generated: ${generatedDate}"`);
            lines.push(`"Filter: ${filterDesc}"`);
            lines.push(`"Total Orders: ${rows.length} | Total Items: ${totalItems} | Grand Total: $${grandTotal}"`);
            lines.push('');
            lines.push('Order ID,Date,Customer,Email,Phone,City,Country,Status,Payment,Method,Items,Qty,Subtotal,Shipping,Tax,Total');
            rows.forEach(r => {
                const esc = (val) => `"${String(val).replace(/"/g, '""')}"`;
                lines.push([esc(r.orderId), esc(r.date), esc(r.customer), esc(r.email), esc(r.phone), esc(r.city), esc(r.country), esc(r.status), esc(r.payment), esc(r.paymentMethod), esc(r.items), r.itemCount, r.subtotal, r.shipping, r.tax, r.total].join(','));
            });
            lines.push('');
            lines.push(`,,,,,,,,,,TOTALS,${totalItems},${totalSubtotal},${totalShipping},${totalTax},${grandTotal}`);
            lines.push('');
            lines.push(`"Powered by Rozare - www.rozare.com"`);

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="${brandName.replace(/\s/g, '-')}-orders-${dateStr}.csv"`);
            return res.status(200).send(lines.join('\n'));
        }

        // ── Excel Format ──
        if (format === 'excel') {
            const ExcelJS = require('exceljs');
            const workbook = new ExcelJS.Workbook();
            workbook.creator = 'Rozare';
            workbook.created = new Date();
            const sheet = workbook.addWorksheet('Orders');

            // ─── Title section ───
            sheet.mergeCells('A1:P1');
            const titleCell = sheet.getCell('A1');
            titleCell.value = `${brandName} - Order Report`;
            titleCell.font = { bold: true, size: 16, color: { argb: 'FF6366F1' } };
            titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
            sheet.getRow(1).height = 30;

            if (storeName && role === 'seller') {
                sheet.mergeCells('A2:P2');
                const storeCell = sheet.getCell('A2');
                storeCell.value = `Store: ${storeName}`;
                storeCell.font = { size: 11, color: { argb: 'FF64748B' } };
                storeCell.alignment = { horizontal: 'center' };
            }

            const infoRow = role === 'seller' && storeName ? 3 : 2;
            sheet.mergeCells(`A${infoRow}:P${infoRow}`);
            const infoCell = sheet.getCell(`A${infoRow}`);
            infoCell.value = `Generated: ${generatedDate} | ${filterDesc} | ${rows.length} orders | Grand Total: $${grandTotal}`;
            infoCell.font = { size: 10, italic: true, color: { argb: 'FF94A3B8' } };
            infoCell.alignment = { horizontal: 'center' };

            // Empty row before table
            const dataStartRow = infoRow + 2;

            // Define columns
            sheet.columns = [
                { header: 'Order ID', key: 'orderId', width: 18 },
                { header: 'Date', key: 'date', width: 14 },
                { header: 'Customer', key: 'customer', width: 22 },
                { header: 'Email', key: 'email', width: 26 },
                { header: 'Phone', key: 'phone', width: 16 },
                { header: 'City', key: 'city', width: 14 },
                { header: 'Country', key: 'country', width: 12 },
                { header: 'Status', key: 'status', width: 12 },
                { header: 'Payment', key: 'payment', width: 10 },
                { header: 'Method', key: 'paymentMethod', width: 10 },
                { header: 'Items', key: 'items', width: 40 },
                { header: 'Qty', key: 'itemCount', width: 6 },
                { header: 'Subtotal', key: 'subtotal', width: 12 },
                { header: 'Shipping', key: 'shipping', width: 12 },
                { header: 'Tax', key: 'tax', width: 10 },
                { header: 'Total', key: 'total', width: 12 },
            ];

            // Move header row to correct position
            const headerRow = sheet.getRow(dataStartRow);
            headerRow.values = ['Order ID', 'Date', 'Customer', 'Email', 'Phone', 'City', 'Country', 'Status', 'Payment', 'Method', 'Items', 'Qty', 'Subtotal', 'Shipping', 'Tax', 'Total'];
            headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
            headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6366F1' } };
            headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
            headerRow.height = 24;
            headerRow.eachCell(cell => { cell.border = { bottom: { style: 'medium', color: { argb: 'FF4F46E5' } } }; });

            // Add data rows
            rows.forEach((r, i) => {
                const row = sheet.getRow(dataStartRow + 1 + i);
                row.values = [r.orderId, r.date, r.customer, r.email, r.phone, r.city, r.country, r.status, r.payment, r.paymentMethod, r.items, r.itemCount, r.subtotal, r.shipping, r.tax, r.total];
                row.alignment = { vertical: 'middle' };
                if (i % 2 === 0) {
                    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
                }
                // Color-code status
                const statusCell = row.getCell(8);
                const statusColors = { Pending: 'FFF59E0B', Confirmed: 'FF10B981', Processing: 'FF6366F1', Shipped: 'FF0EA5E9', Delivered: 'FF22C55E', Cancelled: 'FFEF4444' };
                if (statusColors[r.status]) statusCell.font = { bold: true, color: { argb: statusColors[r.status] } };
                // Color-code payment
                const payCell = row.getCell(9);
                payCell.font = { bold: true, color: { argb: r.payment === 'Paid' ? 'FF22C55E' : 'FFEF4444' } };
            });

            // Summary row
            const sumRowNum = dataStartRow + 1 + rows.length + 1;
            const summaryRow = sheet.getRow(sumRowNum);
            summaryRow.values = ['', '', '', '', '', '', '', '', '', '', `TOTAL (${rows.length} orders)`, totalItems, totalSubtotal, totalShipping, totalTax, grandTotal];
            summaryRow.font = { bold: true, size: 11 };
            summaryRow.getCell(16).font = { bold: true, size: 12, color: { argb: 'FF6366F1' } };
            summaryRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE9FE' } };

            // Footer
            const footerRow = sheet.getRow(sumRowNum + 2);
            sheet.mergeCells(`A${sumRowNum + 2}:P${sumRowNum + 2}`);
            const footerCell = sheet.getCell(`A${sumRowNum + 2}`);
            footerCell.value = 'Powered by Rozare - www.rozare.com';
            footerCell.font = { size: 9, italic: true, color: { argb: 'FF94A3B8' } };
            footerCell.alignment = { horizontal: 'center' };

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${brandName.replace(/\s/g, '-')}-orders-${dateStr}.xlsx"`);
            await workbook.xlsx.write(res);
            return res.end();
        }

        // ── PDF Format ──
        if (format === 'pdf') {
            const PDFDocument = require('pdfkit');
            const margin = 40;
            const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: margin, bottom: margin, left: margin, right: margin }, autoFirstPage: false });

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${brandName.replace(/\s/g, '-')}-orders-${dateStr}.pdf"`);
            doc.pipe(res);

            doc.addPage({ size: 'A4', layout: 'landscape', margins: { top: margin, bottom: margin, left: margin, right: margin } });

            const pageW = doc.page.width;
            const pageH = doc.page.height;
            const contentWidth = pageW - margin * 2;
            const maxY = pageH - margin - 10;

            // Table config
            const cols = [
                { label: '#', width: 24 },
                { label: 'Order ID', width: 90 },
                { label: 'Date', width: 64 },
                { label: 'Customer', width: 88 },
                { label: 'Phone', width: 70 },
                { label: 'City', width: 54 },
                { label: 'Status', width: 58 },
                { label: 'Payment', width: 48 },
                { label: 'Method', width: 38 },
                { label: 'Items', width: 150 },
                { label: 'Total', width: 58 },
            ];
            const tableWidth = cols.reduce((s, c) => s + c.width, 0);
            const rowH = 20;
            const headerH = 22;
            const dataFontSize = 7.5;

            // ─── Draw brand header (first page only) ───
            const drawBrandHeader = () => {
                doc.rect(0, 0, pageW, 5).fill('#6366f1');
                let y = 18;
                doc.font('Helvetica-Bold').fontSize(18).fillColor('#6366f1');
                doc.text(brandName, margin, y, { width: contentWidth, align: 'center', lineBreak: false });
                y += 24;
                doc.font('Helvetica-Bold').fontSize(11).fillColor('#1e293b');
                doc.text('Order Report', margin, y, { width: contentWidth, align: 'center', lineBreak: false });
                y += 16;
                doc.font('Helvetica').fontSize(9).fillColor('#64748b');
                doc.text(`${generatedDate} | ${filterDesc} | ${rows.length} orders | Total: $${grandTotal}`, margin, y, { width: contentWidth, align: 'center', lineBreak: false });
                y += 20;
                return y;
            };

            // ─── Draw table column headers ───
            const drawTableHeader = (startY) => {
                doc.rect(margin, startY, tableWidth, headerH).fill('#6366f1');
                let x = margin;
                doc.font('Helvetica-Bold').fontSize(dataFontSize).fillColor('#ffffff');
                cols.forEach(col => {
                    doc.text(col.label, x + 4, startY + 7, { width: col.width - 8, lineBreak: false });
                    x += col.width;
                });
                return startY + headerH;
            };

            // ─── First page ───
            let y = drawBrandHeader();
            y = drawTableHeader(y);

            // ─── Render data rows ───
            rows.forEach((r, i) => {
                if (y + rowH > maxY) {
                    // New page — no footer text here (that was causing empty pages)
                    doc.addPage({ size: 'A4', layout: 'landscape', margins: { top: margin, bottom: margin, left: margin, right: margin } });
                    doc.rect(0, 0, pageW, 3).fill('#6366f1');
                    y = margin;
                    y = drawTableHeader(y);
                }

                // Alternate row bg
                doc.rect(margin, y, tableWidth, rowH).fill(i % 2 === 0 ? '#f8fafc' : '#ffffff');
                doc.rect(margin, y, tableWidth, rowH).lineWidth(0.2).strokeColor('#e2e8f0').stroke();

                // Row values
                const values = [String(i + 1), r.orderId, r.date, r.customer, r.phone, r.city, r.status, r.payment, r.paymentMethod, r.items, `$${r.total}`];
                let x = margin;
                values.forEach((val, ci) => {
                    let color = '#334155';
                    let font = 'Helvetica';
                    if (ci === 6) {
                        const sc = { Pending: '#d97706', Confirmed: '#059669', Processing: '#4f46e5', Shipped: '#0284c7', Delivered: '#16a34a', Cancelled: '#dc2626' };
                        color = sc[val] || color;
                        font = 'Helvetica-Bold';
                    }
                    if (ci === 7) { color = val === 'Paid' ? '#16a34a' : '#dc2626'; font = 'Helvetica-Bold'; }
                    if (ci === 10) { color = '#1e293b'; font = 'Helvetica-Bold'; }
                    doc.font(font).fontSize(dataFontSize).fillColor(color);
                    doc.text(String(val || ''), x + 4, y + 6, { width: cols[ci].width - 8, lineBreak: false });
                    x += cols[ci].width;
                });
                y += rowH;
            });

            // ─── Totals row ───
            if (rows.length > 0) {
                if (y + 26 > maxY) {
                    doc.addPage({ size: 'A4', layout: 'landscape', margins: { top: margin, bottom: margin, left: margin, right: margin } });
                    doc.rect(0, 0, pageW, 3).fill('#6366f1');
                    y = margin;
                }
                y += 6;
                doc.rect(margin, y, tableWidth, 22).fill('#ede9fe');
                doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#4f46e5');
                doc.text(
                    `TOTALS: ${rows.length} orders | Subtotal: $${totalSubtotal} | Shipping: $${totalShipping} | Tax: $${totalTax} | Grand Total: $${grandTotal}`,
                    margin + 10, y + 6, { width: tableWidth - 20, lineBreak: false }
                );
                y += 30;
            }

            // ─── Footer (only on last page, at bottom) ───
            doc.font('Helvetica').fontSize(7.5).fillColor('#94a3b8');
            doc.text('Powered by Rozare - www.rozare.com', margin, pageH - 28, { width: contentWidth, align: 'center', lineBreak: false });

            doc.end();
            return;
        }

        // Unknown format
        return res.status(400).json({ msg: 'Invalid format. Supported: csv, pdf, excel' });
    } catch (error) {
        console.error("Error exporting orders:", error);
        return res.status(500).json({ msg: "Server error while exporting orders" });
    }
}

exports.getUserOrders = async (req, res) => {
    const { id } = req.user
    const { search, status, paymentStatus } = req.query
    try {
        let query = {}
        if (search) {
            query.orderId = { $regex: search, $options: 'i' }
        }

        if (status) {
            query.orderStatus = status
        }

        if (paymentStatus) {
            query.isPaid = paymentStatus === 'paid' ? true : false
        }
        query.user = id
        // Hide awaiting-payment Stripe orders from buyer "My Orders" until paid.
        query.awaitingPayment = { $ne: true }

        // console.log(query);
        let orders = await Order.find(query)
        // console.log('get user ordersss:::::::::::::', orders);
        // orders = orders.find(item => item.user)


        res.status(200).json({ msg: 'User Orders fetched successfully', orders: orders })

    } catch (error) {
        console.error("Error fetching Order:", error);
        return res.status(500).json({ msg: "Server error while fetching orders" });

    }
}


exports.updateStatus = async (req, res) => {
    const { id: _id } = req.params
    const { newStatus } = req.body
    const { role, id: userId } = req.user

    try {
        if (role !== 'seller' && role !== 'admin') {
            return res.status(403).json({ msg: 'Only sellers and admins can update order status' })
        }

        const existingOrder = await Order.findById(_id)

        if (!existingOrder) {
            return res.status(404).json({ msg: 'Order not found' })
        }

        // If seller, check if order contains their products (snapshot or live).
        if (role === 'seller') {
            const sellerProducts = await Product.find({ seller: userId }).select('_id')
            const sellerProductIds = sellerProducts.map(p => p._id.toString())

            const hasSellerProduct = existingOrder.orderItems.some(item =>
                (item.seller && toId(item.seller) === toId(userId)) ||
                sellerProductIds.includes(toId(item.productId))
            )

            if (!hasSellerProduct) {
                return res.status(403).json({ msg: 'You can only update orders containing your products' })
            }

            // Sellers can set confirmed and cancelled, but not if order is already shipped or delivered
            if (newStatus === 'cancelled' && ['shipped', 'delivered'].includes(existingOrder.orderStatus)) {
                return res.status(403).json({ msg: 'Cannot cancel an order that is already shipped or delivered.' })
            }
        }

        // Track confirmation fields when seller/admin explicitly sets confirmed/cancelled
        // Only if the BUYER hasn't already made a decision
        const buyerAlreadyDecided = !!(existingOrder.confirmation?.confirmedAt || existingOrder.confirmation?.declinedAt);

        if (newStatus === 'confirmed' && !buyerAlreadyDecided) {
            existingOrder.confirmation = existingOrder.confirmation || {};
            existingOrder.confirmation.confirmedAt = new Date();
            existingOrder.confirmation.confirmedVia = role === 'admin' ? 'admin' : 'manual';
            existingOrder.confirmation.decidedAt = new Date();
            existingOrder.confirmation.decidedVia = role === 'admin' ? 'admin' : 'manual';
        } else if (newStatus === 'cancelled' && !buyerAlreadyDecided) {
            existingOrder.confirmation = existingOrder.confirmation || {};
            existingOrder.confirmation.declinedAt = new Date();
            existingOrder.confirmation.confirmedVia = role === 'admin' ? 'admin' : 'manual'; // tracks who initiated the decision
            existingOrder.confirmation.decidedAt = new Date();
            existingOrder.confirmation.decidedVia = role === 'admin' ? 'admin' : 'manual';
        }

        existingOrder.orderStatus = newStatus;
        if (newStatus === 'delivered') {
            existingOrder.isPaid = true;
        }
        await existingOrder.save();

        // Send status update email
        try {
            const emailData = orderStatusUpdateEmail(existingOrder, newStatus);
            await sendEmail({ to: existingOrder.shippingInfo.email, ...emailData });
        } catch (emailErr) {
            console.error('Failed to send status update email:', emailErr.message);
        }

        res.status(200).json({ msg: 'Updated status successfully' })
    } catch (error) {
        console.error(error.message);
        res.status(500).json({ msg: 'Server error while updating status' })
    }
}



exports.getOrderDetail = async (req, res) => {
    const { id } = req.params
    const { role, id: userId } = req.user

    try {
        const order = await Order.findOne({ _id: id })

        if (!order) {
            return res.status(404).json({ msg: 'Order not found' })
        }

        if (role === 'seller') {
            const sellerProductIds = await getSellerProductIds(userId)
            if (!orderHasSellerProduct(order, sellerProductIds, userId)) {
                return res.status(403).json({ msg: 'You can only view orders containing your products' })
            }

            const filteredOrder = buildSellerOrderView(order, sellerProductIds, userId)
            return res.status(200).json({ msg: 'Order fetched successfully.', order: filteredOrder })
        }

        if (role !== 'admin' && toId(order.user) !== toId(userId)) {
            return res.status(403).json({ msg: 'You can only view your own orders' })
        }

        res.status(200).json({ msg: 'Order fetched successfully.', order: order })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while fetching order detail' })
    }
}

// Guest order tracking by email + orderId
exports.trackGuestOrder = async (req, res) => {
    const { email, orderId } = req.query;

    if (!email || !orderId) {
        return res.status(400).json({ msg: 'Email and Order ID are required' });
    }

    try {
        const order = await Order.findOne({
            orderId: orderId,
            'shippingInfo.email': email.toLowerCase().trim()
        });

        if (!order) {
            return res.status(404).json({ msg: 'Order not found. Please check your email and order ID.' });
        }

        res.status(200).json({ msg: 'Order found', order });
    } catch (error) {
        console.error('Error tracking guest order:', error);
        res.status(500).json({ msg: 'Server error while tracking order' });
    }
};


exports.cancelOrder = async (req, res) => {
    const { id: _id } = req.params
    const { role, id: userId } = req.user

    try {
        // Only admin and customers can cancel orders, not sellers
        if (role === 'seller') {
            return res.status(403).json({ msg: 'Sellers cannot cancel orders. Only customers and admins can cancel orders.' })
        }

        const order = await Order.findById(_id);
        if (!order) return res.status(404).json({ msg: 'Order not found' })

        if (role !== 'admin' && toId(order.user) !== toId(userId)) {
            return res.status(403).json({ msg: 'You can only cancel your own orders' })
        }

        // Track whether the buyer is overriding a prior WhatsApp confirmation.
        // This helps the seller see a clear note:
        //   "Order was confirmed via WhatsApp but buyer changed their mind
        //    and cancelled from their dashboard."
        const wasConfirmedViaWhatsApp = !!(
            order.confirmation?.confirmedAt &&
            order.confirmation?.confirmedVia === 'whatsapp'
        );

        order.orderStatus = 'cancelled';

        if (wasConfirmedViaWhatsApp) {
            // Mark that the buyer retracted their WhatsApp confirmation
            order.confirmation.cancelledFromDashboardAt = new Date();
            order.confirmation.cancelledFromDashboardNote =
                'Order was confirmed by buyer via Rozare WhatsApp automation, but buyer changed their mind and cancelled from their account dashboard.';
        }

        // Also track if confirmed via email then cancelled from account
        const wasConfirmedViaEmail = !!(
            order.confirmation?.confirmedAt &&
            order.confirmation?.confirmedVia === 'email'
        );
        if (wasConfirmedViaEmail) {
            order.confirmation.cancelledFromDashboardAt = new Date();
            order.confirmation.cancelledFromDashboardNote =
                'Buyer confirmed via email, then cancelled from their account.';
        }

        // If order wasn't confirmed by anyone yet, just mark the cancellation
        if (!wasConfirmedViaWhatsApp && !wasConfirmedViaEmail) {
            order.confirmation = order.confirmation || {};
            order.confirmation.declinedAt = new Date();
            order.confirmation.decidedAt = new Date();
            order.confirmation.decidedVia = 'dashboard';
            order.confirmation.confirmedVia = order.confirmation.confirmedVia || 'dashboard';
        }

        await order.save();

        // Send cancellation email
        try {
            const emailData = orderStatusUpdateEmail(order, 'cancelled');
            await sendEmail({ to: order.shippingInfo.email, ...emailData });
        } catch (emailErr) {
            console.error('Failed to send cancellation email:', emailErr.message);
        }

        res.status(200).json({ msg: 'Order cancelled successfully.', order })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while cancelling order' })
    }
}

// =============================================================================
// Re-order — clone past order's items into the user's cart
// =============================================================================
exports.reorder = async (req, res) => {
    const { id: orderId } = req.params;
    const { id: userId } = req.user;
    try {
        const order = await Order.findById(orderId);
        if (!order) return res.status(404).json({ msg: 'Order not found' });
        if (order.user && order.user.toString() !== userId.toString()) {
            return res.status(403).json({ msg: 'Not your order' });
        }

        let cart = await Cart.findOne({ user: userId });
        if (!cart) cart = new Cart({ user: userId, cartItems: [] });

        let added = 0;
        let unavailable = 0;
        for (const item of order.orderItems) {
            const product = await Product.findById(item.productId);
            if (!product || product.stock <= 0) { unavailable++; continue; }
            const qty = Math.min(item.quantity || 1, product.stock);
            const selectedOptions = toPlainOptions(item.selectedOptions);
            const itemOptionsKey = optionsKey(selectedOptions);
            const existing = cart.cartItems.find(
                (p) => p.product?.toString() === item.productId.toString() &&
                       (p.selectedColor || null) === (item.selectedColor || null) &&
                       optionsKey(p.selectedOptions) === itemOptionsKey
            );
            if (existing) {
                existing.qty = Math.min((existing.qty || 1) + qty, product.stock);
            } else {
                cart.cartItems.push({
                    product: item.productId,
                    qty,
                    selectedColor: item.selectedColor || null,
                    selectedOptions: Object.keys(selectedOptions).length ? selectedOptions : undefined,
                });
            }
            added++;
        }
        await cart.save();

        res.status(200).json({
            msg: `Re-order complete. ${added} items added to cart.${unavailable > 0 ? ` ${unavailable} unavailable.` : ''}`,
            added,
            unavailable,
        });
    } catch (error) {
        console.error('Reorder error:', error);
        res.status(500).json({ msg: 'Server error while re-ordering' });
    }
};

// =============================================================================
// Invoice — generate styled HTML invoice (rendered to PDF on client)
// =============================================================================
exports.getInvoice = async (req, res) => {
    const { id } = req.params;
    const { role, id: userId } = req.user;
    try {
        const order = await Order.findById(id);
        if (!order) return res.status(404).json({ msg: 'Order not found' });

        if (role !== 'admin') {
            const ownsOrder = order.user && order.user.toString() === userId.toString();
            if (!ownsOrder) {
                if (role === 'seller') {
                    const sellerProducts = await Product.find({ seller: userId }).select('_id');
                    const ids = sellerProducts.map((p) => p._id.toString());
                    const hasItem = order.orderItems.some((it) => ids.includes(it.productId.toString()));
                    if (!hasItem) return res.status(403).json({ msg: 'Forbidden' });
                } else {
                    return res.status(403).json({ msg: 'Forbidden' });
                }
            }
        }

        const fmt = (n) => `$${(Number(n) || 0).toFixed(2)}`;
        const rows = order.orderItems.map((it) => `
            <tr>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;">${it.name}${it.selectedColor ? ` <span style="color:#6366f1;font-size:11px;">(${it.selectedColor})</span>` : ''}</td>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:center;">${it.quantity}</td>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${fmt(it.price)}</td>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;">${fmt(it.price * it.quantity)}</td>
            </tr>`).join('');

        const summary = order.orderSummary || {};
        const html = `<!doctype html><html><head><meta charset="utf-8"/><title>Invoice ${order.orderId}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;color:#1f2937;background:#f9fafb;padding:24px;margin:0;}
  .card{background:#fff;max-width:760px;margin:0 auto;border-radius:18px;padding:36px;box-shadow:0 6px 24px rgba(0,0,0,0.08);}
  .head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;border-bottom:2px solid #6366f1;padding-bottom:18px;}
  h1{margin:0;font-size:26px;color:#6366f1;letter-spacing:-0.5px;}
  .muted{color:#6b7280;font-size:12px;}
  .grid{display:flex;gap:32px;margin:18px 0;}
  .grid > div{flex:1;}
  .label{font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:6px;}
  table{width:100%;border-collapse:collapse;margin-top:14px;}
  th{background:#eef2ff;color:#4338ca;padding:10px;text-align:left;font-size:12px;font-weight:600;}
  th:nth-child(2){text-align:center;} th:nth-child(3),th:nth-child(4){text-align:right;}
  .totals{margin-top:18px;margin-left:auto;width:46%;}
  .totals .row{display:flex;justify-content:space-between;padding:6px 0;font-size:14px;}
  .totals .grand{border-top:2px solid #1f2937;margin-top:8px;padding-top:10px;font-weight:700;font-size:18px;color:#6366f1;}
  .footer{margin-top:30px;padding-top:18px;border-top:1px solid #e5e7eb;text-align:center;color:#9ca3af;font-size:11px;}
  .badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:600;background:#ecfdf5;color:#059669;}
</style></head><body>
<div class="card">
  <div class="head">
    <div>
      <h1>Rozare</h1>
      <div class="muted">Verified marketplace for trusted sellers</div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:13px;font-weight:600;">Invoice #${order.orderId}</div>
      <div class="muted">${new Date(order.createdAt).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</div>
      <div style="margin-top:6px;"><span class="badge">${(order.orderStatus || 'pending').toUpperCase()}</span></div>
    </div>
  </div>
  <div class="grid">
    <div>
      <div class="label">Billed To</div>
      <div style="font-weight:600;">${order.shippingInfo.fullName}</div>
      <div class="muted">${order.shippingInfo.address}<br/>${order.shippingInfo.city}, ${order.shippingInfo.state || ''} ${order.shippingInfo.postalCode || ''}<br/>${order.shippingInfo.country}<br/>${order.shippingInfo.email}</div>
    </div>
    <div>
      <div class="label">Payment</div>
      <div style="font-weight:600;">${order.paymentMethod === 'cash_on_delivery' ? 'Cash on Delivery' : 'Card Payment'}</div>
      <div class="muted">Status: ${order.isPaid ? 'Paid' : 'Unpaid'}</div>
    </div>
  </div>
  <table>
    <thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="totals">
    <div class="row"><span>Subtotal</span><span>${fmt(summary.subtotal)}</span></div>
    <div class="row"><span>Shipping</span><span>${fmt(summary.shippingCost)}</span></div>
    <div class="row"><span>Tax</span><span>${fmt(summary.tax)}</span></div>
    ${summary.couponDiscount ? `<div class="row" style="color:#10b981;"><span>Coupon discount</span><span>-${fmt(summary.couponDiscount)}</span></div>` : ''}
    <div class="row grand"><span>Total</span><span>${fmt(summary.totalAmount)}</span></div>
  </div>
  <div class="footer">Thank you for shopping on Rozare.<br/>Questions? Contact support — we're here to help.</div>
</div></body></html>`;

        res.status(200).json({ msg: 'Invoice generated', html, orderId: order.orderId });
    } catch (error) {
        console.error('Invoice error:', error);
        res.status(500).json({ msg: 'Server error while generating invoice' });
    }
};
