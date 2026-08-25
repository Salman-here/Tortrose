const mongoose = require('mongoose');
const Cart = require('../models/Cart');
const Order = require('../models/Order');
const Product = require('../models/Product')
const crypto = require('crypto');
const { stripe, STRIPE_MODE } = require('../config/stripe');
const TaxConfig = require('../models/TaxConfig');
const Store = require('../models/Store');
const { calculateTax } = require('./taxController');
const { generateConfirmationToken } = require('./orderConfirmationController');
const User = require('../models/User');
const { trackOrderEvent } = require('../services/tiktokEventsApi');
const { publicProductFilter } = require('../services/productModerationService');
const {
    CURRENCIES,
    normalizeCurrency,
    isSupportedCurrency,
    getExchangeRateSnapshot,
    convertAmountWithRates,
} = require('../services/currencyService');
const {
    requireStoredProductCurrency,
    requireStoredProductDiscountCurrency,
    requireStoredProductEffectivePrice,
} = require('../services/productPricingService');
const { isStoreVisibleToBuyer, normalizeBuyerLocation } = require('../services/storeVisibilityService');
const { storeAllowsCashOnDelivery } = require('../services/storePaymentPolicyService');
const { normalizeReturnPolicy } = require('../services/returnPolicyService');
const { payOrderWithWallet } = require('../services/walletService');
const {
    commitOrderInventory,
    commitOrderInventoryAndCoupons,
} = require('../services/orderInventoryService');
const { cancelOrderSafely } = require('../services/orderCancellationService');
const { transitionOrderFulfillment } = require('../services/orderStatusTransitionService');
const {
    attachStripeOrderReference,
    validateStripeOrderSession,
    validateStripeOrderPaymentIntent,
    getExpectedStripeTotalMinor,
    getStripeOrderChargeAmountMinor,
    fulfillStripeOrder,
    fulfillStripeOrderPaymentIntent,
    isPaymentFulfilled,
} = require('../services/stripeOrderPaymentService');
const {
    ensureStripeCustomerForUser,
    createMobileCustomerAccess,
    getStripeMobileConfig,
} = require('../services/stripeCustomerService');
const {
    createPaymentExpiry,
    closeOrderPaymentIntent,
} = require('../services/stripePendingPaymentService');
const {
    isDefinitiveStripeCreationError,
    isAuthoritativeStripeIdempotentReplayRejection,
    isStripeIdempotentReplayWithinAuthorityWindow,
} = require('../services/stripePaymentIntentFactory');
const {
    buildOrderCheckoutReturnUrls,
    createHostedOrderCheckoutSession,
    createNativeOrderPaymentIntent,
} = require('../services/stripeOrderSetupService');
const {
    completeNoChargeOrder,
    isNoChargeOnlineOrder,
} = require('../services/orderNoChargeService');
const {
    isAuthoritativeStripeAmountTooSmallError,
    isAuthoritativeStripeResourceMissingError,
} = require('../services/stripeCheckoutErrorService');
const { checkoutRequestFingerprint } = require('../services/checkoutIdempotencyService');
const { canonicalizeShippingPhone } = require('../services/orderBuyerContactService');
const { removeFulfilledOrderItemsFromCart } = require('../services/cartFulfillmentService');
const {
    parsePositiveSafeInteger,
    parseStrictFiniteNumber,
} = require('../services/numericInputService');
const {
    validateAndPriceCoupons,
    validateAndPriceShipping,
} = require('../services/checkoutPricingService');
const {
    SELLER_SETTLEMENT_VERSION,
    buildOrderSellerSettlement,
    getAccountingOrderCurrency,
    sellerOrderSummaryForItems,
} = require('../services/orderMoneyService');
const {
    getOrderItemLineSubtotal,
    priceOrderItemLines,
} = require('../services/orderLinePricingService');
const {
    fromMinorUnits,
    roundMoney,
    sumMoney,
    toMinorUnits,
} = require('../services/moneyMath');
const {
    reserveOrderCoupons,
    consumeOrderCoupons,
    deleteUnpaidOrderAndReleaseCoupons,
} = require('../services/couponUsageService');
const {
    ensureOrderSellerFulfillment,
    sellerFulfillmentFor,
} = require('../services/orderFulfillmentService');
const {
    enqueueCodOrderBuyerConfirmationNotification,
    enqueueCodOrderSellerNotifications,
} = require('../services/financialNotificationOutboxService');
const { resolveOrderReference } = require('../services/orderReferenceService');
const {
    formatItemOptionsText,
    formatOrderMoney,
    formatOrderItemUnitMoney,
    orderItemLineSubtotal,
    orderItemName,
    orderItemOptionsHtml,
    paymentMethodLabel,
    escapeHtml,
    toPlainOptions,
} = require('../utils/orderPresentation');

const toId = (value) => value?.toString?.() || String(value || '');
const checkoutFingerprintMatches = ({
    existingOrder,
    requestFingerprint,
    legacyRequestFingerprint,
    resolvedCurrency,
}) => {
    const storedFingerprint = existingOrder?.checkoutRequestFingerprint;
    if (!storedFingerprint || storedFingerprint === requestFingerprint) return true;
    if (!legacyRequestFingerprint || storedFingerprint !== legacyRequestFingerprint) return false;
    try {
        return getAccountingOrderCurrency(existingOrder) === resolvedCurrency;
    } catch (_) {
        return false;
    }
};
const invalidTaxConfigError = (message = 'The active tax configuration is invalid. Ask an administrator to correct it.') => {
    const error = new Error(message);
    error.statusCode = 503;
    error.code = 'TAX_CONFIG_INVALID';
    return error;
};
const checkoutStoredProductPricing = (product) => {
    // Raw currency-less legacy rows are canonical USD. Any metadata that is
    // actually present must be supported and internally consistent, and raw
    // persisted prices must already be exact cents. Display helpers are
    // intentionally tolerant and therefore must never sit on this charge path.
    const sourceCurrency = requireStoredProductCurrency(product, 'USD');
    const discountCurrency = requireStoredProductDiscountCurrency(product, sourceCurrency);
    const sourcePrice = requireStoredProductEffectivePrice(product);
    if (product.discountedPrice > 0 && discountCurrency !== sourceCurrency) {
        const error = new Error(`The stored price currencies for "${product?.name || 'a product'}" do not agree.`);
        error.statusCode = 409;
        error.code = 'PRODUCT_CURRENCY_METADATA_INVALID';
        throw error;
    }
    return { sourceCurrency, sourcePrice };
};
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
const normalizeCheckoutIdempotencyKey = (value) => {
    const key = String(value || '').trim();
    if (!key) return null;
    if (key.length > 160 || !/^[A-Za-z0-9:_\-.]+$/.test(key)) return null;
    return key;
};
const normalizeGuestCheckoutEmail = value => String(value || '').trim().toLowerCase();
const guestCheckoutIdempotencyKey = (email, clientKey) => (
    `guest:${crypto.createHash('sha256').update(email).digest('hex')}:${clientKey}`
);
const orderResponseSummary = (order) => {
    const totalAmount = order?.orderSummary?.totalAmount;
    if (
        typeof totalAmount !== 'number'
        || !Number.isFinite(totalAmount)
        || totalAmount < 0
        || roundMoney(totalAmount) !== totalAmount
    ) {
        const error = new Error('The stored order total is invalid and cannot be returned safely.');
        error.code = 'ORDER_MONEY_INVALID';
        error.statusCode = 409;
        throw error;
    }
    return {
        _id: order._id,
        orderId: order.orderId,
        totalAmount,
        currency: getAccountingOrderCurrency(order),
        email: order.shippingInfo?.email,
    };
};
const deleteUnpaidCheckoutOrder = (filter, reason = 'Checkout closed before payment.') => {
    const { _id: orderId, isPaid: _ignoredIsPaid, ...match } = filter || {};
    // A concurrent cancellation is a completed lifecycle transition and must
    // remain durable. Creator/recovery cleanup may delete only an order that is
    // still active; transaction conflicts protect a cancellation that begins
    // after this predicate is read.
    return deleteUnpaidOrderAndReleaseCoupons({
        orderId,
        reason,
        match: {
            orderStatus: { $ne: 'cancelled' },
            ...match,
        },
    });
};

const noChargeCheckoutResponse = (order, { idempotentReplay = false } = {}) => ({
    msg: idempotentReplay
        ? 'No payment was required; this order is already complete.'
        : 'Order completed successfully. No payment was required.',
    idempotentReplay,
    isPaid: true,
    completed: true,
    noPaymentRequired: true,
    paymentMethod: order.paymentMethod,
    paymentFlow: order.paymentFlow,
    orderId: order.orderId,
    order: orderResponseSummary(order),
});

const cleanupRejectedStripeCheckout = async (
    order,
    {
        reason,
        paymentSetupState = 'creating',
    } = {},
) => {
    let cleanup;
    try {
        cleanup = await deleteUnpaidCheckoutOrder({
            _id: order._id,
            awaitingPayment: true,
            paymentSetupState,
            stripePaymentIntentId: null,
            stripeSessionId: null,
        }, reason || 'Stripe definitively rejected the payment setup.');
    } catch (cleanupError) {
        const error = new Error(
            'The card payment was rejected, but checkout cleanup is still being confirmed. Retry this same checkout attempt.'
        );
        error.statusCode = 503;
        error.code = 'PAYMENT_ATTEMPT_RECOVERY_PENDING';
        error.cause = cleanupError;
        throw error;
    }

    if (cleanup?.deleted) return;
    const current = await Order.findById(order._id);
    if (!current) return;
    if (
        current.orderStatus === 'cancelled'
        && current.inventoryCommitted === false
        && current.paymentSetupState === 'closed'
    ) return;

    const error = new Error(
        'The card payment was rejected, but checkout cleanup is still being confirmed. Retry this same checkout attempt.'
    );
    error.statusCode = 503;
    error.code = 'PAYMENT_ATTEMPT_RECOVERY_PENDING';
    throw error;
};

const respondToAmountTooSmall = async (res, order) => {
    await cleanupRejectedStripeCheckout(order, {
        reason: 'Stripe rejected the positive order total as below the account minimum.',
    });
    return res.status(400).json({
        msg: 'This positive card total is below Stripe\'s current minimum for this account and currency. Add another item, reduce the coupon discount, or choose another payment method.',
        code: 'PAYMENT_AMOUNT_TOO_SMALL',
        paymentMethod: 'stripe',
        orderId: order.orderId,
        currency: order.currency,
        totalAmount: order.orderSummary?.totalAmount,
    });
};

const rejectDefinitiveStripeSetup = async (order, creationError, message) => {
    await cleanupRejectedStripeCheckout(order, {
        reason: 'Stripe definitively rejected the payment setup.',
    });
    const error = new Error(message);
    error.statusCode = 502;
    error.code = 'PAYMENT_ATTEMPT_REJECTED';
    error.cause = creationError;
    throw error;
};

const handleExistingStripeCreationError = async ({
    res,
    order,
    creationError,
    recoveryMessage,
    rejectionMessage,
}) => {
    // An existing `creating` row can be the result of an earlier ambiguous
    // request. Only an InvalidRequest response from the same deterministic key
    // while Stripe still guarantees that key's result can prove that no prior
    // external object exists. Authentication, permission, connection, API,
    // idempotency, and stale-key errors must retain the local reservation.
    const authoritativeRejection = isAuthoritativeStripeIdempotentReplayRejection(
        creationError,
        { createdAt: order.paymentSetupStartedAt },
    );
    if (!authoritativeRejection) {
        return res.status(502).json({
            msg: recoveryMessage,
            code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING',
            orderId: order.orderId,
        });
    }
    if (isAmountTooSmallForPositiveStripeOrder(creationError, order)) {
        return respondToAmountTooSmall(res, order);
    }
    await cleanupRejectedStripeCheckout(order, {
        reason: 'Stripe definitively rejected the payment setup.',
    });
    return res.status(502).json({
        msg: rejectionMessage,
        code: 'PAYMENT_ATTEMPT_REJECTED',
        orderId: order.orderId,
    });
};

const isAmountTooSmallForPositiveStripeOrder = (error, order) => (
    order?.paymentMethod === 'stripe'
    && getExpectedStripeTotalMinor(order) > 0
    && isAuthoritativeStripeAmountTooSmallError(error)
);

// Atomically cross the local -> Stripe creation boundary. Cancellation may
// safely win while state is `not_started`; once this guarded write wins,
// cancellation fails closed until the deterministic create response (or a
// signed webhook) attaches the exact external reference.
const claimStripeSetupCreation = async (order, { allowCreatingReplay = false } = {}) => {
    const paymentFlow = order.paymentFlow;
    const referenceField = paymentFlow === 'payment_sheet'
        ? 'stripePaymentIntentId'
        : 'stripeSessionId';
    if (
        order.paymentSetupState === 'creating'
        && !isStripeIdempotentReplayWithinAuthorityWindow({
            createdAt: order.paymentSetupStartedAt,
        })
    ) {
        const error = new Error(
            'This secure payment setup is too old for safe automatic replay and requires reconciliation.'
        );
        error.statusCode = 503;
        error.code = 'PAYMENT_SETUP_RECOVERY_REQUIRED';
        throw error;
    }
    const paymentSetupStartedAt = order.paymentSetupStartedAt || new Date();
    const claimed = await Order.findOneAndUpdate(
        {
            _id: order._id,
            paymentMethod: 'stripe',
            paymentFlow,
            isPaid: false,
            awaitingPayment: true,
            inventoryCommitted: true,
            orderStatus: { $ne: 'cancelled' },
            paymentSetupState: allowCreatingReplay
                ? { $in: ['not_started', 'creating'] }
                : 'not_started',
            $or: [
                { [referenceField]: null },
                { [referenceField]: '' },
                { [referenceField]: { $exists: false } },
            ],
        },
        { $set: { paymentSetupState: 'creating', paymentSetupStartedAt } },
        { new: true, runValidators: true, context: 'query' },
    );
    if (claimed) return claimed;

    const current = await Order.findById(order._id);
    const error = new Error(
        !current || current.orderStatus === 'cancelled' || current.paymentSetupState === 'closed'
            ? 'This secure payment attempt was cancelled before Stripe setup began.'
            : 'Secure payment setup is being recovered. Retry this same checkout attempt.'
    );
    error.statusCode = !current || current.orderStatus === 'cancelled' || current.paymentSetupState === 'closed'
        ? 409
        : 503;
    error.code = error.statusCode === 409
        ? 'CHECKOUT_ATTEMPT_EXPIRED'
        : 'PAYMENT_ATTEMPT_RECOVERY_PENDING';
    throw error;
};

const paymentIntentResponse = async (order, paymentIntent, { idempotentReplay = false } = {}) => {
    const customerAccess = await createMobileCustomerAccess(order.stripeCustomerId);
    return {
        msg: idempotentReplay ? 'Secure mobile payment resumed.' : 'Secure mobile payment is ready.',
        idempotentReplay,
        paymentFlow: 'payment_sheet',
        paymentIntentId: paymentIntent.id,
        paymentIntentClientSecret: paymentIntent.client_secret,
        customerId: order.stripeCustomerId,
        ...customerAccess,
        expiresAt: order.paymentExpiresAt,
        orderId: order.orderId,
        order: orderResponseSummary(order),
        ...getStripeMobileConfig(),
        consent: {
            usage: 'on_session',
            message: 'A card is saved only when the customer opts in inside Stripe PaymentSheet.',
        },
    };
};

const respondWithExistingCheckout = async (res, existingOrder) => {
    if (
        existingOrder.isPaid
        && existingOrder.awaitingPayment === false
        && isNoChargeOnlineOrder(existingOrder)
    ) {
        // The money/inventory transaction may have committed immediately
        // before the original HTTP request lost its response. Re-run only the
        // idempotent local cleanup so a same-key replay also repairs the cart.
        await consumeOrderCoupons({ orderId: existingOrder._id });
        await removeFulfilledOrderItemsFromCart({
            userId: existingOrder.user,
            orderItems: existingOrder.orderItems,
            fulfillmentId: existingOrder._id,
        });
        return res.status(200).json(noChargeCheckoutResponse(existingOrder, {
            idempotentReplay: true,
        }));
    }
    if (existingOrder.paymentMethod === 'stripe') {
        if (existingOrder.isPaid && !existingOrder.awaitingPayment) {
            return res.status(200).json({
                msg: 'Payment already completed.',
                idempotentReplay: true,
                isPaid: true,
                completed: true,
                noPaymentRequired: false,
                paymentMethod: 'stripe',
                paymentFlow: existingOrder.paymentFlow || 'checkout_session',
                id: existingOrder.stripeSessionId || existingOrder.stripePaymentIntentId,
                orderId: existingOrder.orderId,
                order: orderResponseSummary(existingOrder),
            });
        }
        if (existingOrder.paymentSetupState === 'closed' || existingOrder.orderStatus === 'cancelled') {
            return res.status(409).json({
                msg: 'This secure payment attempt is closed. Please start payment again.',
                code: 'CHECKOUT_ATTEMPT_EXPIRED',
                orderId: existingOrder.orderId,
            });
        }
        if (!stripe) {
            return res.status(503).json({
                msg: 'Online payments are not configured. Please contact support.',
                code: 'STRIPE_NOT_CONFIGURED',
                orderId: existingOrder.orderId,
            });
        }
        if (!existingOrder.stripeCustomerId) {
            try {
                const { customer } = await ensureStripeCustomerForUser(existingOrder.user);
                existingOrder.stripeCustomerId = customer.id;
                existingOrder.stripeMode = existingOrder.stripeMode || STRIPE_MODE;
                existingOrder.paymentExpiresAt = existingOrder.paymentExpiresAt || (
                    existingOrder.paymentFlow === 'payment_sheet'
                        ? createPaymentExpiry()
                        : new Date(Date.now() + 35 * 60 * 1000)
                );
                await existingOrder.save();
            } catch (customerError) {
                return res.status(502).json({
                    msg: 'Secure payment setup is still being recovered. Retry this same checkout attempt.',
                    code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING',
                    orderId: existingOrder.orderId,
                });
            }
        }
        if (existingOrder.paymentFlow === 'payment_sheet') {
            if (
                existingOrder.paymentExpiresAt
                && existingOrder.paymentExpiresAt <= new Date()
                && (
                    existingOrder.stripePaymentIntentId
                    || existingOrder.paymentSetupState === 'not_started'
                )
            ) {
                if (
                    !existingOrder.stripePaymentIntentId
                    && existingOrder.paymentSetupState === 'not_started'
                ) {
                    await deleteUnpaidCheckoutOrder({ _id: existingOrder._id, isPaid: false }).catch(() => {});
                    return res.status(409).json({
                        msg: 'This secure mobile payment attempt expired. Please start payment again.',
                        code: 'CHECKOUT_ATTEMPT_EXPIRED',
                        orderId: existingOrder.orderId,
                    });
                }
                const closed = await closeOrderPaymentIntent(existingOrder, {
                    status: 'expired',
                    reason: 'The secure mobile payment window expired.',
                    requireExpired: true,
                });
                if (closed?.status !== 'payment_succeeded') {
                    return res.status(409).json({
                        msg: 'This secure mobile payment attempt expired. Please start payment again.',
                        code: 'CHECKOUT_ATTEMPT_EXPIRED',
                        orderId: existingOrder.orderId,
                    });
                }
            }
            try {
                let paymentIntent;
                if (!existingOrder.stripePaymentIntentId) {
                    if (!existingOrder.inventoryCommitted) {
                        try {
                            await commitOrderInventory(existingOrder._id);
                            existingOrder.inventoryCommitted = true;
                        } catch (inventoryError) {
                            await deleteUnpaidCheckoutOrder({ _id: existingOrder._id, isPaid: false }).catch(() => {});
                            throw inventoryError;
                        }
                    }
                    existingOrder = await claimStripeSetupCreation(existingOrder, {
                        allowCreatingReplay: true,
                    });
                    try {
                        paymentIntent = await createNativeOrderPaymentIntent(existingOrder);
                    } catch (creationError) {
                        return handleExistingStripeCreationError({
                            res,
                            order: existingOrder,
                            creationError,
                            recoveryMessage: 'Secure mobile payment is still being recovered. Retry this same checkout attempt.',
                            rejectionMessage: 'Stripe could not prepare this secure payment. Please start payment again.',
                        });
                    }
                    existingOrder = await attachStripeOrderReference({
                        order: existingOrder,
                        stripeObject: paymentIntent,
                        paymentFlow: 'payment_sheet',
                    });
                } else {
                    try {
                        paymentIntent = await stripe.paymentIntents.retrieve(existingOrder.stripePaymentIntentId);
                    } catch (retrieveError) {
                        if (isAuthoritativeStripeResourceMissingError(retrieveError)) {
                            await deleteUnpaidCheckoutOrder({
                                _id: existingOrder._id,
                                isPaid: false,
                                awaitingPayment: true,
                            });
                            return res.status(409).json({
                                msg: 'This secure mobile payment attempt is no longer available. Please start payment again.',
                                code: 'CHECKOUT_ATTEMPT_EXPIRED',
                                orderId: existingOrder.orderId,
                            });
                        }
                        return res.status(502).json({
                            msg: 'Secure mobile payment is still being recovered. Retry this same checkout attempt.',
                            code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING',
                            orderId: existingOrder.orderId,
                        });
                    }
                }
                if (!existingOrder.inventoryCommitted) {
                    try {
                        await commitOrderInventory(existingOrder._id);
                        existingOrder.inventoryCommitted = true;
                    } catch (inventoryError) {
                        let closed;
                        try {
                            closed = await closeOrderPaymentIntent(existingOrder, {
                                status: 'cancelled',
                                reason: 'Inventory changed before the secure mobile payment could open.',
                            });
                        } catch (_) {
                            return res.status(502).json({
                                msg: 'Secure mobile payment cleanup is still being confirmed. Retry this same checkout attempt.',
                                code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING',
                                orderId: existingOrder.orderId,
                            });
                        }
                        if (closed?.status === 'payment_succeeded') {
                            const fulfillment = await fulfillStripeOrderPaymentIntent({
                                order: existingOrder,
                                paymentIntent: closed.paymentIntent,
                                eventId: `inventory-recovery:${closed.paymentIntent.id}`,
                            });
                            if (fulfillment?.paymentRefunded) {
                                return res.status(409).json({
                                    msg: 'Inventory changed after Stripe received the payment. The payment has been refunded.',
                                    code: 'ORDER_STOCK_CHANGED_AFTER_CAPTURE',
                                    paymentRefunded: true,
                                    orderId: existingOrder.orderId,
                                });
                            }
                            return res.status(202).json({
                                msg: 'Stripe received the payment. Final confirmation is processing.',
                                stripePaymentReceived: true,
                                paymentIntentId: closed.paymentIntent.id,
                                orderId: existingOrder.orderId,
                            });
                        }
                        throw inventoryError;
                    }
                }
                validateStripeOrderPaymentIntent(existingOrder, paymentIntent);
                if (
                    !['succeeded', 'canceled'].includes(paymentIntent.status)
                    && existingOrder.paymentExpiresAt
                    && existingOrder.paymentExpiresAt <= new Date()
                ) {
                    const closed = await closeOrderPaymentIntent(existingOrder, {
                        status: 'expired',
                        reason: 'The secure mobile payment window expired.',
                        requireExpired: true,
                    });
                    if (closed?.status === 'payment_succeeded') {
                        return res.status(202).json({
                            msg: 'Stripe received the payment. Final confirmation is processing.',
                            idempotentReplay: true,
                            paymentFlow: 'payment_sheet',
                            stripePaymentReceived: true,
                            paymentIntentId: paymentIntent.id,
                            orderId: existingOrder.orderId,
                            order: orderResponseSummary(existingOrder),
                        });
                    }
                    return res.status(409).json({
                        msg: 'This secure mobile payment attempt expired. Please start payment again.',
                        code: 'CHECKOUT_ATTEMPT_EXPIRED',
                        orderId: existingOrder.orderId,
                    });
                }
                if (paymentIntent.status === 'canceled') {
                    await deleteUnpaidCheckoutOrder({
                        _id: existingOrder._id,
                        isPaid: false,
                        awaitingPayment: true,
                    });
                    return res.status(409).json({
                        msg: 'This secure mobile payment attempt is closed. Please start payment again.',
                        code: 'CHECKOUT_ATTEMPT_EXPIRED',
                        orderId: existingOrder.orderId,
                    });
                }
                if (paymentIntent.status === 'succeeded') {
                    return res.status(202).json({
                        msg: 'Stripe received the payment. Final confirmation is processing.',
                        idempotentReplay: true,
                        paymentFlow: 'payment_sheet',
                        stripePaymentReceived: true,
                        paymentIntentId: paymentIntent.id,
                        orderId: existingOrder.orderId,
                        order: orderResponseSummary(existingOrder),
                    });
                }
                return res.status(200).json(await paymentIntentResponse(existingOrder, paymentIntent, {
                    idempotentReplay: true,
                }));
            } catch (error) {
                if (error?.code === 'PAYMENT_SETUP_RECOVERY_REQUIRED') {
                    return res.status(503).json({
                        msg: error.message,
                        code: error.code,
                        orderId: existingOrder.orderId,
                    });
                }
                if (error?.statusCode) throw error;
                return res.status(502).json({
                    msg: 'Secure mobile payment is still being recovered. Retry this same checkout attempt.',
                    code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING',
                    orderId: existingOrder.orderId,
                });
            }
        }
        if (!existingOrder.stripeSessionId) {
            if (
                existingOrder.paymentExpiresAt
                && existingOrder.paymentExpiresAt <= new Date()
                && existingOrder.paymentSetupState === 'not_started'
            ) {
                await deleteUnpaidCheckoutOrder({ _id: existingOrder._id, isPaid: false }).catch(() => {});
                return res.status(409).json({
                    msg: 'This secure checkout attempt expired. Please start payment again.',
                    code: 'CHECKOUT_ATTEMPT_EXPIRED',
                    orderId: existingOrder.orderId,
                });
            }
            try {
                if (!existingOrder.inventoryCommitted) {
                    try {
                        await commitOrderInventory(existingOrder._id);
                        existingOrder.inventoryCommitted = true;
                    } catch (inventoryError) {
                        await deleteUnpaidCheckoutOrder({ _id: existingOrder._id, isPaid: false }).catch(() => {});
                        throw inventoryError;
                    }
                }
                existingOrder = await claimStripeSetupCreation(existingOrder, {
                    allowCreatingReplay: true,
                });
                let recoveredSession;
                try {
                    recoveredSession = await createHostedOrderCheckoutSession(existingOrder);
                } catch (creationError) {
                    return handleExistingStripeCreationError({
                        res,
                        order: existingOrder,
                        creationError,
                        recoveryMessage: 'Secure checkout is still being recovered. Retry this same checkout attempt.',
                        rejectionMessage: 'Stripe could not prepare secure checkout. Please start payment again.',
                    });
                }
                existingOrder = await attachStripeOrderReference({
                    order: existingOrder,
                    stripeObject: recoveredSession,
                    paymentFlow: 'checkout_session',
                });
            } catch (error) {
                if (error?.code === 'PAYMENT_SETUP_RECOVERY_REQUIRED') {
                    return res.status(503).json({
                        msg: error.message,
                        code: error.code,
                        orderId: existingOrder.orderId,
                    });
                }
                if (error?.statusCode) throw error;
                return res.status(502).json({
                    msg: 'Secure checkout is still being recovered. Retry this same checkout attempt.',
                    code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING',
                    orderId: existingOrder.orderId,
                });
            }
        }
        if (!existingOrder.inventoryCommitted) {
            try {
                await commitOrderInventory(existingOrder._id);
                existingOrder.inventoryCommitted = true;
            } catch (inventoryError) {
                let checkoutSession;
                try {
                    checkoutSession = await stripe.checkout.sessions.retrieve(existingOrder.stripeSessionId);
                    validateStripeOrderSession(existingOrder, checkoutSession);
                    if (checkoutSession.payment_status === 'paid') {
                        const fulfillment = await fulfillStripeOrder({
                            order: existingOrder,
                            stripeSession: checkoutSession,
                            eventId: `inventory-recovery:${checkoutSession.id}`,
                        });
                        if (fulfillment?.paymentRefunded) {
                            return res.status(409).json({
                                msg: 'Inventory changed after Stripe received the payment. The payment has been refunded.',
                                code: 'ORDER_STOCK_CHANGED_AFTER_CAPTURE',
                                paymentRefunded: true,
                                orderId: existingOrder.orderId,
                            });
                        }
                        return res.status(202).json({
                            msg: 'Stripe received the payment. Final confirmation is processing.',
                            stripePaymentReceived: true,
                            id: checkoutSession.id,
                            orderId: existingOrder.orderId,
                        });
                    }
                    if (checkoutSession.status === 'open') {
                        try {
                            checkoutSession = await stripe.checkout.sessions.expire(checkoutSession.id);
                        } catch (_) {
                            checkoutSession = await stripe.checkout.sessions.retrieve(existingOrder.stripeSessionId);
                        }
                        validateStripeOrderSession(existingOrder, checkoutSession);
                    }
                } catch (_) {
                    return res.status(502).json({
                        msg: 'Secure checkout cleanup is still being confirmed. Retry this same checkout attempt.',
                        code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING',
                        orderId: existingOrder.orderId,
                    });
                }
                if (checkoutSession.payment_status === 'paid') {
                    const fulfillment = await fulfillStripeOrder({
                        order: existingOrder,
                        stripeSession: checkoutSession,
                        eventId: `inventory-recovery:${checkoutSession.id}`,
                    });
                    if (fulfillment?.paymentRefunded) {
                        return res.status(409).json({
                            msg: 'Inventory changed after Stripe received the payment. The payment has been refunded.',
                            code: 'ORDER_STOCK_CHANGED_AFTER_CAPTURE',
                            paymentRefunded: true,
                            orderId: existingOrder.orderId,
                        });
                    }
                    return res.status(202).json({
                        msg: 'Stripe received the payment. Final confirmation is processing.',
                        stripePaymentReceived: true,
                        id: checkoutSession.id,
                        orderId: existingOrder.orderId,
                    });
                }
                if (
                    checkoutSession.status !== 'expired'
                    && !(checkoutSession.status === 'complete' && checkoutSession.payment_status !== 'paid')
                ) {
                    return res.status(502).json({
                        msg: 'Secure checkout cleanup is still being confirmed. Retry this same checkout attempt.',
                        code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING',
                        orderId: existingOrder.orderId,
                    });
                }
                await deleteUnpaidCheckoutOrder({
                    _id: existingOrder._id,
                    isPaid: false,
                    awaitingPayment: true,
                });
                throw inventoryError;
            }
        }
        try {
            const session = await stripe.checkout.sessions.retrieve(existingOrder.stripeSessionId);
            validateStripeOrderSession(existingOrder, session);
            if (session?.status === 'expired') {
                await deleteUnpaidCheckoutOrder({ _id: existingOrder._id, isPaid: false }).catch(() => {});
                return res.status(409).json({
                    msg: 'This secure checkout attempt expired. Please start payment again.',
                    code: 'CHECKOUT_ATTEMPT_EXPIRED',
                    orderId: existingOrder.orderId,
                });
            }
            if (session?.status === 'complete' && session.payment_status === 'paid') {
                return res.status(202).json({
                    msg: 'Stripe received the payment. Final confirmation is processing.',
                    idempotentReplay: true,
                    paymentFlow: 'checkout_session',
                    stripePaymentReceived: true,
                    id: session.id,
                    orderId: existingOrder.orderId,
                    order: orderResponseSummary(existingOrder),
                });
            }
            if (session?.status === 'complete') {
                await deleteUnpaidCheckoutOrder({
                    _id: existingOrder._id,
                    isPaid: false,
                    awaitingPayment: true,
                });
                return res.status(409).json({
                    msg: 'This secure checkout did not complete. Please start payment again.',
                    code: 'CHECKOUT_ATTEMPT_EXPIRED',
                    orderId: existingOrder.orderId,
                });
            }
            if (!session?.url) {
                return res.status(502).json({
                    msg: 'Secure checkout is still being recovered. Retry this same checkout attempt.',
                    code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING',
                    orderId: existingOrder.orderId,
                });
            }
            return res.status(200).json({
                msg: 'Secure checkout resumed.',
                idempotentReplay: true,
                id: session.id,
                url: session.url,
                orderId: existingOrder.orderId,
                order: orderResponseSummary(existingOrder),
            });
        } catch (error) {
            if (isAuthoritativeStripeResourceMissingError(error)) {
                await deleteUnpaidCheckoutOrder({
                    _id: existingOrder._id,
                    isPaid: false,
                    awaitingPayment: true,
                });
                return res.status(409).json({
                    msg: 'This secure checkout attempt is no longer available. Please start payment again.',
                    code: 'CHECKOUT_ATTEMPT_EXPIRED',
                    orderId: existingOrder.orderId,
                });
            }
            return res.status(502).json({
                msg: 'Secure checkout is still being recovered. Retry this same checkout attempt.',
                code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING',
                orderId: existingOrder.orderId,
            });
        }
    }

    const complete = existingOrder.paymentMethod === 'cash_on_delivery'
        ? existingOrder.inventoryCommitted === true
        : existingOrder.isPaid === true;
    if (!complete) {
        return res.status(409).json({
            msg: 'This checkout is still being processed. Please retry in a moment.',
            code: 'CHECKOUT_IN_PROGRESS',
            orderId: existingOrder.orderId,
        });
    }
    await consumeOrderCoupons({ orderId: existingOrder._id });
    await removeFulfilledOrderItemsFromCart({
        userId: existingOrder.user,
        orderItems: existingOrder.orderItems,
        fulfillmentId: existingOrder._id,
    });
    return res.status(200).json({
        msg: existingOrder.paymentMethod === 'wallet'
            ? 'Order already paid with Rozare Wallet.'
            : 'Order already placed successfully.',
        idempotentReplay: true,
        isPaid: existingOrder.isPaid,
        completed: existingOrder.isPaid === true,
        noPaymentRequired: isNoChargeOnlineOrder(existingOrder),
        paymentMethod: existingOrder.paymentMethod,
        orderId: existingOrder.orderId,
        order: orderResponseSummary(existingOrder),
    });
};

if (process.env.NODE_ENV === 'test') {
    exports._respondWithExistingCheckout = respondWithExistingCheckout;
}

const getSellerProductIds = async (sellerId) => {
    const ids = await Product.find({ seller: sellerId }).distinct('_id');
    return ids.map(toId);
};

// True if any orderItem belongs to this seller (snapshot first, fallback to live product list).
const itemBelongsToSeller = (item, sellerId, sellerProductIds) => {
    // A persisted seller snapshot is authoritative. Only legacy order items
    // without one may fall back to the product's current owner.
    if (item.seller) return toId(item.seller) === toId(sellerId);
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

    const sellerShippingInfo = (order.sellerShipping || []).find(
        ss => toId(ss.seller) === toId(sellerId)
    );
    const sellerMoney = sellerOrderSummaryForItems(order, sellerId, sellerOrderItems);

    const obj = order.toObject ? order.toObject() : { ...order };
    const sellerFulfillment = sellerFulfillmentFor(order, sellerId);
    const sellerPolicy = (order.sellerPolicies || []).find(
        entry => toId(entry.seller) === toId(sellerId)
    );
    return {
        ...obj,
        orderStatus: sellerFulfillment?.status || obj.orderStatus,
        isDelivered: sellerFulfillment ? sellerFulfillment.status === 'delivered' : obj.isDelivered,
        deliveredAt: sellerFulfillment?.deliveredAt || obj.deliveredAt,
        orderItems: sellerOrderItems,
        // Strip other sellers' shipping selections from the seller's view
        sellerShipping: sellerShippingInfo ? [sellerShippingInfo] : [],
        shippingMethod: sellerShippingInfo
            ? { ...sellerShippingInfo.shippingMethod, seller: sellerId }
            : obj.shippingMethod,
        sellerFulfillment: sellerFulfillment ? [sellerFulfillment] : [],
        sellerPolicies: sellerPolicy ? [sellerPolicy] : [],
        orderSummary: {
            subtotal: sellerMoney.subtotal,
            shippingCost: sellerMoney.shippingCost,
            tax: sellerMoney.tax,
            couponDiscount: sellerMoney.couponDiscount,
            reconciliationAdjustment: sellerMoney.adjustment,
            totalAmount: sellerMoney.totalAmount,
        }
    };
};

const getSellerScopedOrders = async (query, sellerId, sort = null, { lean = false } = {}) => {
    const sellerProductIds = await getSellerProductIds(sellerId);

    // Match either by snapshot seller (new orders) OR by current product ownership (legacy).
    const sellerScope = sellerProductIds.length > 0
        ? {
            $or: [
                { 'orderItems.seller': sellerId },
                {
                    orderItems: {
                        $elemMatch: {
                            seller: null,
                            productId: { $in: sellerProductIds },
                        },
                    },
                },
            ],
        }
        : { 'orderItems.seller': sellerId };

    const baseQuery = { ...query };
    const requestedStatus = baseQuery.orderStatus;
    delete baseQuery.orderStatus;
    const conditions = [baseQuery, sellerScope];
    if (requestedStatus) {
        conditions.push({
            $or: [
                { sellerFulfillment: { $elemMatch: { seller: sellerId, status: requestedStatus } } },
                { 'sellerFulfillment.0': { $exists: false }, orderStatus: requestedStatus },
            ],
        });
    }
    const dbQuery = { $and: conditions };
    const finder = Order.find(dbQuery);
    if (sort) finder.sort(sort);
    const orders = lean ? await finder.lean() : await finder;
    return orders.map(order => buildSellerOrderView(order, sellerProductIds, sellerId));
};

exports.placeOrder = async (req, res) => {
    const { order } = req.body;
    // console.log(order);

    const userId = req.user?.id || null;
    const rawIdempotencyKey = req.headers['idempotency-key']
        || req.headers['x-idempotency-key']
        || order?.idempotencyKey;
    const clientCheckoutIdempotencyKey = normalizeCheckoutIdempotencyKey(rawIdempotencyKey);
    const guestEmail = !userId
        ? normalizeGuestCheckoutEmail(order?.shippingInfo?.email)
        : '';
    // The historical unique index includes null users. Prefixing a guest key
    // with a one-way email scope keeps different guests from colliding on the
    // same client-generated key while preserving deterministic retries.
    const checkoutIdempotencyKey = clientCheckoutIdempotencyKey && !userId
        ? guestCheckoutIdempotencyKey(guestEmail, clientCheckoutIdempotencyKey)
        : clientCheckoutIdempotencyKey;
    const checkoutIdentityFilter = checkoutIdempotencyKey
        ? (userId
            ? { user: userId, checkoutIdempotencyKey }
            : { user: null, guestEmail, checkoutIdempotencyKey })
        : null;
    const rawPaymentFlow = req.body?.paymentFlow ?? order?.paymentFlow ?? 'checkout_session';
    const rawClientSurface = req.body?.clientSurface
        ?? order?.clientSurface
        ?? (order?.platform === 'mobile' ? 'mobile' : 'web');
    let requestFingerprint = null;
    let legacyRequestFingerprint = null;
    let orderUser = null;
    let orderCurrency = null;

    try {
        if (rawIdempotencyKey && !clientCheckoutIdempotencyKey) {
            return res.status(400).json({
                msg: 'Invalid checkout attempt key.',
                code: 'INVALID_IDEMPOTENCY_KEY',
            });
        }
        if (!userId && checkoutIdempotencyKey && !guestEmail) {
            return res.status(400).json({
                msg: 'A guest checkout email is required to safely retry this order.',
                code: 'GUEST_CHECKOUT_EMAIL_REQUIRED',
            });
        }
        if (!['checkout_session', 'payment_sheet'].includes(rawPaymentFlow)) {
            return res.status(400).json({ msg: 'Choose a valid payment flow.', code: 'INVALID_PAYMENT_FLOW' });
        }
        if (!['web', 'mobile'].includes(rawClientSurface)) {
            return res.status(400).json({ msg: 'Choose a valid client surface.', code: 'INVALID_CLIENT_SURFACE' });
        }
        orderUser = userId ? await User.findById(userId).select('currency').lean() : null;
        const requestedOrderCurrency = order?.currency ?? orderUser?.currency ?? 'USD';
        if (!isSupportedCurrency(requestedOrderCurrency)) {
            return res.status(400).json({
                msg: 'Choose a supported checkout currency.',
                code: 'ORDER_CURRENCY_NOT_SUPPORTED',
            });
        }
        orderCurrency = normalizeCurrency(requestedOrderCurrency);
        requestFingerprint = checkoutRequestFingerprint(
            order,
            rawPaymentFlow,
            rawClientSurface,
            { resolvedCurrency: orderCurrency },
        );
        // Orders created before effective account currency was included in the
        // fingerprint used USD when the client omitted `order.currency`. Keep
        // those exact in-flight retries recoverable only when the persisted
        // order currency proves the same financial intent.
        legacyRequestFingerprint = checkoutRequestFingerprint(order, rawPaymentFlow, rawClientSurface);
        if (checkoutIdentityFilter) {
            const existingOrder = await Order.findOne(checkoutIdentityFilter)
                .select('+checkoutRequestFingerprint');
            if (existingOrder) {
                if (!checkoutFingerprintMatches({
                    existingOrder,
                    requestFingerprint,
                    legacyRequestFingerprint,
                    resolvedCurrency: orderCurrency,
                })) {
                    return res.status(409).json({
                        msg: 'This checkout attempt key was already used with different order details.',
                        code: 'IDEMPOTENCY_CONFLICT',
                    });
                }
                return respondWithExistingCheckout(res, existingOrder);
            }
        }
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
        // Freeze one authoritative international destination at checkout. A
        // domestic number is resolved only from the selected shipping country;
        // there is deliberately no Pakistan (or any other) default guess.
        const shippingPhoneSnapshot = canonicalizeShippingPhone(order.shippingInfo);
        const normalizedPaymentMethod = ['stripe', 'cash_on_delivery', 'wallet'].includes(order.paymentMethod)
            ? order.paymentMethod
            : null;
        if (!normalizedPaymentMethod) {
            return res.status(400).json({ msg: 'Choose a valid payment method.' });
        }
        const isNativeStripePayment = normalizedPaymentMethod === 'stripe' && rawPaymentFlow === 'payment_sheet';
        if (rawPaymentFlow === 'payment_sheet' && !isNativeStripePayment) {
            return res.status(400).json({
                msg: 'Stripe PaymentSheet can only be used for card orders.',
                code: 'PAYMENT_FLOW_METHOD_MISMATCH',
            });
        }
        if (isNativeStripePayment && rawClientSurface !== 'mobile') {
            return res.status(400).json({
                msg: 'Stripe PaymentSheet is available only in the mobile app.',
                code: 'PAYMENT_SHEET_MOBILE_ONLY',
            });
        }
        if (!checkoutIdempotencyKey) {
            return res.status(400).json({
                msg: 'A checkout attempt key is required for every order.',
                code: 'IDEMPOTENCY_KEY_REQUIRED',
            });
        }
        if (normalizedPaymentMethod === 'wallet' && !userId) {
            return res.status(401).json({
                msg: 'Log in to pay with Rozare Wallet.',
                code: 'WALLET_LOGIN_REQUIRED',
            });
        }

        // console.log(order.orderItems);

        const exchangeRateSnapshot = await getExchangeRateSnapshot();
        const checkoutRates = exchangeRateSnapshot.rates;
        const trustedCheckoutRates = snapshotIsTrustedForConversion(exchangeRateSnapshot);
        // Seller accounting is USD-denominated even when the buyer and every
        // product use the same non-USD currency. Freeze that conversion at the
        // checkout boundary; otherwise a later summary, return, withdrawal, or
        // reversal could value one PKR/EUR/GBP order using a different day's FX.
        if (orderCurrency !== 'USD' && !trustedCheckoutRates) {
            const err = new Error('Live exchange rates are temporarily unavailable. Please retry checkout shortly.');
            err.statusCode = 503;
            err.code = 'EXCHANGE_RATES_UNAVAILABLE';
            throw err;
        }

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
        let codRestrictedSellerNames = [];
        let storeBySeller = new Map();
        if (sellerIdsInOrder.length > 0) {
            const stores = await Store.find({ seller: { $in: sellerIdsInOrder }, isActive: true })
                .select('seller storeName visibility paymentPolicy returnPolicy productCurrency');
            storeBySeller = new Map(stores.map(store => [toId(store.seller), store]));
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
            codRestrictedSellerNames = sellerIdsInOrder
                .map(sellerId => storeBySeller.get(sellerId))
                .filter(store => store && !storeAllowsCashOnDelivery(store))
                .map(store => store.storeName || 'A seller');
            if (normalizedPaymentMethod === 'cash_on_delivery' && codRestrictedSellerNames.length > 0) {
                return res.status(400).json({
                    msg: `Cash on Delivery is not available for this cart because ${codRestrictedSellerNames.join(', ')} ${codRestrictedSellerNames.length === 1 ? 'accepts' : 'accept'} online payment only. Please pay by card or Rozare Wallet, or remove those items.`,
                    code: 'COD_NOT_AVAILABLE_FOR_CART',
                    advanceOnlySellers: codRestrictedSellerNames,
                });
            }
        }

        const nativeOrderItems = order.orderItems.map((item) => {
            const product = productById.get(toId(item.id));
            if (!product) return null;
            const quantity = parsePositiveSafeInteger(item.quantity, { fallback: 1 });
            if (quantity === null) {
                const err = new Error(`Choose a whole-number quantity of at least 1 for "${product.name}".`);
                err.statusCode = 400;
                err.code = 'ORDER_QUANTITY_INVALID';
                throw err;
            }
            if (quantity > product.stock) {
                const err = new Error(`Only ${product.stock} unit${product.stock !== 1 ? 's' : ''} of "${product.name}" are available.`);
                err.statusCode = 400;
                throw err;
            }
            const store = storeBySeller.get(toId(product.seller));
            // A raw legacy product with no currency metadata is canonical USD;
            // Store.productCurrency only governs newly written native prices.
            const { sourceCurrency, sourcePrice } = checkoutStoredProductPricing(product);
            const effectiveReturnPolicy = product.returnPolicy?.useStorePolicy === false
                ? normalizeReturnPolicy(product.returnPolicy)
                : normalizeReturnPolicy(store?.returnPolicy || {});
            return {
                productId: product._id,
                seller: product.seller || null,
                name: product.name,
                image: product.image,
                sourcePrice,
                sourceCurrency,
                priceOriginal: sourcePrice,
                priceCurrency: sourceCurrency,
                quantity,
                selectedColor: item.selectedColor || null,
                selectedOptions: item.selectedOptions || undefined,
                returnPolicySnapshotVersion: 1,
                returnPolicy: effectiveReturnPolicy,
            };
        });
        const normalizedOrderItems = priceOrderItemLines({
            items: nativeOrderItems,
            targetCurrency: orderCurrency,
            exchangeRates: checkoutRates,
            exchangeRatesFallback: !trustedCheckoutRates,
        });

        // Native line totals are converted and rounded once per source-currency
        // bucket, then allocated exactly across its items.
        const subtotal = sumMoney(normalizedOrderItems.map(getOrderItemLineSubtotal));

        // Reload shipping methods and coupons from MongoDB. Browser/mobile
        // amounts are display hints only and never determine the charged total.
        const [shippingPricing, couponPricing] = await Promise.all([
            validateAndPriceShipping({
                requestedSellerShipping: order.sellerShipping,
                fallbackShippingMethod: order.shippingMethod,
                sellerIds: sellerIdsInOrder,
                sellerCurrencies: new Map(sellerIdsInOrder.map(sellerId => [
                    sellerId,
                    storeBySeller.get(sellerId)?.productCurrency || 'USD',
                ])),
                orderCurrency,
                exchangeRates: checkoutRates,
                exchangeRatesFallback: !trustedCheckoutRates,
            }),
            validateAndPriceCoupons({
                requestedCoupons: order.appliedCoupons,
                orderItems: normalizedOrderItems,
                userId,
                orderCurrency,
                exchangeRates: checkoutRates,
                exchangeRatesFallback: !trustedCheckoutRates,
            }),
        ]);
        const shippingCost = shippingPricing.shippingCost;

        // Fetch tax configuration and calculate tax
        let tax = 0;
        const taxConfig = await TaxConfig.findOne({ isActive: true });
        if (taxConfig) {
            const taxType = taxConfig.type;
            const rawTaxValue = taxConfig.value;
            const taxCurrencyIsSchemaDefault = typeof taxConfig.$isDefault === 'function'
                && taxConfig.$isDefault('currency');
            const plainTaxConfig = taxConfig.toObject ? taxConfig.toObject() : taxConfig;
            const hasStoredTaxCurrency = !taxCurrencyIsSchemaDefault
                && Object.prototype.hasOwnProperty.call(plainTaxConfig, 'currency')
                && plainTaxConfig.currency !== undefined;
            const rawTaxCurrency = hasStoredTaxCurrency ? taxConfig.currency : 'USD';
            if (!['none', 'percentage', 'fixed'].includes(taxType)) {
                throw invalidTaxConfigError();
            }
            if (
                typeof rawTaxValue !== 'number'
                || !Number.isFinite(rawTaxValue)
                || rawTaxValue < 0
                || (taxType === 'none' && rawTaxValue !== 0)
                || (taxType === 'percentage' && rawTaxValue > 100)
                || typeof rawTaxCurrency !== 'string'
                || !rawTaxCurrency.trim()
                || !isSupportedCurrency(rawTaxCurrency)
                || rawTaxCurrency !== rawTaxCurrency.trim().toUpperCase()
            ) {
                throw invalidTaxConfigError();
            }
            try {
                if (taxType === 'fixed' && roundMoney(rawTaxValue) !== rawTaxValue) {
                    throw invalidTaxConfigError();
                }
                // Percentage rates may use up to six decimals; fixed values
                // are exact cents. Both must stay inside safe accounting range.
                toMinorUnits(rawTaxValue, taxType === 'percentage' ? 6 : 2);
            } catch (error) {
                if (error?.code === 'TAX_CONFIG_INVALID') throw error;
                throw invalidTaxConfigError();
            }
            const taxCurrency = normalizeCurrency(rawTaxCurrency);
            // A fixed value is native money, so decide whether it exists at
            // its own minor-unit boundary. Exact zero must not make an
            // otherwise all-USD checkout depend on FX. Conversely, a real
            // source cent still requires trusted FX even when conversion
            // happens to round below one buyer-currency cent.
            const fixedTaxSourceMinor = taxType === 'fixed'
                ? toMinorUnits(rawTaxValue)
                : 0;
            if (
                taxType === 'fixed'
                && fixedTaxSourceMinor > 0
                && !trustedCheckoutRates
                && taxCurrency !== orderCurrency
            ) {
                const err = new Error('Live exchange rates are temporarily unavailable. Please retry checkout shortly.');
                err.statusCode = 503;
                err.code = 'EXCHANGE_RATES_UNAVAILABLE';
                throw err;
            }
            tax = taxType === 'fixed'
                ? (fixedTaxSourceMinor === 0
                    ? 0
                    : convertAmountWithRates(
                        fromMinorUnits(fixedTaxSourceMinor),
                        taxCurrency,
                        orderCurrency,
                        checkoutRates
                    ))
                : calculateTax(subtotal, taxConfig);
        }

        const couponDiscount = couponPricing.couponDiscount;

        // Final total
        const subtotalRounded = roundMoney(subtotal);
        const shippingCostRounded = roundMoney(shippingCost);
        const taxRounded = roundMoney(tax);
        const couponDiscountRounded = roundMoney(couponDiscount);
        if (couponDiscountRounded > subtotalRounded) {
            const error = new Error('The calculated coupon discount exceeds the product subtotal.');
            error.statusCode = 409;
            error.code = 'ORDER_TOTAL_MISMATCH';
            throw error;
        }
        const totalAmount = sumMoney([
            subtotalRounded,
            shippingCostRounded,
            taxRounded,
            -couponDiscountRounded,
        ]);
        if (totalAmount < 0) {
            const error = new Error('The calculated order total is invalid.');
            error.statusCode = 409;
            error.code = 'ORDER_TOTAL_MISMATCH';
            throw error;
        }
        const authoritativeOrderSummary = {
            subtotal: subtotalRounded,
            shippingCost: shippingCostRounded,
            tax: taxRounded,
            couponDiscount: couponDiscountRounded,
            totalAmount,
        };
        // `orderSummary` is the exact amount the buyer reviewed. Product,
        // delivery, coupon, tax, or FX state can change between render and the
        // click. Never debit Wallet, commit COD, reserve stock/coupons, or
        // create a Stripe payment for different cents. Return the fresh quote
        // without mutating anything and require another explicit confirmation.
        const summaryFields = Object.keys(authoritativeOrderSummary);
        const expectedSummaryMinor = {};
        for (const field of summaryFields) {
            const parsed = parseStrictFiniteNumber(order.orderSummary?.[field]);
            if (parsed === null || parsed < 0) {
                return res.status(400).json({
                    msg: 'The checkout total shown by the client is invalid. Refresh checkout and try again.',
                    code: 'CHECKOUT_EXPECTED_TOTAL_INVALID',
                });
            }
            try {
                expectedSummaryMinor[field] = toMinorUnits(parsed);
            } catch (_) {
                return res.status(400).json({
                    msg: 'The checkout total shown by the client is outside the supported money range.',
                    code: 'CHECKOUT_EXPECTED_TOTAL_INVALID',
                });
            }
        }
        const changedSummaryFields = summaryFields.filter(field => (
            expectedSummaryMinor[field] !== toMinorUnits(authoritativeOrderSummary[field])
        ));
        if (changedSummaryFields.length) {
            return res.status(409).json({
                msg: 'Your checkout total changed before the order was placed. Review the refreshed total and confirm again.',
                code: 'CHECKOUT_REPRICE_REQUIRED',
                currency: orderCurrency,
                orderSummary: authoritativeOrderSummary,
                changedFields: changedSummaryFields,
            });
        }
        // console.log("cartItems::::", cartItems);


        const newOrder = new Order({
            ...(userId ? { user: userId } : {}),
            ...(checkoutIdempotencyKey ? { checkoutIdempotencyKey } : {}),
            ...(checkoutIdempotencyKey ? { checkoutRequestFingerprint: requestFingerprint } : {}),
            guestEmail: !userId ? guestEmail : null,
            currency: orderCurrency,
            ...(trustedCheckoutRates ? { exchangeRateSnapshot: {
                base: 'USD',
                rates: checkoutRates,
                capturedAt: new Date(exchangeRateSnapshot.capturedAt),
                source: exchangeRateSnapshot.source,
                fallback: exchangeRateSnapshot.fallback,
            } } : {}),
            // Ten random bytes plus the database uniqueness guard make the
            // human-facing id collision-resistant. Provider routing still
            // uses this order's immutable Mongo _id as the authority.
            orderId: `ORD-${Date.now()}-${crypto.randomBytes(10).toString('hex').toUpperCase()}`,
            orderIdVersion: 2,

            orderItems: normalizedOrderItems,

            shippingInfo: {
                fullName: order.shippingInfo.fullName,
                email: order.shippingInfo.email,
                phone: shippingPhoneSnapshot.e164,
                phoneE164: shippingPhoneSnapshot.e164,
                address: order.shippingInfo.address,
                city: order.shippingInfo.city,
                state: order.shippingInfo.state,
                postalCode: order.shippingInfo.postalCode,
                country: order.shippingInfo.country,
                countryCode: shippingPhoneSnapshot.countryCode,
            },

            shippingMethod: {
                name: shippingPricing.primaryShipping.shippingMethod.name,
                price: shippingPricing.primaryShipping.shippingMethod.price,
                estimatedDays: shippingPricing.primaryShipping.shippingMethod.estimatedDays,
                seller: shippingPricing.primaryShipping.seller,
            },

            sellerShipping: shippingPricing.sellerShipping,

            orderSummary: authoritativeOrderSummary,

            sellerFulfillment: sellerIdsInOrder.map(sellerId => ({
                seller: sellerId,
                status: 'pending',
                deliveredAt: null,
                updatedAt: new Date(),
            })),

            sellerPolicies: sellerIdsInOrder.map(sellerId => {
                const store = storeBySeller.get(sellerId);
                return {
                    seller: sellerId,
                    store: store?._id || null,
                    storeName: store?.storeName || '',
                    paymentPolicy: store?.paymentPolicy || 'online_and_cod',
                    returnPolicy: normalizeReturnPolicy(store?.returnPolicy || {}),
                };
            }),

            appliedCoupons: couponPricing.appliedCoupons,

            tracking: {
                tiktokPlaceOrderEventId: order.tracking?.tiktokPlaceOrderEventId || null,
                tiktokPurchaseEventId: order.tracking?.tiktokPurchaseEventId || null,
                pageUrl: order.tracking?.pageUrl || '',
                referrer: order.tracking?.referrer || '',
                ttclid: order.tracking?.ttclid || '',
                ttp: order.tracking?.ttp || '',
            },

            // ✅ Schema expects just string ("stripe" | "cash_on_delivery")
            paymentMethod: normalizedPaymentMethod,
            paymentFlow: isNativeStripePayment ? 'payment_sheet' : 'checkout_session',
            clientSurface: rawClientSurface,
            paymentSetupState: normalizedPaymentMethod === 'stripe' ? 'not_started' : 'closed',
            ...(normalizedPaymentMethod === 'stripe' ? {
                stripeMode: STRIPE_MODE,
                paymentExpiresAt: isNativeStripePayment
                    ? createPaymentExpiry()
                    : new Date(Date.now() + 35 * 60 * 1000),
            } : {}),
        });
        newOrder.sellerSettlementVersion = SELLER_SETTLEMENT_VERSION;
        newOrder.sellerSettlement = buildOrderSellerSettlement(newOrder, {
            requireOrderTotal: true,
        });
        // Enforce Stripe's documented eight-digit charge ceiling before this
        // order, coupon reservation, inventory reservation, Stripe customer,
        // or payment object can be created. Zero remains valid here because it
        // is completed by the local no-charge path below.
        if (newOrder.paymentMethod === 'stripe') {
            getStripeOrderChargeAmountMinor(newOrder, { allowZero: true });
            if (newOrder.paymentFlow === 'checkout_session') {
                const returnUrls = buildOrderCheckoutReturnUrls(newOrder);
                newOrder.stripeCheckoutSuccessUrl = returnUrls.successUrl;
                newOrder.stripeCheckoutCancelUrl = returnUrls.cancelUrl;
            }
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

        // CRITICAL: online-payment orders start as "awaiting payment" and are HIDDEN from
        // every dashboard until the Stripe webhook confirms payment. This prevents
        // abandoned-checkout orders from appearing as real orders to sellers.
        if (!isCOD) {
            newOrder.awaitingPayment = true;
        }

        const noPaymentRequired = !isCOD && isNoChargeOnlineOrder(newOrder);
        let paidOrder = null;
        let noChargeOrder = null;
        try {
            // No inserted intermediate order is visible: pricing snapshots,
            // coupon capacity, and every local immediate-payment mutation
            // commit or roll back together.
            await mongoose.connection.transaction(async session => {
                await newOrder.save({ session });
                if (newOrder.appliedCoupons.length > 0) {
                    await reserveOrderCoupons({ orderId: newOrder._id, userId, session });
                }
                if (isCOD) {
                    await commitOrderInventoryAndCoupons(newOrder._id, { session });
                } else if (noPaymentRequired) {
                    const completion = await completeNoChargeOrder({
                        orderId: newOrder._id,
                        session,
                    });
                    noChargeOrder = completion.order;
                } else if (newOrder.paymentMethod === 'wallet') {
                    paidOrder = await payOrderWithWallet({ orderId: newOrder._id, userId, session });
                }
                const immediateFulfilledOrder = isCOD
                    ? newOrder
                    : (noChargeOrder || paidOrder);
                if (immediateFulfilledOrder) {
                    await removeFulfilledOrderItemsFromCart({
                        userId,
                        orderItems: immediateFulfilledOrder.orderItems,
                        fulfillmentId: immediateFulfilledOrder._id,
                        session,
                    });
                }
                if (isCOD) {
                    const persistedCodOrder = await Order.findById(newOrder._id).session(session);
                    await enqueueCodOrderBuyerConfirmationNotification(persistedCodOrder, { session });
                    for (const sellerId of [...new Set(
                        (persistedCodOrder?.sellerSettlement || [])
                            .map(entry => toId(entry?.seller))
                            .filter(Boolean)
                    )]) {
                        await enqueueCodOrderSellerNotifications(
                            persistedCodOrder,
                            sellerId,
                            { session }
                        );
                    }
                }
            }, {
                readConcern: { level: 'snapshot' },
                writeConcern: { w: 'majority' },
            });
        } catch (checkoutCommitError) {
            // Let the outer idempotency handler resolve a concurrent winner.
            // Returning a Wallet error here would turn a safe same-key race
            // into a false 500 even though the original order committed.
            if (checkoutCommitError?.code === 11000 && checkoutIdempotencyKey) {
                throw checkoutCommitError;
            }
            if (newOrder.paymentMethod === 'wallet') {
                return res.status(checkoutCommitError.statusCode || 500).json({
                    msg: checkoutCommitError.message || 'Rozare Wallet payment failed.',
                    code: checkoutCommitError.code,
                    availableBalance: checkoutCommitError.availableBalance,
                    currency: checkoutCommitError.currency,
                });
            }
            throw checkoutCommitError;
        }
        if (noChargeOrder) {
            // Buyer and seller receipts were inserted into the durable outbox
            // in the same transaction that completed this zero-total order.

            // Idempotent recovery fallback for an older order/transaction that
            // committed before cart cleanup became part of the same transaction.
            await removeFulfilledOrderItemsFromCart({
                userId,
                orderItems: noChargeOrder.orderItems,
                fulfillmentId: noChargeOrder._id,
            });
            trackOrderEvent({
                event: 'PlaceAnOrder',
                req,
                order: noChargeOrder,
                eventId: noChargeOrder.tracking?.tiktokPlaceOrderEventId,
                tracking: noChargeOrder.tracking || {},
            }).catch(() => {});
            trackOrderEvent({
                event: 'Purchase',
                req,
                order: noChargeOrder,
                eventId: noChargeOrder.tracking?.tiktokPurchaseEventId,
                tracking: noChargeOrder.tracking || {},
            }).catch(() => {});

            return res.status(200).json(noChargeCheckoutResponse(noChargeOrder));
        }

        // COD buyer email/interactive WhatsApp and every role-scoped seller
        // channel were inserted atomically with the order transaction.

        // const domainURL = process.env.FRONTEND_URL || 'http://localhost:5173'

        if (newOrder.paymentMethod === 'wallet') {
            // Wallet debit, paid-order state, and role-scoped notification
            // outbox rows committed atomically in payOrderWithWallet().

            await removeFulfilledOrderItemsFromCart({
                userId,
                orderItems: paidOrder.orderItems,
                fulfillmentId: paidOrder._id,
            });
            trackOrderEvent({
                event: 'PlaceAnOrder',
                req,
                order: paidOrder,
                eventId: paidOrder.tracking?.tiktokPlaceOrderEventId,
                tracking: paidOrder.tracking || {},
            }).catch(() => {});
            trackOrderEvent({
                event: 'Purchase',
                req,
                order: paidOrder,
                eventId: paidOrder.tracking?.tiktokPurchaseEventId,
                tracking: paidOrder.tracking || {},
            }).catch(() => {});

            return res.status(200).json({
                msg: 'Order paid successfully with Rozare Wallet.',
                paymentMethod: 'wallet',
                orderId: paidOrder.orderId,
                order: {
                    _id: paidOrder._id,
                    orderId: paidOrder.orderId,
                    totalAmount: paidOrder.orderSummary.totalAmount,
                    currency: paidOrder.currency,
                },
            });
        }

        if (newOrder.paymentMethod === 'cash_on_delivery') {
            await removeFulfilledOrderItemsFromCart({
                userId,
                orderItems: newOrder.orderItems,
                fulfillmentId: newOrder._id,
            });

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
            await deleteUnpaidCheckoutOrder({ _id: newOrder._id });
            return res.status(400).json({
                msg: codRestrictedSellerNames.length > 0
                    ? `Card payments are not available in ${newOrder.currency} yet, and this cart contains sellers who accept online payment only. Please switch checkout currency or remove those items.`
                    : `Card payments are not available in ${newOrder.currency} yet. Please choose cash on delivery or switch checkout currency.`,
            });
        }
        if (!stripe) {
            await deleteUnpaidCheckoutOrder({ _id: newOrder._id, awaitingPayment: true });
            return res.status(503).json({
                msg: 'Online payments are not configured. Please contact support.',
                code: 'STRIPE_NOT_CONFIGURED',
            });
        }

        let stripeCustomer;
        try {
            ({ customer: stripeCustomer } = await ensureStripeCustomerForUser(userId));
            newOrder.stripeCustomerId = stripeCustomer.id;
            await newOrder.save();
        } catch (customerError) {
            await deleteUnpaidCheckoutOrder({ _id: newOrder._id, awaitingPayment: true }).catch(() => {});
            throw customerError;
        }

        // Reserve stock before creating a payable Stripe object. If Stripe's
        // response is ambiguous, the same local order/key retains this
        // reservation while an exact idempotent retry recovers the object.
        try {
            await commitOrderInventory(newOrder._id);
            newOrder.inventoryCommitted = true;
        } catch (inventoryError) {
            await deleteUnpaidCheckoutOrder({ _id: newOrder._id, isPaid: false }).catch(() => {});
            throw inventoryError;
        }

        if (isNativeStripePayment) {
            let paymentIntent;
            let stripeOrder = await claimStripeSetupCreation(newOrder);
            try {
                paymentIntent = await createNativeOrderPaymentIntent(stripeOrder);
            } catch (creationError) {
                if (isAmountTooSmallForPositiveStripeOrder(creationError, stripeOrder)) {
                    return respondToAmountTooSmall(res, stripeOrder);
                }
                if (!isDefinitiveStripeCreationError(creationError)) {
                    const recoveryError = new Error(
                        'Secure mobile payment is being recovered. Retry this same checkout attempt.'
                    );
                    recoveryError.statusCode = 502;
                    recoveryError.code = 'PAYMENT_ATTEMPT_RECOVERY_PENDING';
                    recoveryError.cause = creationError;
                    throw recoveryError;
                }
                await rejectDefinitiveStripeSetup(
                    stripeOrder,
                    creationError,
                    'Stripe could not prepare this secure payment. Please try again.',
                );
            }

            try {
                stripeOrder = await attachStripeOrderReference({
                    order: stripeOrder,
                    stripeObject: paymentIntent,
                    paymentFlow: 'payment_sheet',
                });
            } catch (persistenceError) {
                const recoveryError = new Error(
                    'Secure mobile payment is being recovered. Retry this same checkout attempt.'
                );
                recoveryError.statusCode = 502;
                recoveryError.code = 'PAYMENT_ATTEMPT_RECOVERY_PENDING';
                recoveryError.cause = persistenceError;
                throw recoveryError;
            }

            let nativePaymentResponse;
            try {
                nativePaymentResponse = await paymentIntentResponse(stripeOrder, paymentIntent);
            } catch (customerSessionError) {
                let closed;
                try {
                    closed = await closeOrderPaymentIntent(stripeOrder, {
                        status: 'cancelled',
                        reason: 'Stripe CustomerSession preparation failed before PaymentSheet opened.',
                    });
                } catch (cleanupError) {
                    const recoveryError = new Error(
                        'Secure mobile payment cleanup is still being confirmed. Retry this same checkout attempt.'
                    );
                    recoveryError.statusCode = 503;
                    recoveryError.code = 'PAYMENT_ATTEMPT_RECOVERY_PENDING';
                    recoveryError.cause = cleanupError;
                    throw recoveryError;
                }
                if (closed?.status === 'payment_succeeded') {
                    return res.status(202).json({
                        msg: 'Stripe received the payment. Final confirmation is processing.',
                        paymentFlow: 'payment_sheet',
                        stripePaymentReceived: true,
                        paymentIntentId: paymentIntent.id,
                        orderId: stripeOrder.orderId,
                        order: orderResponseSummary(stripeOrder),
                    });
                }
                const preparationError = new Error(
                    'Secure mobile payment could not open. The payment attempt was closed and reserved inventory was released.'
                );
                preparationError.statusCode = 503;
                preparationError.code = 'PAYMENT_SHEET_PREPARATION_FAILED';
                preparationError.cause = customerSessionError;
                throw preparationError;
            }

            trackOrderEvent({
                event: 'PlaceAnOrder',
                req,
                order: stripeOrder,
                eventId: stripeOrder.tracking?.tiktokPlaceOrderEventId,
                tracking: stripeOrder.tracking || {},
            }).catch(() => {});

            res.set('Cache-Control', 'no-store, private, max-age=0');
            return res.status(201).json(nativePaymentResponse);
        }

        let session;
        let stripeOrder = await claimStripeSetupCreation(newOrder);
        try {
            session = await createHostedOrderCheckoutSession(stripeOrder);
        } catch (creationError) {
            if (isAmountTooSmallForPositiveStripeOrder(creationError, stripeOrder)) {
                return respondToAmountTooSmall(res, stripeOrder);
            }
            if (!isDefinitiveStripeCreationError(creationError)) {
                const recoveryError = new Error(
                    'Secure checkout is being recovered. Retry this same checkout attempt.'
                );
                recoveryError.statusCode = 502;
                recoveryError.code = 'PAYMENT_ATTEMPT_RECOVERY_PENDING';
                recoveryError.cause = creationError;
                throw recoveryError;
            }
            await rejectDefinitiveStripeSetup(
                stripeOrder,
                creationError,
                'Stripe could not prepare secure checkout. Please try again.',
            );
        }

        // Persist the Stripe session ID through the same guarded attachment
        // used by signed webhook recovery.
        try {
            stripeOrder = await attachStripeOrderReference({
                order: stripeOrder,
                stripeObject: session,
                paymentFlow: 'checkout_session',
            });
        } catch (persistenceError) {
            const recoveryError = new Error(
                'Secure checkout is being recovered. Retry this same checkout attempt.'
            );
            recoveryError.statusCode = 502;
            recoveryError.code = 'PAYMENT_ATTEMPT_RECOVERY_PENDING';
            recoveryError.cause = persistenceError;
            throw recoveryError;
        }

        trackOrderEvent({
            event: 'PlaceAnOrder',
            req,
            order: stripeOrder,
            eventId: stripeOrder.tracking?.tiktokPlaceOrderEventId,
            tracking: stripeOrder.tracking || {},
        }).catch(() => {});

        return res.status(201).json({
            id: session.id,
            url: session.url,
            order: {
                orderId: stripeOrder.orderId,
                totalAmount: stripeOrder.orderSummary.totalAmount,
                currency: stripeOrder.currency,
            },
        });
    } catch (error) {
        if (error?.code === 11000 && checkoutIdentityFilter) {
            const existingOrder = await Order.findOne(checkoutIdentityFilter)
                .select('+checkoutRequestFingerprint')
                .catch(() => null);
            if (existingOrder) {
                if (!checkoutFingerprintMatches({
                    existingOrder,
                    requestFingerprint,
                    legacyRequestFingerprint,
                    resolvedCurrency: orderCurrency,
                })) {
                    return res.status(409).json({
                        msg: 'This checkout attempt key was already used with different order details.',
                        code: 'IDEMPOTENCY_CONFLICT',
                    });
                }
                return respondWithExistingCheckout(res, existingOrder);
            }
        }
        console.error('Order checkout error:', error);
        return res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : "Server error while creating checkout session. Try again!",
            ...(error.code ? { code: error.code } : {}),
        });
    }
}

// Authenticated, server-authoritative status for hosted Stripe checkout. The
// mobile deep link is only navigation; it never proves that payment succeeded.
exports.getPaymentStatus = async (req, res) => {
    const reference = String(req.params.orderId || '').trim();
    const requestedSessionId = String(req.query.sessionId || req.query.session_id || '').trim();
    const requestedPaymentIntentId = String(
        req.query.paymentIntentId || req.query.payment_intent_id || ''
    ).trim();
    const { id: userId, role } = req.user;

    try {
        const order = await resolveOrderReference({ reference });
        if (!order) return res.status(404).json({ msg: 'Order not found.' });

        if (role !== 'admin' && toId(order.user) !== toId(userId)) {
            return res.status(403).json({ msg: 'You can only verify your own payment.' });
        }
        if (order.paymentMethod !== 'stripe') {
            return res.status(400).json({
                msg: 'This order does not use card payment.',
                code: 'NOT_STRIPE_ORDER',
            });
        }
        if (
            order.paymentFlow === 'payment_sheet'
            && requestedPaymentIntentId
            && requestedPaymentIntentId !== order.stripePaymentIntentId
        ) {
            return res.status(400).json({
                msg: 'The PaymentIntent does not belong to this order.',
                code: 'PAYMENT_INTENT_MISMATCH',
            });
        }
        if (
            order.paymentFlow !== 'payment_sheet'
            && requestedSessionId
            && requestedSessionId !== order.stripeSessionId
        ) {
            return res.status(400).json({
                msg: 'The payment session does not belong to this order.',
                code: 'PAYMENT_SESSION_MISMATCH',
            });
        }
        const response = {
            orderId: order.orderId,
            mongoOrderId: order._id,
            paymentMethod: order.paymentMethod,
            paymentFlow: order.paymentFlow || 'checkout_session',
            paymentIntentId: order.stripePaymentIntentId || null,
            isPaid: isPaymentFulfilled(order),
            webhookProcessed: isPaymentFulfilled(order),
            failureCode: order.paymentResult?.failureCode || '',
            failureMessage: order.paymentResult?.failureMessage || '',
            expiresAt: order.paymentExpiresAt || null,
        };
        if (response.webhookProcessed) {
            return res.status(200).json({ ...response, status: 'paid' });
        }
        if (order.orderStatus === 'cancelled' && !order.isPaid) {
            return res.status(200).json({ ...response, status: 'cancelled' });
        }
        if (!stripe) {
            return res.status(503).json({
                ...response,
                status: 'pending',
                msg: 'Payment verification is temporarily unavailable.',
                code: 'STRIPE_UNAVAILABLE',
            });
        }

        if (order.paymentFlow === 'payment_sheet') {
            if (!order.stripePaymentIntentId) {
                return res.status(409).json({
                    ...response,
                    msg: 'Secure mobile payment is still being prepared.',
                    code: 'CHECKOUT_IN_PROGRESS',
                });
            }
            if (requestedPaymentIntentId && requestedPaymentIntentId !== order.stripePaymentIntentId) {
                return res.status(400).json({
                    ...response,
                    msg: 'The PaymentIntent does not belong to this order.',
                    code: 'PAYMENT_INTENT_MISMATCH',
                });
            }

            let paymentIntent;
            try {
                paymentIntent = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
            } catch (error) {
                if (isAuthoritativeStripeResourceMissingError(error)) {
                    await deleteUnpaidCheckoutOrder({
                        _id: order._id,
                        isPaid: false,
                        awaitingPayment: true,
                    });
                    return res.status(409).json({
                        ...response,
                        status: 'expired',
                        msg: 'This secure mobile payment attempt is no longer available.',
                        code: 'CHECKOUT_ATTEMPT_EXPIRED',
                    });
                }
                return res.status(502).json({
                    ...response,
                    status: 'pending',
                    msg: 'Could not refresh payment status yet. Please retry.',
                    code: 'PAYMENT_STATUS_UNAVAILABLE',
                });
            }
            validateStripeOrderPaymentIntent(order, paymentIntent);

            if (paymentIntent.status === 'canceled') {
                return res.status(200).json({ ...response, status: 'cancelled' });
            }
            if (
                paymentIntent.status !== 'succeeded'
                && order.paymentExpiresAt
                && order.paymentExpiresAt <= new Date()
            ) {
                const closeResult = await closeOrderPaymentIntent(order, {
                    status: 'expired',
                    reason: 'The secure mobile payment window expired.',
                    requireExpired: true,
                });
                if (closeResult?.status === 'payment_succeeded') {
                    return res.status(200).json({
                        ...response,
                        status: 'pending',
                        stripeStatus: 'succeeded',
                        stripePaymentReceived: true,
                    });
                }
                return res.status(200).json({ ...response, status: 'expired' });
            }
            return res.status(200).json({
                ...response,
                status: 'pending',
                stripeStatus: paymentIntent.status,
                stripePaymentReceived: paymentIntent.status === 'succeeded',
            });
        }

        if (!order.stripeSessionId) {
            return res.status(409).json({
                ...response,
                msg: 'Secure checkout is still being prepared.',
                code: 'CHECKOUT_IN_PROGRESS',
            });
        }
        if (requestedSessionId && requestedSessionId !== order.stripeSessionId) {
            return res.status(400).json({
                ...response,
                msg: 'The payment session does not belong to this order.',
                code: 'PAYMENT_SESSION_MISMATCH',
            });
        }

        let session;
        try {
            session = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
        } catch (error) {
            if (isAuthoritativeStripeResourceMissingError(error)) {
                await deleteUnpaidCheckoutOrder({
                    _id: order._id,
                    isPaid: false,
                    awaitingPayment: true,
                });
                return res.status(409).json({
                    ...response,
                    status: 'expired',
                    msg: 'This secure checkout attempt is no longer available.',
                    code: 'CHECKOUT_ATTEMPT_EXPIRED',
                });
            }
            return res.status(502).json({
                ...response,
                status: 'pending',
                msg: 'Could not refresh payment status yet. Please retry.',
                code: 'PAYMENT_STATUS_UNAVAILABLE',
            });
        }
        validateStripeOrderSession(order, session);

        if (session.status === 'expired') {
            await deleteUnpaidCheckoutOrder({
                _id: order._id,
                isPaid: false,
                awaitingPayment: true,
            });
            return res.status(200).json({ ...response, status: 'expired' });
        }
        // Stripe may report paid a moment before our signed webhook finishes.
        // Keep the client pending until inventory and the order are committed.
        return res.status(200).json({
            ...response,
            status: 'pending',
            stripePaymentReceived: session.payment_status === 'paid',
        });
    } catch (error) {
        console.error('Payment status verification failed:', error.message);
        return res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : 'Could not verify payment status.',
            ...(error.code ? { code: error.code } : {}),
        });
    }
};

exports.cancelStripePaymentAttempt = async (req, res) => {
    const reference = String(req.params.orderId || '').trim();
    try {
        const order = await resolveOrderReference({ reference });
        if (order && toId(order.user) !== toId(req.user.id)) {
            return res.status(404).json({ msg: 'Order payment attempt not found.' });
        }
        if (!order) return res.status(404).json({ msg: 'Order payment attempt not found.' });
        if (order.paymentMethod !== 'stripe' || order.paymentFlow !== 'payment_sheet') {
            return res.status(400).json({
                msg: 'Only native Stripe PaymentSheet attempts can be cancelled here.',
                code: 'NOT_PAYMENT_SHEET_ORDER',
            });
        }
        const requestedIntentId = String(
            req.body?.paymentIntentId || req.body?.payment_intent_id || ''
        ).trim();
        if (requestedIntentId && requestedIntentId !== order.stripePaymentIntentId) {
            return res.status(400).json({
                msg: 'The PaymentIntent does not belong to this order.',
                code: 'PAYMENT_INTENT_MISMATCH',
            });
        }
        const result = await closeOrderPaymentIntent(order, {
            status: 'cancelled',
            reason: 'The buyer dismissed Stripe PaymentSheet.',
        });
        if (result?.status === 'payment_succeeded') {
            return res.status(409).json({
                msg: 'Stripe already received this payment. Waiting for secure webhook confirmation.',
                code: 'PAYMENT_ALREADY_SUCCEEDED',
            });
        }
        return res.status(200).json({
            success: true,
            orderId: order.orderId,
            paymentIntentId: order.stripePaymentIntentId,
            status: result?.status || 'cancelled',
        });
    } catch (error) {
        console.error('Payment cancellation failed:', error.message);
        return res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : 'Could not cancel this payment attempt.',
            ...(error.code ? { code: error.code } : {}),
        });
    }
};



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
            orders = await getSellerScopedOrders(query, userId, { createdAt: -1 })
        } else if (role === 'admin') {
            orders = await Order.find(query).sort({ createdAt: -1 })
        } else {
            return res.status(403).json({ msg: 'Admin or seller access required for this order list' })
        }

        res.status(200).json({ msg: 'Orders fetched successfully', orders: orders })

    } catch (error) {
        console.error("Error fetching Order:", error);
        return res.status(500).json({ msg: "Server error while fetching orders" });
    }
}

const exportMoneyError = (message, code, statusCode) => {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
};

const normalizedExportAmount = (value, fieldName) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw exportMoneyError(
            `Order ${fieldName} is not a valid monetary amount.`,
            'ORDER_EXPORT_MONEY_INVALID',
            422,
        );
    }
    try {
        if (roundMoney(value) !== value) {
            throw exportMoneyError(
                `Order ${fieldName} is not exact to cents.`,
                'ORDER_EXPORT_MONEY_INVALID',
                422,
            );
        }
        toMinorUnits(value);
    } catch (error) {
        if (error?.code === 'ORDER_EXPORT_MONEY_INVALID') throw error;
        throw exportMoneyError(
            `Order ${fieldName} is outside the safe monetary range.`,
            'ORDER_EXPORT_MONEY_INVALID',
            422,
        );
    }
    return value;
};

function snapshotIsTrustedForConversion(snapshot) {
    return (
    Boolean(snapshot && typeof snapshot === 'object')
    && snapshot.fallback === false
    && snapshot.base === 'USD'
    && typeof snapshot.source === 'string'
    && Boolean(snapshot.source.trim())
    && !['fallback', 'stale'].includes(snapshot.source.trim().toLowerCase())
    && snapshot.rates?.USD === 1
    && Object.keys(CURRENCIES).every((currency) => {
        const rate = snapshot.rates?.[currency];
        return typeof rate === 'number' && Number.isFinite(rate) && rate > 0;
    })
    );
}

const requireCanonicalStoredOrderCurrency = (value, {
    code = 'ORDER_EXPORT_CURRENCY_INVALID',
    statusCode = 422,
} = {}) => {
    // Currency-less legacy orders were canonically USD. Any present value must
    // already be a canonical persisted code; exports/invoices must not clean up
    // corrupt storage while presenting it as trustworthy accounting data.
    const raw = value === null || value === undefined ? 'USD' : value;
    if (
        typeof raw !== 'string'
        || !raw.trim()
        || raw !== raw.trim().toUpperCase()
        || !isSupportedCurrency(raw)
    ) {
        throw exportMoneyError(
            'An order has an invalid stored currency.',
            code,
            statusCode,
        );
    }
    return raw;
};

const requireStoredOrderItemQuantity = (value, {
    code = 'ORDER_EXPORT_ITEM_INVALID',
    statusCode = 422,
} = {}) => {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw exportMoneyError(
            'An order has an invalid stored item quantity.',
            code,
            statusCode,
        );
    }
    return value;
};

const buildOrderExportMoney = ({ summary = {}, sourceCurrency, reportCurrency, rateSnapshot }) => {
    const source = requireCanonicalStoredOrderCurrency(sourceCurrency);
    if (
        typeof reportCurrency !== 'string'
        || !reportCurrency.trim()
        || !isSupportedCurrency(reportCurrency)
    ) {
        throw exportMoneyError(
            'Choose a supported report currency.',
            'ORDER_EXPORT_CURRENCY_NOT_SUPPORTED',
            400,
        );
    }

    const target = normalizeCurrency(reportCurrency);
    if (source !== target && !snapshotIsTrustedForConversion(rateSnapshot)) {
        throw exportMoneyError(
            'Live exchange rates are temporarily unavailable. Please retry the export shortly.',
            'EXCHANGE_RATES_UNAVAILABLE',
            503,
        );
    }

    const convertToMinor = (value, fieldName) => toMinorUnits(convertAmountWithRates(
        normalizedExportAmount(value, fieldName),
        source,
        target,
        rateSnapshot?.rates,
    ));

    const subtotalMinor = convertToMinor(summary.subtotal, 'subtotal');
    const shippingMinor = convertToMinor(summary.shippingCost, 'shipping');
    const taxMinor = convertToMinor(summary.tax, 'tax');
    const couponDiscountMinor = convertToMinor(summary.couponDiscount, 'coupon discount');
    const totalMinor = convertToMinor(summary.totalAmount, 'total');

    // Derive this after converting and rounding every displayed component so
    // every row reconciles exactly in the requested report currency.
    const reconciliationAdjustmentMinor = totalMinor
        - subtotalMinor
        - shippingMinor
        - taxMinor
        + couponDiscountMinor;

    return {
        subtotalMinor,
        shippingMinor,
        taxMinor,
        couponDiscountMinor,
        reconciliationAdjustmentMinor,
        totalMinor,
    };
};

const sumExportMinorUnits = (rows, key) => {
    const total = rows.reduce((sum, row) => {
        if (!Number.isSafeInteger(row?.[key])) {
            throw exportMoneyError(
                'The report contains an invalid minor-unit amount.',
                'ORDER_EXPORT_TOTAL_OUT_OF_RANGE',
                422,
            );
        }
        return sum + BigInt(row[key]);
    }, 0n);
    const numeric = Number(total);
    if (!Number.isSafeInteger(numeric)) {
        throw exportMoneyError(
            'The report total is too large to calculate safely.',
            'ORDER_EXPORT_TOTAL_OUT_OF_RANGE',
            422,
        );
    }
    return numeric;
};

const formatExportMinorUnits = (minorUnits) => fromMinorUnits(minorUnits).toFixed(2);

if (process.env.NODE_ENV === 'test') {
    exports._buildOrderExportMoney = buildOrderExportMoney;
    exports._sumExportMinorUnits = sumExportMinorUnits;
    exports._snapshotIsTrustedForConversion = snapshotIsTrustedForConversion;
}

/**
 * GET /api/order/export — download orders in CSV, PDF, or Excel format.
 * Query params: search, paymentStatus, status, startDate, endDate, format (csv|pdf|excel)
 * Includes store branding for sellers and Rozare branding for admins.
 */
exports.exportOrders = async (req, res) => {
    const { role, id: userId } = req.user;
    const { search, paymentStatus, status, startDate, endDate, format = 'csv', currency: requestedCurrency } = req.query;
    const Store = require('../models/Store');
    const User = require('../models/User');
    const rawReportCurrency = requestedCurrency === null || requestedCurrency === undefined
        ? 'USD'
        : requestedCurrency;
    if (typeof rawReportCurrency !== 'string' || !rawReportCurrency.trim() || !isSupportedCurrency(rawReportCurrency)) {
        return res.status(400).json({
            msg: 'Choose a supported report currency.',
            code: 'ORDER_EXPORT_CURRENCY_NOT_SUPPORTED',
        });
    }
    const reportCurrency = normalizeCurrency(rawReportCurrency);

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
            orders = await getSellerScopedOrders(query, userId, { createdAt: -1 }, { lean: true });
        } else {
            // Lean preserves raw BSON primitives. Hydration can otherwise cast
            // a corrupt boolean/string quantity into a plausible number.
            orders = await Order.find(query).sort({ createdAt: -1 }).lean();
        }

        // Freeze one rate table for the complete report. A multi-currency
        // export must never mix rates fetched at different moments.
        const rateSnapshot = await getExchangeRateSnapshot();

        // Normalize orders to plain objects
        const rows = [];
        for (const order of orders) {
            const o = order.toObject ? order.toObject() : order;
            const sourceCurrency = requireCanonicalStoredOrderCurrency(o.currency);
            const exportMoney = buildOrderExportMoney({
                summary: o.orderSummary,
                sourceCurrency,
                reportCurrency,
                rateSnapshot,
            });
            if (!Array.isArray(o.orderItems)) {
                throw exportMoneyError(
                    'An order has invalid stored items.',
                    'ORDER_EXPORT_ITEM_INVALID',
                    422,
                );
            }
            let itemCount = 0;
            const items = o.orderItems.map(i => {
                const quantity = requireStoredOrderItemQuantity(i?.quantity);
                itemCount += quantity;
                if (!Number.isSafeInteger(itemCount)) {
                    throw exportMoneyError(
                        'An order item count is too large to export safely.',
                        'ORDER_EXPORT_ITEM_INVALID',
                        422,
                    );
                }
                const options = formatItemOptionsText(i);
                return `${orderItemName(i)}${options ? ` (${options})` : ''} x${quantity}`;
            }).join(', ');
            rows.push({
                orderId: o.orderId || '',
                date: new Date(o.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
                customer: o.shippingInfo?.fullName || '',
                email: o.shippingInfo?.email || '',
                phone: o.shippingInfo?.phone || '',
                city: o.shippingInfo?.city || '',
                country: o.shippingInfo?.country || '',
                status: (o.orderStatus || '').charAt(0).toUpperCase() + (o.orderStatus || '').slice(1),
                payment: o.isPaid ? 'Paid' : 'Unpaid',
                paymentMethod: paymentMethodLabel(o.paymentMethod),
                items,
                itemCount,
                ...exportMoney,
                subtotal: formatExportMinorUnits(exportMoney.subtotalMinor),
                shipping: formatExportMinorUnits(exportMoney.shippingMinor),
                tax: formatExportMinorUnits(exportMoney.taxMinor),
                couponDiscount: formatExportMinorUnits(exportMoney.couponDiscountMinor),
                reconciliationAdjustment: formatExportMinorUnits(exportMoney.reconciliationAdjustmentMinor),
                total: formatExportMinorUnits(exportMoney.totalMinor),
                currency: reportCurrency,
            });
        }

        const dateStr = new Date().toISOString().split('T')[0];
        const generatedDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        const safeExportName = String(brandName || 'Rozare')
            .replace(/[^a-z0-9_-]+/gi, '-')
            .replace(/^-+|-+$/g, '') || 'Rozare';
        const neutralizeSpreadsheetText = (value) => {
            const text = String(value ?? '');
            return /^[\u0000-\u0020]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)
                ? `'${text}`
                : text;
        };
        const filterDesc = [
            status ? `Status: ${status.charAt(0).toUpperCase() + status.slice(1)}` : null,
            paymentStatus ? `Payment: ${paymentStatus}` : null,
            startDate ? `From: ${startDate}` : null,
            endDate ? `To: ${endDate}` : null,
            `Currency: ${reportCurrency}`,
        ].filter(Boolean).join(' | ') || 'All Orders';

        // Totals
        const totalSubtotal = formatExportMinorUnits(sumExportMinorUnits(rows, 'subtotalMinor'));
        const totalShipping = formatExportMinorUnits(sumExportMinorUnits(rows, 'shippingMinor'));
        const totalTax = formatExportMinorUnits(sumExportMinorUnits(rows, 'taxMinor'));
        const totalCouponDiscount = formatExportMinorUnits(sumExportMinorUnits(rows, 'couponDiscountMinor'));
        const totalReconciliationAdjustment = formatExportMinorUnits(sumExportMinorUnits(rows, 'reconciliationAdjustmentMinor'));
        const grandTotal = formatExportMinorUnits(sumExportMinorUnits(rows, 'totalMinor'));
        const totalItems = rows.reduce((sum, row) => {
            const next = sum + row.itemCount;
            if (!Number.isSafeInteger(next)) {
                throw exportMoneyError(
                    'The report item total is too large to calculate safely.',
                    'ORDER_EXPORT_ITEM_INVALID',
                    422,
                );
            }
            return next;
        }, 0);

        // ── CSV Format ──
        if (format === 'csv') {
            const lines = [];
            const esc = (value) => `"${neutralizeSpreadsheetText(value).replace(/"/g, '""')}"`;
            lines.push(esc(`${brandName} - Order Report`));
            if (storeName && role === 'seller') lines.push(esc(`Store: ${storeName}`));
            lines.push(`"Generated: ${generatedDate}"`);
            lines.push(`"Filter: ${filterDesc}"`);
            lines.push(`"Total Orders: ${rows.length} | Total Items: ${totalItems} | Grand Total: ${reportCurrency} ${grandTotal}"`);
            lines.push('');
            lines.push(`Order ID,Date,Customer,Email,Phone,City,Country,Status,Payment,Method,Items,Qty,Subtotal (${reportCurrency}),Shipping (${reportCurrency}),Tax (${reportCurrency}),Coupon Discount (${reportCurrency}),Reconciliation Adjustment (${reportCurrency}),Total (${reportCurrency})`);
            rows.forEach(r => {
                lines.push([esc(r.orderId), esc(r.date), esc(r.customer), esc(r.email), esc(r.phone), esc(r.city), esc(r.country), esc(r.status), esc(r.payment), esc(r.paymentMethod), esc(r.items), r.itemCount, r.subtotal, r.shipping, r.tax, r.couponDiscount, r.reconciliationAdjustment, r.total].join(','));
            });
            lines.push('');
            lines.push(`,,,,,,,,,,TOTALS,${totalItems},${totalSubtotal},${totalShipping},${totalTax},${totalCouponDiscount},${totalReconciliationAdjustment},${grandTotal}`);
            lines.push('');
            lines.push(`"Powered by Rozare - www.rozare.com"`);

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="${safeExportName}-orders-${dateStr}.csv"`);
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
            sheet.mergeCells('A1:R1');
            const titleCell = sheet.getCell('A1');
            titleCell.value = neutralizeSpreadsheetText(`${brandName} - Order Report`);
            titleCell.font = { bold: true, size: 16, color: { argb: 'FF6366F1' } };
            titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
            sheet.getRow(1).height = 30;

            if (storeName && role === 'seller') {
                sheet.mergeCells('A2:R2');
                const storeCell = sheet.getCell('A2');
                storeCell.value = neutralizeSpreadsheetText(`Store: ${storeName}`);
                storeCell.font = { size: 11, color: { argb: 'FF64748B' } };
                storeCell.alignment = { horizontal: 'center' };
            }

            const infoRow = role === 'seller' && storeName ? 3 : 2;
            sheet.mergeCells(`A${infoRow}:R${infoRow}`);
            const infoCell = sheet.getCell(`A${infoRow}`);
            infoCell.value = `Generated: ${generatedDate} | ${filterDesc} | ${rows.length} orders | Grand Total: ${reportCurrency} ${grandTotal}`;
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
                { header: 'Coupon Discount', key: 'couponDiscount', width: 16 },
                { header: 'Adjustment', key: 'reconciliationAdjustment', width: 13 },
                { header: 'Total', key: 'total', width: 12 },
            ];

            // Move header row to correct position
            const headerRow = sheet.getRow(dataStartRow);
            headerRow.values = ['Order ID', 'Date', 'Customer', 'Email', 'Phone', 'City', 'Country', 'Status', 'Payment', 'Method', 'Items', 'Qty', `Subtotal (${reportCurrency})`, `Shipping (${reportCurrency})`, `Tax (${reportCurrency})`, `Coupon Discount (${reportCurrency})`, `Adjustment (${reportCurrency})`, `Total (${reportCurrency})`];
            headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
            headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6366F1' } };
            headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
            headerRow.height = 24;
            headerRow.eachCell(cell => { cell.border = { bottom: { style: 'medium', color: { argb: 'FF4F46E5' } } }; });

            // Add data rows
            rows.forEach((r, i) => {
                const row = sheet.getRow(dataStartRow + 1 + i);
                row.values = [
                    r.orderId, r.date, r.customer, r.email, r.phone, r.city,
                    r.country, r.status, r.payment, r.paymentMethod, r.items,
                ].map(neutralizeSpreadsheetText).concat([
                    r.itemCount, r.subtotal, r.shipping, r.tax,
                    r.couponDiscount, r.reconciliationAdjustment, r.total,
                ]);
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
            summaryRow.values = ['', '', '', '', '', '', '', '', '', '', `TOTAL (${rows.length} orders)`, totalItems, totalSubtotal, totalShipping, totalTax, totalCouponDiscount, totalReconciliationAdjustment, grandTotal];
            summaryRow.font = { bold: true, size: 11 };
            summaryRow.getCell(18).font = { bold: true, size: 12, color: { argb: 'FF6366F1' } };
            summaryRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE9FE' } };

            // Footer
            const footerRow = sheet.getRow(sumRowNum + 2);
            sheet.mergeCells(`A${sumRowNum + 2}:R${sumRowNum + 2}`);
            const footerCell = sheet.getCell(`A${sumRowNum + 2}`);
            footerCell.value = 'Powered by Rozare - www.rozare.com';
            footerCell.font = { size: 9, italic: true, color: { argb: 'FF94A3B8' } };
            footerCell.alignment = { horizontal: 'center' };

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${safeExportName}-orders-${dateStr}.xlsx"`);
            await workbook.xlsx.write(res);
            return res.end();
        }

        // ── PDF Format ──
        if (format === 'pdf') {
            const PDFDocument = require('pdfkit');
            const margin = 40;
            const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: margin, bottom: margin, left: margin, right: margin }, autoFirstPage: false });

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${safeExportName}-orders-${dateStr}.pdf"`);
            doc.pipe(res);

            doc.addPage({ size: 'A4', layout: 'landscape', margins: { top: margin, bottom: margin, left: margin, right: margin } });

            const pageW = doc.page.width;
            const pageH = doc.page.height;
            const contentWidth = pageW - margin * 2;
            const maxY = pageH - margin - 10;

            // Table config
            const cols = [
                { label: '#', width: 24 },
                { label: 'Order ID', width: 80 },
                { label: 'Date', width: 58 },
                { label: 'Customer', width: 72 },
                { label: 'Phone', width: 62 },
                { label: 'City', width: 45 },
                { label: 'Status', width: 50 },
                { label: 'Payment', width: 45 },
                { label: 'Method', width: 36 },
                { label: 'Items', width: 124 },
                { label: 'Coupon', width: 48 },
                { label: 'Adjust.', width: 47 },
                { label: `Total ${reportCurrency}`, width: 58 },
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
                doc.text(`${generatedDate} | ${filterDesc} | ${rows.length} orders | Total: ${reportCurrency} ${grandTotal}`, margin, y, { width: contentWidth, align: 'center', lineBreak: false });
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
                const values = [String(i + 1), r.orderId, r.date, r.customer, r.phone, r.city, r.status, r.payment, r.paymentMethod, r.items, r.couponDiscount, r.reconciliationAdjustment, r.total];
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
                    if (ci === 12) { color = '#1e293b'; font = 'Helvetica-Bold'; }
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
                    `TOTALS: ${rows.length} orders | Subtotal: ${reportCurrency} ${totalSubtotal} | Shipping: ${reportCurrency} ${totalShipping} | Tax: ${reportCurrency} ${totalTax} | Coupon: ${reportCurrency} ${totalCouponDiscount} | Adjustment: ${reportCurrency} ${totalReconciliationAdjustment} | Grand Total: ${reportCurrency} ${grandTotal}`,
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
        return res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : 'Server error while exporting orders',
            ...(error.code ? { code: error.code } : {}),
        });
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
        const validStatuses = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
        if (!validStatuses.includes(newStatus)) {
            return res.status(400).json({ msg: 'Choose a valid order status.' });
        }
        if (role !== 'seller' && role !== 'admin') {
            return res.status(403).json({ msg: 'Only sellers and admins can update order status' })
        }

        let existingOrder = await Order.findOne({
            _id,
            // Awaiting-payment rows are abandoned/incomplete Checkout state,
            // not fulfillable seller orders. Keep admin recovery intentional.
            ...(role === 'seller' ? { awaitingPayment: { $ne: true } } : {}),
        })

        if (!existingOrder) {
            return res.status(404).json({ msg: 'Order not found' })
        }

        const orderSellerIds = await ensureOrderSellerFulfillment(existingOrder);
        // If seller, check if order contains their products (snapshot or live).
        let sellerFulfillment = null;
        if (role === 'seller') {
            const sellerProducts = await Product.find({ seller: userId }).select('_id')
            const sellerProductIds = sellerProducts.map(p => p._id.toString())

            const hasSellerProduct = existingOrder.orderItems.some(item =>
                itemBelongsToSeller(item, userId, sellerProductIds)
            )

            if (!hasSellerProduct) {
                return res.status(403).json({ msg: 'You can only update orders containing your products' })
            }

            sellerFulfillment = sellerFulfillmentFor(existingOrder, userId);
            if (!sellerFulfillment) {
                return res.status(403).json({ msg: 'Seller fulfillment record was not found for this order.' });
            }
        }

        // Cancellation is a money/inventory boundary, not a normal status
        // assignment. A single inventoryCommitted flag cannot represent a
        // partially cancelled multi-seller order, so fail closed instead of
        // releasing the wrong seller's stock or coupon capacity.
        if (newStatus === 'cancelled') {
            if (role === 'seller' && orderSellerIds.length > 1) {
                return res.status(409).json({
                    msg: 'A seller cannot safely cancel only one portion of a multi-seller order yet. Contact support so stock and payment accounting remain correct.',
                    code: 'PARTIAL_ORDER_CANCELLATION_UNSUPPORTED',
                    currentStatus: sellerFulfillment?.status || existingOrder.orderStatus,
                });
            }
            const cancellationStatuses = role === 'seller'
                ? [sellerFulfillment?.status || existingOrder.orderStatus]
                : existingOrder.sellerFulfillment.length
                    ? existingOrder.sellerFulfillment.map(entry => entry.status)
                    : [existingOrder.orderStatus];
            const startedStatus = cancellationStatuses.find(status => ['shipped', 'delivered'].includes(status));
            if (startedStatus) {
                return res.status(409).json({
                    msg: 'This order has already shipped or been delivered and cannot be cancelled through fulfillment status updates.',
                    code: 'ORDER_FULFILLMENT_STARTED',
                    currentStatus: role === 'seller'
                        ? sellerFulfillment?.status || existingOrder.orderStatus
                        : existingOrder.orderStatus,
                });
            }

            const cancellationAt = new Date();
            const buyerAlreadyDecided = !!(
                existingOrder.confirmation?.confirmedAt
                || existingOrder.confirmation?.declinedAt
            );
            const confirmationFields = buyerAlreadyDecided ? {} : {
                declinedAt: cancellationAt,
                confirmedVia: role === 'admin' ? 'admin' : 'manual',
                decidedAt: cancellationAt,
                decidedVia: role === 'admin' ? 'admin' : 'manual',
            };
            const cancellation = await cancelOrderSafely({
                orderId: existingOrder._id,
                reason: role === 'admin'
                    ? 'Order cancelled by an administrator before payment or shipment.'
                    : 'Single-seller order cancelled by its seller before shipment.',
                confirmationFields,
                cancellationActorRole: role,
                at: cancellationAt,
            });
            if (cancellation.status === 'payment_succeeded') {
                return res.status(409).json({
                    msg: 'Stripe already received this payment. Waiting for secure webhook confirmation.',
                    code: 'PAYMENT_ALREADY_SUCCEEDED',
                    currentStatus: existingOrder.orderStatus,
                });
            }
            const cancelledOrder = cancellation.order;

            return res.status(200).json({
                msg: 'Updated status successfully',
                orderStatus: 'cancelled',
                aggregateOrderStatus: cancelledOrder.orderStatus,
            });
        }

        const fulfillmentResult = await transitionOrderFulfillment({
            orderId: existingOrder._id,
            actorRole: role,
            actorId: userId,
            sellerIds: orderSellerIds,
            newStatus,
        });
        existingOrder = fulfillmentResult.order;

        res.status(200).json({
            msg: 'Updated status successfully',
            orderStatus: role === 'seller'
                ? sellerFulfillmentFor(existingOrder, userId)?.status
                : existingOrder.orderStatus,
            aggregateOrderStatus: existingOrder.orderStatus,
        })
    } catch (error) {
        console.error(error.message);
        res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : 'Server error while updating status',
            ...(error.code ? { code: error.code } : {}),
            ...(error.currentStatus !== undefined ? { currentStatus: error.currentStatus } : {}),
        })
    }
}



exports.getOrderDetail = async (req, res) => {
    const { id } = req.params
    const { role, id: userId } = req.user

    try {
        const order = await Order.findOne({
            _id: id,
            // Do not expose buyer shipping PII from an unpaid Checkout to a
            // seller who learned or guessed its database id.
            ...(role === 'seller' ? { awaitingPayment: { $ne: true } } : {}),
        })

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
        const order = await resolveOrderReference({
            reference: String(orderId),
            scope: {
                'shippingInfo.email': email.toLowerCase().trim(),
            },
        });

        if (!order) {
            return res.status(404).json({ msg: 'Order not found. Please check your email and order ID.' });
        }

        res.status(200).json({ msg: 'Order found', order });
    } catch (error) {
        console.error('Error tracking guest order:', error);
        res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : 'Server error while tracking order',
            ...(error.code ? { code: error.code } : {}),
        });
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

        const cancellationAt = new Date();
        const confirmationFields = {};
        if (wasConfirmedViaWhatsApp) {
            // Mark that the buyer retracted their WhatsApp confirmation
            confirmationFields.cancelledFromDashboardAt = cancellationAt;
            confirmationFields.cancelledFromDashboardNote =
                'Order was confirmed by buyer via Rozare WhatsApp automation, but buyer changed their mind and cancelled from their account dashboard.';
        }

        // Also track if confirmed via email then cancelled from account
        const wasConfirmedViaEmail = !!(
            order.confirmation?.confirmedAt &&
            order.confirmation?.confirmedVia === 'email'
        );
        if (wasConfirmedViaEmail) {
            confirmationFields.cancelledFromDashboardAt = cancellationAt;
            confirmationFields.cancelledFromDashboardNote =
                'Buyer confirmed via email, then cancelled from their account.';
        }

        // If order wasn't confirmed by anyone yet, just mark the cancellation
        if (!wasConfirmedViaWhatsApp && !wasConfirmedViaEmail) {
            confirmationFields.declinedAt = cancellationAt;
            confirmationFields.decidedAt = cancellationAt;
            confirmationFields.decidedVia = role === 'admin' ? 'admin' : 'dashboard';
            confirmationFields.confirmedVia = order.confirmation?.confirmedVia
                || (role === 'admin' ? 'admin' : 'dashboard');
        }
        const cancellation = await cancelOrderSafely({
            orderId: order._id,
            reason: role === 'admin'
                ? 'Order cancelled by an administrator before payment or shipment.'
                : 'Order cancelled by the buyer before payment or shipment.',
            confirmationFields,
            cancellationActorRole: role === 'admin' ? 'admin' : 'buyer',
            at: cancellationAt,
        });
        if (cancellation.status === 'payment_succeeded') {
            return res.status(409).json({
                msg: 'Stripe already received this payment. Waiting for secure webhook confirmation.',
                code: 'PAYMENT_ALREADY_SUCCEEDED',
            });
        }
        const cancelledOrder = cancellation.order;

        res.status(200).json({
            msg: cancellation.alreadyCancelled ? 'Order was already cancelled.' : 'Order cancelled successfully.',
            order: cancelledOrder,
        })
    } catch (error) {
        console.error(error);
        res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : 'Server error while cancelling order',
            ...(error.code ? { code: error.code } : {}),
        })
    }
}

// =============================================================================
// Re-order — clone past order's items into the user's cart
// =============================================================================
exports.reorder = async (req, res) => {
    const { id: orderId } = req.params;
    const { id: userId } = req.user;
    try {
        const hydratedOrder = await Order.findById(orderId);
        if (!hydratedOrder) return res.status(404).json({ msg: 'Order not found' });
        if (!hydratedOrder.user || hydratedOrder.user.toString() !== userId.toString()) {
            return res.status(403).json({ msg: 'Not your order' });
        }

        // Authorize using the model, then inspect the raw persisted values.
        // Hydration can cast `true`, numeric strings, or fractional legacy data
        // into plausible quantities which must never become a new cart line.
        const order = await Order.collection.findOne({ _id: hydratedOrder._id });
        if (!order) return res.status(404).json({ msg: 'Order not found' });
        if (!Array.isArray(order.orderItems)) {
            throw exportMoneyError(
                'The original order has invalid stored items and cannot be reordered.',
                'ORDER_REORDER_ITEM_INVALID',
                409,
            );
        }

        let cart = await Cart.findOne({ user: userId });
        if (cart) {
            const rawCart = await Cart.collection.findOne(
                { _id: cart._id },
                { projection: { cartItems: 1 } },
            );
            if (!rawCart || !Array.isArray(rawCart.cartItems)) {
                throw exportMoneyError(
                    'The cart has invalid stored items and cannot be updated.',
                    'CART_REORDER_QUANTITY_INVALID',
                    409,
                );
            }
            for (const rawItem of rawCart.cartItems) {
                // A genuinely missing legacy quantity retains the historical
                // default of one. Any present value must already be canonical.
                if (rawItem?.qty !== null && rawItem?.qty !== undefined) {
                    requireStoredOrderItemQuantity(rawItem.qty, {
                        code: 'CART_REORDER_QUANTITY_INVALID',
                        statusCode: 409,
                    });
                }
            }
        } else {
            cart = new Cart({ user: userId, cartItems: [] });
        }

        let added = 0;
        let unavailable = 0;
        for (const item of order.orderItems) {
            if (!(item?.productId instanceof mongoose.Types.ObjectId)) {
                throw exportMoneyError(
                    'The original order has an invalid stored product reference and cannot be reordered.',
                    'ORDER_REORDER_ITEM_INVALID',
                    409,
                );
            }
            const orderedQuantity = requireStoredOrderItemQuantity(item.quantity, {
                code: 'ORDER_REORDER_QUANTITY_INVALID',
                statusCode: 409,
            });
            const product = await Product.findOne(publicProductFilter({ _id: item.productId })).lean();
            if (!product) { unavailable++; continue; }
            if (!Number.isSafeInteger(product.stock) || product.stock < 0) {
                throw exportMoneyError(
                    'A product has invalid stored stock and cannot be reordered.',
                    'PRODUCT_REORDER_STOCK_INVALID',
                    409,
                );
            }
            if (product.stock === 0) { unavailable++; continue; }
            const qty = Math.min(orderedQuantity, product.stock);
            const selectedOptions = toPlainOptions(item.selectedOptions);
            const itemOptionsKey = optionsKey(selectedOptions);
            const existing = cart.cartItems.find(
                (p) => p.product?.toString() === item.productId.toString() &&
                       (p.selectedColor || null) === (item.selectedColor || null) &&
                       optionsKey(p.selectedOptions) === itemOptionsKey
            );
            if (existing) {
                const existingQuantity = existing.qty === null || existing.qty === undefined
                    ? 1
                    : requireStoredOrderItemQuantity(existing.qty, {
                        code: 'CART_REORDER_QUANTITY_INVALID',
                        statusCode: 409,
                    });
                const combinedQuantity = existingQuantity + qty;
                if (!Number.isSafeInteger(combinedQuantity)) {
                    throw exportMoneyError(
                        'The cart quantity is outside the supported range.',
                        'CART_REORDER_QUANTITY_INVALID',
                        409,
                    );
                }
                existing.qty = Math.min(combinedQuantity, product.stock);
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
        res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : 'Server error while re-ordering',
            ...(error.code ? { code: error.code } : {}),
        });
    }
};

// =============================================================================
// Invoice — generate styled HTML invoice (rendered to PDF on client)
// =============================================================================
exports.getInvoice = async (req, res) => {
    const { id } = req.params;
    const { role, id: userId } = req.user;
    try {
        const hydratedOrder = await Order.findById(id);
        if (!hydratedOrder) return res.status(404).json({ msg: 'Order not found' });

        if (role !== 'admin' && (!hydratedOrder.user || hydratedOrder.user.toString() !== userId.toString())) {
            return res.status(403).json({ msg: 'Forbidden' });
        }

        // Read raw BSON only after authorization. Hydration can cast corrupt
        // booleans/strings into plausible money or quantities before display.
        const order = await Order.collection.findOne({ _id: hydratedOrder._id });
        if (!order) return res.status(404).json({ msg: 'Order not found' });
        const invoiceCurrency = requireCanonicalStoredOrderCurrency(order.currency, {
            code: 'ORDER_INVOICE_CURRENCY_INVALID',
            statusCode: 409,
        });
        if (!Array.isArray(order.orderItems)) {
            throw exportMoneyError(
                'The invoice has invalid stored items.',
                'ORDER_INVOICE_ITEM_INVALID',
                409,
            );
        }
        const summary = order.orderSummary;
        if (!summary || typeof summary !== 'object') {
            throw exportMoneyError(
                'The invoice has invalid stored totals.',
                'ORDER_INVOICE_MONEY_INVALID',
                409,
            );
        }
        for (const [field, label] of [
            ['subtotal', 'subtotal'],
            ['shippingCost', 'shipping'],
            ['tax', 'tax'],
            ['couponDiscount', 'coupon discount'],
            ['totalAmount', 'total'],
        ]) {
            try {
                normalizedExportAmount(summary[field], label);
            } catch (_) {
                throw exportMoneyError(
                    `The invoice ${label} is invalid.`,
                    'ORDER_INVOICE_MONEY_INVALID',
                    409,
                );
            }
        }
        const fmt = (n) => escapeHtml(formatOrderMoney(n, order));
        const rows = order.orderItems.map((it) => `
            <tr>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;">${escapeHtml(orderItemName(it))}${orderItemOptionsHtml(it)}</td>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:center;">${escapeHtml(requireStoredOrderItemQuantity(it?.quantity, { code: 'ORDER_INVOICE_ITEM_INVALID', statusCode: 409 }))}</td>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${escapeHtml(formatOrderItemUnitMoney(it, order))}</td>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;">${fmt(orderItemLineSubtotal(it))}</td>
            </tr>`).join('');

        const safeOrderId = escapeHtml(order.orderId);
        const safeStatus = escapeHtml(String(order.orderStatus || 'pending').toUpperCase());
        const html = `<!doctype html><html><head><meta charset="utf-8"/><title>Invoice ${safeOrderId}</title>
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
      <div style="font-size:13px;font-weight:600;">Invoice #${safeOrderId}</div>
      <div class="muted">${new Date(order.createdAt).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</div>
      <div style="margin-top:6px;"><span class="badge">${safeStatus}</span></div>
    </div>
  </div>
  <div class="grid">
    <div>
      <div class="label">Billed To</div>
      <div style="font-weight:600;">${escapeHtml(order.shippingInfo.fullName)}</div>
      <div class="muted">${escapeHtml(order.shippingInfo.address)}<br/>${escapeHtml(order.shippingInfo.city)}, ${escapeHtml(order.shippingInfo.state || '')} ${escapeHtml(order.shippingInfo.postalCode || '')}<br/>${escapeHtml(order.shippingInfo.country)}<br/>${escapeHtml(order.shippingInfo.email)}</div>
    </div>
    <div>
      <div class="label">Payment</div>
      <div style="font-weight:600;">${escapeHtml(paymentMethodLabel(order.paymentMethod))}</div>
      <div class="muted">Status: ${order.isPaid ? 'Paid' : 'Unpaid'}</div>
    </div>
  </div>
  <table>
    <thead><tr><th>Item</th><th>Qty</th><th>Unit price</th><th>Total (${escapeHtml(invoiceCurrency)})</th></tr></thead>
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
        res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : 'Server error while generating invoice',
            ...(error.code ? { code: error.code } : {}),
        });
    }
};
