const crypto = require('crypto');
const Order = require('../models/Order');
const {
    getOrderCurrency,
    orderItemLineSubtotal,
    requirePresentationMoney,
    toPlainOptions,
} = require('../utils/orderPresentation');
const { sumMoney } = require('../services/moneyMath');
const {
    getBuyerCancellationBlock,
} = require('../services/orderFulfillmentService');
const {
    cancelOrderSafely,
    reconfirmCancelledCodOrder,
} = require('../services/orderCancellationService');
const { confirmCodOrderByBuyer } = require('../services/orderStatusTransitionService');

const TOKEN_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

exports.generateConfirmationToken = () => ({
    token: crypto.randomBytes(32).toString('hex'),
    tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
});

const sanitizePublicOrderSummary = (summary) => {
    const raw = summary?.toObject ? summary.toObject() : { ...(summary || {}) };
    const normalized = {
        subtotal: requirePresentationMoney(raw.subtotal, 'order subtotal'),
        shippingCost: requirePresentationMoney(raw.shippingCost, 'order shipping cost'),
        tax: requirePresentationMoney(raw.tax ?? 0, 'order tax'),
        couponDiscount: requirePresentationMoney(raw.couponDiscount ?? 0, 'order coupon discount'),
        totalAmount: requirePresentationMoney(raw.totalAmount, 'order total'),
    };
    let expectedTotal;
    try {
        expectedTotal = sumMoney([
            normalized.subtotal,
            normalized.shippingCost,
            normalized.tax,
            -normalized.couponDiscount,
        ]);
    } catch (_) {
        throw Object.assign(new Error('The stored order summary is invalid.'), {
            statusCode: 409,
            code: 'ORDER_PRESENTATION_DATA_INVALID',
        });
    }
    if (expectedTotal !== normalized.totalAmount) {
        throw Object.assign(new Error('The stored order summary does not reconcile.'), {
            statusCode: 409,
            code: 'ORDER_PRESENTATION_DATA_INVALID',
        });
    }
    return { ...raw, ...normalized };
};

const sanitizeOrderForPublic = (order) => ({
    orderId: order.orderId,
    orderItems: order.orderItems.map(i => ({
        name: i.name,
        image: i.image,
        price: requirePresentationMoney(i.price, 'order item price'),
        quantity: (() => {
            if (!Number.isSafeInteger(i.quantity) || i.quantity < 1) {
                const error = new Error('The stored order item quantity is invalid.');
                error.statusCode = 409;
                error.code = 'ORDER_PRESENTATION_DATA_INVALID';
                throw error;
            }
            return i.quantity;
        })(),
        lineSubtotal: orderItemLineSubtotal(i),
        selectedColor: i.selectedColor || null,
        selectedOptions: toPlainOptions(i.selectedOptions),
    })),
    currency: getOrderCurrency(order),
    shippingInfo: {
        fullName: order.shippingInfo.fullName,
        address: order.shippingInfo.address,
        city: order.shippingInfo.city,
        state: order.shippingInfo.state,
        postalCode: order.shippingInfo.postalCode,
        country: order.shippingInfo.country,
        maskedPhone: order.shippingInfo?.phone
            ? '••••' + order.shippingInfo.phone.slice(-4)
            : null,
    },
    orderSummary: sanitizePublicOrderSummary(order.orderSummary),
    paymentMethod: order.paymentMethod,
    createdAt: order.createdAt,
    confirmation: {
        confirmedAt: order.confirmation?.confirmedAt || null,
        confirmedVia: order.confirmation?.confirmedVia || null,
        declinedAt: order.confirmation?.declinedAt || null,
        expired: order.confirmation?.tokenExpiresAt
            ? new Date(order.confirmation.tokenExpiresAt) < new Date()
            : false,
        emailSentAt: order.confirmation?.emailSentAt || null,
        emailSentSuccess: order.confirmation?.emailSentSuccess ?? null,
        emailError: order.confirmation?.emailError || '',
        whatsappSentAt: order.confirmation?.whatsappSentAt || null,
        whatsappSentSuccess: order.confirmation?.whatsappSentSuccess ?? null,
        whatsappError: order.confirmation?.whatsappError || '',
        cancelledFromDashboardAt: order.confirmation?.cancelledFromDashboardAt || null,
        cancelledFromDashboardNote: order.confirmation?.cancelledFromDashboardNote || '',
        cancelledAt: order.confirmation?.cancelledAt || null,
        cancelledByRole: order.confirmation?.cancelledByRole || null,
        cancelledVia: order.confirmation?.cancelledVia || null,
        decidedAt: order.confirmation?.decidedAt || null,
        decidedVia: order.confirmation?.decidedVia || null,
    },
    orderStatus: order.orderStatus,
});

exports.getConfirmationDetails = async (req, res) => {
    const { token } = req.params;
    if (!token || token.length < 32) return res.status(400).json({ msg: 'Invalid token' });
    try {
        const order = await Order.findOne({ 'confirmation.token': token });
        if (!order) return res.status(404).json({ msg: 'Order not found or link expired' });
        return res.status(200).json({ order: sanitizeOrderForPublic(order) });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        if (statusCode >= 500) console.error('getConfirmationDetails error:', err.message);
        return res.status(statusCode).json({
            msg: err.statusCode ? err.message : 'Server error',
            ...(err.code ? { code: err.code } : {}),
        });
    }
};

exports.confirmOrder = async (req, res) => {
    const { token } = req.params;
    if (!token || token.length < 32) return res.status(400).json({ msg: 'Invalid token' });
    try {
        // First, read the order to check its current state
        const order = await Order.findOne({ 'confirmation.token': token });
        if (!order) return res.status(404).json({ msg: 'Order not found' });

        // Already confirmed — return current state (idempotent)
        if (order.confirmation?.confirmedAt) {
            return res.status(200).json({ msg: 'Already confirmed', order: sanitizeOrderForPublic(order) });
        }
        // Already declined — return current state for cross-channel awareness
        if (order.confirmation?.declinedAt) {
            return res.status(200).json({ msg: 'Already declined', order: sanitizeOrderForPublic(order) });
        }
        if (order.confirmation?.tokenExpiresAt && new Date(order.confirmation.tokenExpiresAt) < new Date()) {
            return res.status(410).json({ msg: 'Confirmation link expired' });
        }

        const confirmation = await confirmCodOrderByBuyer({
            orderId: order._id,
            token,
            channel: 'email',
            // A prior seller/admin decision remains visible to the buyer but
            // is not silently overridden from an email link.
            allowedExistingDecisionChannels: [],
        });
        if (confirmation.status !== 'confirmed') {
            const freshOrder = confirmation.order || await Order.findOne({ 'confirmation.token': token });
            if (!freshOrder) return res.status(404).json({ msg: 'Order not found' });
            if (confirmation.status === 'already_confirmed') {
                return res.status(200).json({ msg: 'Already confirmed', order: sanitizeOrderForPublic(freshOrder) });
            }
            if (['already_declined', 'already_decided'].includes(confirmation.status)) {
                return res.status(200).json({ msg: 'Already declined', order: sanitizeOrderForPublic(freshOrder) });
            }
            return res.status(409).json({
                msg: confirmation.status === 'fulfillment_started'
                    ? 'This order is already being processed and cannot be moved back to confirmed.'
                    : 'This order is cancelled. Use the re-confirm action to reserve its items again.',
                code: confirmation.status === 'fulfillment_started'
                    ? 'ORDER_FULFILLMENT_STARTED'
                    : 'ORDER_CANCELLED',
                order: sanitizeOrderForPublic(freshOrder),
            });
        }
        const updated = confirmation.order;

        return res.status(200).json({ msg: 'Order confirmed', order: sanitizeOrderForPublic(updated) });
    } catch (err) {
        console.error('confirmOrder error:', err.message);
        return res.status(err.statusCode || 500).json({
            msg: err.statusCode ? err.message : 'Server error',
            ...(err.code ? { code: err.code } : {}),
        });
    }
};

exports.declineOrder = async (req, res) => {
    const { token } = req.params;
    if (!token || token.length < 32) return res.status(400).json({ msg: 'Invalid token' });
    try {
        const order = await Order.findOne({ 'confirmation.token': token });
        if (!order) return res.status(404).json({ msg: 'Order not found' });

        // Already declined — idempotent
        if (order.confirmation?.declinedAt) {
            return res.status(200).json({ msg: 'Already declined', order: sanitizeOrderForPublic(order) });
        }

        const cancellationBlock = getBuyerCancellationBlock(order);
        if (cancellationBlock) {
            return res.status(409).json({
                msg: cancellationBlock.message,
                code: cancellationBlock.code,
                order: sanitizeOrderForPublic(order),
            });
        }

        // If order was confirmed via WhatsApp and buyer now wants to cancel via email,
        // allow it — track it as a cross-channel cancellation
        if (order.confirmation?.confirmedAt && order.confirmation?.confirmedVia === 'whatsapp') {
            const cancelledAt = new Date();
            let result;
            try {
                result = await cancelOrderSafely({
                    orderId: order._id,
                    token,
                    reason: 'Buyer cancelled from the email confirmation page after confirming on WhatsApp.',
                    confirmationFields: {
                        cancelledFromDashboardAt: cancelledAt,
                        cancelledFromDashboardNote:
                            'Order was confirmed by buyer via WhatsApp, but buyer changed their mind and cancelled from the email confirmation page.',
                        cancelledVia: 'email',
                    },
                    allowedExistingDecisionChannels: ['whatsapp'],
                    cancellationActorRole: 'buyer',
                    at: cancelledAt,
                });
            } catch (error) {
                if (error.code !== 'ORDER_DECISION_ALREADY_MADE') throw error;
                const freshOrder = await Order.findOne({ 'confirmation.token': token });
                return res.status(200).json({ msg: 'Order already processed', order: sanitizeOrderForPublic(freshOrder || order) });
            }
            if (result.status === 'payment_succeeded') {
                return res.status(409).json({
                    msg: 'Payment was already received; this order cannot be cancelled here.',
                    code: 'PAYMENT_ALREADY_SUCCEEDED',
                });
            }
            const updated = result.order;
            return res.status(200).json({
                msg: result.alreadyCancelled ? 'Order already cancelled' : 'Order cancelled',
                order: sanitizeOrderForPublic(updated),
            });
        }

        // Already confirmed via another channel — return current state
        if (order.confirmation?.confirmedAt) {
            return res.status(200).json({ msg: 'Already confirmed', order: sanitizeOrderForPublic(order) });
        }

        const declinedAt = new Date();
        let declineResult;
        try {
            declineResult = await cancelOrderSafely({
                orderId: order._id,
                token,
                reason: 'Buyer declined from the email confirmation page.',
                confirmationFields: {
                    declinedAt,
                    confirmedVia: 'email',
                    decidedAt: declinedAt,
                    decidedVia: 'email',
                },
                allowedExistingDecisionChannels: [],
                cancellationActorRole: 'buyer',
                at: declinedAt,
            });
        } catch (error) {
            if (error.code !== 'ORDER_DECISION_ALREADY_MADE') throw error;
            const freshOrder = await Order.findOne({ 'confirmation.token': token });
            if (freshOrder) {
                return res.status(200).json({
                    msg: freshOrder.confirmation?.confirmedAt ? 'Already confirmed' : 'Already declined',
                    order: sanitizeOrderForPublic(freshOrder)
                });
            }
            return res.status(404).json({ msg: 'Order not found' });
        }
        if (declineResult.status === 'payment_succeeded') {
            return res.status(409).json({
                msg: 'Payment was already received; this order cannot be cancelled here.',
                code: 'PAYMENT_ALREADY_SUCCEEDED',
            });
        }
        const updated = declineResult.order;

        return res.status(200).json({
            msg: declineResult.alreadyCancelled ? 'Order already declined' : 'Order declined',
            order: sanitizeOrderForPublic(updated),
        });
    } catch (err) {
        console.error('declineOrder error:', err.message);
        return res.status(err.statusCode || 500).json({
            msg: err.statusCode ? err.message : 'Server error',
            ...(err.code ? { code: err.code } : {}),
        });
    }
};

// Re-confirm a cancelled order (buyer changed their mind from email page)
exports.reconfirmOrder = async (req, res) => {
    const { token } = req.params;
    if (!token || token.length < 32) return res.status(400).json({ msg: 'Invalid token' });
    try {
        const order = await Order.findOne({ 'confirmation.token': token });
        if (!order) return res.status(404).json({ msg: 'Order not found' });

        // Only allow re-confirm if order is currently cancelled
        if (order.orderStatus !== 'cancelled') {
            return res.status(200).json({ msg: 'Order is not cancelled', order: sanitizeOrderForPublic(order) });
        }

        const confirmedAt = new Date();
        const reconfirmed = await reconfirmCancelledCodOrder({
            orderId: order._id,
            token,
            confirmationFields: {
                confirmedAt,
                confirmedVia: 'email',
                decidedAt: confirmedAt,
                decidedVia: 'email',
                declinedAt: null,
                cancelledFromDashboardAt: null,
                cancelledFromDashboardNote: '',
                cancelledAt: null,
                cancelledByRole: null,
                cancelledVia: null,
            },
            at: confirmedAt,
        });
        const updated = reconfirmed.order;

        return res.status(200).json({
            msg: reconfirmed.alreadyConfirmed ? 'Order already re-confirmed' : 'Order re-confirmed',
            order: sanitizeOrderForPublic(updated),
        });
    } catch (err) {
        console.error('reconfirmOrder error:', err.message);
        return res.status(err.statusCode || 500).json({
            msg: err.statusCode ? err.message : 'Server error',
            ...(err.code ? { code: err.code } : {}),
        });
    }
};
