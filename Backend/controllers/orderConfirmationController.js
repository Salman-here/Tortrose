const crypto = require('crypto');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { sendEmail } = require('./mailController');
const { sellerOrderConfirmedByBuyerEmail } = require('../utils/emailTemplates');
const { sendPushToUser } = require('../utils/expoPush');
const { notifySeller } = require('../services/whatsapp/sellerNotificationService');
const sellerTemplates = require('../services/whatsapp/sellerMessageTemplates');
const { toPlainOptions } = require('../utils/orderPresentation');
const {
    getBuyerCancellationBlock,
    syncAllSellerFulfillmentStatus,
} = require('../services/orderFulfillmentService');

const TOKEN_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

exports.generateConfirmationToken = () => ({
    token: crypto.randomBytes(32).toString('hex'),
    tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
});

const sanitizeOrderForPublic = (order) => ({
    orderId: order.orderId,
    orderItems: order.orderItems.map(i => ({
        name: i.name, image: i.image, price: i.price, quantity: i.quantity,
        selectedColor: i.selectedColor || null,
        selectedOptions: toPlainOptions(i.selectedOptions),
    })),
    currency: order.currency || 'USD',
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
    orderSummary: order.orderSummary,
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
        console.error('getConfirmationDetails error:', err.message);
        return res.status(500).json({ msg: 'Server error' });
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

        // Atomic update: only succeeds if decidedAt is still null (no one else decided first)
        const updated = await Order.findOneAndUpdate(
            { 
                'confirmation.token': token, 
                'confirmation.decidedAt': null  // guard: no decision yet
            },
            {
                $set: {
                    'confirmation.confirmedAt': new Date(),
                    'confirmation.confirmedVia': 'email',
                    'confirmation.decidedAt': new Date(),
                    'confirmation.decidedVia': 'email',
                    orderStatus: 'confirmed',
                }
            },
            { new: true }
        );

        if (!updated) {
            // Someone else decided between our read and write — re-read for fresh state
            const freshOrder = await Order.findOne({ 'confirmation.token': token });
            if (freshOrder) {
                return res.status(200).json({ 
                    msg: freshOrder.confirmation?.confirmedAt ? 'Already confirmed' : 'Already declined', 
                    order: sanitizeOrderForPublic(freshOrder) 
                });
            }
            return res.status(404).json({ msg: 'Order not found' });
        }

        await syncAllSellerFulfillmentStatus(updated, 'confirmed');

        // Notify sellers of the products in this order via email + mobile push
        try {
            const productIds = updated.orderItems.map(i => i.productId);
            const products = await Product.find({ _id: { $in: productIds } });
            const sellerIds = [...new Set(products.map(p => p.seller?.toString()).filter(Boolean))];
            const buyerName = updated.shippingInfo?.fullName || 'A buyer';
            for (const sellerId of sellerIds) {
                const seller = await User.findById(sellerId);
                if (seller?.email) {
                    const data = sellerOrderConfirmedByBuyerEmail(updated, seller.username);
                    sendEmail({ to: seller.email, ...data }).catch(e =>
                        console.error('seller confirm email failed:', e.message)
                    );
                }
                // Mobile push to seller
                sendPushToUser(sellerId, {
                    title: 'Buyer confirmed an order',
                    body: `${buyerName} confirmed order ${updated.orderId} via email — ready to process.`,
                    channelId: 'seller',
                    data: {
                        type: 'order_confirmed_by_buyer',
                        orderId: updated.orderId,
                        orderObjectId: updated._id?.toString(),
                    },
                }).catch(e => console.error('seller push failed:', e.message));
                // WhatsApp notification to seller (fire-and-forget)
                notifySeller(sellerId, 'order_update', sellerTemplates.order_confirmed(updated)).catch(e =>
                    console.error('[whatsapp] seller order confirmed notification failed:', e.message)
                );
            }
        } catch (notifyErr) {
            console.error('Failed to notify seller of buyer confirmation:', notifyErr.message);
        }

        return res.status(200).json({ msg: 'Order confirmed', order: sanitizeOrderForPublic(updated) });
    } catch (err) {
        console.error('confirmOrder error:', err.message);
        return res.status(500).json({ msg: 'Server error' });
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
            // Use atomic update to prevent race
            const updated = await Order.findOneAndUpdate(
                { 
                    'confirmation.token': token,
                    'confirmation.confirmedVia': 'whatsapp', // guard
                    'confirmation.cancelledFromDashboardAt': null, // not already cancelled
                },
                {
                    $set: {
                        'confirmation.cancelledFromDashboardAt': new Date(),
                        'confirmation.cancelledFromDashboardNote': 
                            'Order was confirmed by buyer via WhatsApp, but buyer changed their mind and cancelled from the email confirmation page.',
                        orderStatus: 'cancelled',
                    }
                },
                { new: true }
            );
            if (!updated) {
                const freshOrder = await Order.findOne({ 'confirmation.token': token });
                return res.status(200).json({ msg: 'Order already processed', order: sanitizeOrderForPublic(freshOrder || order) });
            }
            await syncAllSellerFulfillmentStatus(updated, 'cancelled');
            // WhatsApp notification to sellers about cancellation (fire-and-forget)
            try {
                const productIds = updated.orderItems.map(i => i.productId);
                const products = await Product.find({ _id: { $in: productIds } });
                const sellerIds = [...new Set(products.map(p => p.seller?.toString()).filter(Boolean))];
                for (const sellerId of sellerIds) {
                    notifySeller(sellerId, 'order_update', sellerTemplates.order_cancelled(updated)).catch(e =>
                        console.error('[whatsapp] seller cross-channel cancel notification failed:', e.message)
                    );
                }
            } catch (notifyErr) {
                console.error('Failed to notify seller of cross-channel cancel via WhatsApp:', notifyErr.message);
            }
            return res.status(200).json({ msg: 'Order cancelled', order: sanitizeOrderForPublic(updated) });
        }

        // Already confirmed via another channel — return current state
        if (order.confirmation?.confirmedAt) {
            return res.status(200).json({ msg: 'Already confirmed', order: sanitizeOrderForPublic(order) });
        }

        // Atomic decline: only succeeds if decidedAt is still null
        const updated = await Order.findOneAndUpdate(
            { 
                'confirmation.token': token, 
                'confirmation.decidedAt': null  // guard: no decision yet
            },
            {
                $set: {
                    'confirmation.declinedAt': new Date(),
                    'confirmation.confirmedVia': 'email', // tracks decision channel (dual-purpose field)
                    'confirmation.decidedAt': new Date(),
                    'confirmation.decidedVia': 'email',
                    orderStatus: 'cancelled',
                }
            },
            { new: true }
        );

        if (!updated) {
            const freshOrder = await Order.findOne({ 'confirmation.token': token });
            if (freshOrder) {
                return res.status(200).json({
                    msg: freshOrder.confirmation?.confirmedAt ? 'Already confirmed' : 'Already declined',
                    order: sanitizeOrderForPublic(freshOrder)
                });
            }
            return res.status(404).json({ msg: 'Order not found' });
        }

        await syncAllSellerFulfillmentStatus(updated, 'cancelled');

        // Notify sellers of cancellation via WhatsApp (fire-and-forget)
        try {
            const productIds = updated.orderItems.map(i => i.productId);
            const products = await Product.find({ _id: { $in: productIds } });
            const sellerIds = [...new Set(products.map(p => p.seller?.toString()).filter(Boolean))];
            for (const sellerId of sellerIds) {
                notifySeller(sellerId, 'order_update', sellerTemplates.order_cancelled(updated)).catch(e =>
                    console.error('[whatsapp] seller order cancelled notification failed:', e.message)
                );
            }
        } catch (notifyErr) {
            console.error('Failed to notify seller of decline via WhatsApp:', notifyErr.message);
        }

        return res.status(200).json({ msg: 'Order declined', order: sanitizeOrderForPublic(updated) });
    } catch (err) {
        console.error('declineOrder error:', err.message);
        return res.status(500).json({ msg: 'Server error' });
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

        // Atomic update
        const updated = await Order.findOneAndUpdate(
            { 'confirmation.token': token, orderStatus: 'cancelled' },
            {
                $set: {
                    orderStatus: 'confirmed',
                    'confirmation.confirmedAt': new Date(),
                    'confirmation.confirmedVia': 'email',
                    'confirmation.decidedAt': new Date(),
                    'confirmation.decidedVia': 'email',
                    'confirmation.declinedAt': null,
                    'confirmation.cancelledFromDashboardAt': null,
                    'confirmation.cancelledFromDashboardNote': '',
                }
            },
            { new: true }
        );

        if (!updated) {
            const freshOrder = await Order.findOne({ 'confirmation.token': token });
            return res.status(200).json({ msg: 'Order already processed', order: sanitizeOrderForPublic(freshOrder || order) });
        }

        await syncAllSellerFulfillmentStatus(updated, 'confirmed');

        // Notify sellers
        try {
            const productIds = updated.orderItems.map(i => i.productId);
            const products = await Product.find({ _id: { $in: productIds } });
            const sellerIds = [...new Set(products.map(p => p.seller?.toString()).filter(Boolean))];
            const buyerName = updated.shippingInfo?.fullName || 'A buyer';
            for (const sellerId of sellerIds) {
                const seller = await User.findById(sellerId);
                if (seller?.email) {
                    const data = sellerOrderConfirmedByBuyerEmail(updated, seller.username);
                    sendEmail({ to: seller.email, ...data }).catch(e =>
                        console.error('seller reconfirm email failed:', e.message)
                    );
                }
                sendPushToUser(sellerId, {
                    title: 'Buyer re-confirmed an order',
                    body: `${buyerName} re-confirmed order ${updated.orderId} via email after previously cancelling.`,
                    channelId: 'seller',
                    data: { type: 'order_confirmed_by_buyer', orderId: updated.orderId, orderObjectId: updated._id?.toString() },
                }).catch(e => console.error('seller push failed:', e.message));
                // WhatsApp notification to seller (fire-and-forget)
                notifySeller(sellerId, 'order_update', sellerTemplates.order_confirmed(updated)).catch(e =>
                    console.error('[whatsapp] seller order reconfirmed notification failed:', e.message)
                );
            }
        } catch (notifyErr) {
            console.error('Failed to notify seller of reconfirm:', notifyErr.message);
        }

        return res.status(200).json({ msg: 'Order re-confirmed', order: sanitizeOrderForPublic(updated) });
    } catch (err) {
        console.error('reconfirmOrder error:', err.message);
        return res.status(500).json({ msg: 'Server error' });
    }
};
