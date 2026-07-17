const Order = require('../models/Order');
const ReturnRequest = require('../models/ReturnRequest');
const Notification = require('../models/Notification');
const { notifySeller } = require('../services/whatsapp/sellerNotificationService');
const {
    buildOrderReturnEligibility,
    createReturnRequest,
    getReturnDetail,
    updateReturnStatus,
    cancelReturnRequest,
    settleFromSellerBalance,
    approveReplacement,
    createReturnSettlementCheckout,
} = require('../services/returnService');
const {
    notifySellerReturnRequested,
    notifyBuyerReturnStatus,
    notifyReturnSettlementCompleted,
    sellerReturnLink,
} = require('../services/returnNotificationService');

const toId = (value) => value?._id?.toString?.() || value?.toString?.() || '';

exports.getOrderReturnEligibility = async (req, res) => {
    try {
        const order = await Order.findOne({
            _id: req.params.orderId,
            user: req.user.id,
            awaitingPayment: { $ne: true },
        });
        if (!order) return res.status(404).json({ msg: 'Order not found.' });
        const groups = await buildOrderReturnEligibility(order);
        return res.status(200).json({ success: true, orderId: order.orderId, groups });
    } catch (error) {
        console.error('[returns] eligibility error:', error);
        return res.status(error.statusCode || 500).json({ msg: error.message || 'Failed to check return eligibility' });
    }
};

exports.createReturn = async (req, res) => {
    try {
        const returnRequest = await createReturnRequest({
            orderId: req.body?.orderId,
            buyerId: req.user.id,
            sellerId: req.body?.sellerId,
            items: req.body?.items,
            reasonCategory: req.body?.reasonCategory,
            reasonDetails: req.body?.reasonDetails,
            requestKey: req.body?.requestKey,
        });
        const order = await Order.findById(returnRequest.order).lean();
        await notifySellerReturnRequested(returnRequest, order);
        return res.status(201).json({ success: true, msg: 'Return request sent to the seller.', returnRequest });
    } catch (error) {
        console.error('[returns] create error:', error);
        return res.status(error.statusCode || 500).json({
            msg: error.message || 'Failed to create return request',
            code: error.code,
        });
    }
};

exports.listMyReturns = async (req, res) => {
    try {
        const query = { buyer: req.user.id };
        if (req.query.orderId) query.order = req.query.orderId;
        const requests = await ReturnRequest.find(query)
            .populate('seller', 'username avatar')
            .populate('store', 'storeName storeSlug')
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();
        return res.status(200).json({ success: true, returns: requests });
    } catch (error) {
        console.error('[returns] buyer list error:', error);
        return res.status(500).json({ msg: 'Failed to load return requests' });
    }
};

exports.listSellerReturns = async (req, res) => {
    try {
        if (!['seller', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ msg: 'Seller access required.' });
        }
        const sellerId = req.user.role === 'admin' && req.query.sellerId ? req.query.sellerId : req.user.id;
        const query = { seller: sellerId };
        if (req.query.status && req.query.status !== 'all') query.status = req.query.status;
        if (req.query.search) {
            const escaped = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query.$or = [
                { returnNumber: { $regex: escaped, $options: 'i' } },
                { orderId: { $regex: escaped, $options: 'i' } },
                { reasonDetails: { $regex: escaped, $options: 'i' } },
            ];
        }
        const requests = await ReturnRequest.find(query)
            .populate('buyer', 'username email avatar')
            .populate('store', 'storeName storeSlug')
            .sort({ createdAt: -1 })
            .limit(200)
            .lean();
        return res.status(200).json({ success: true, returns: requests });
    } catch (error) {
        console.error('[returns] seller list error:', error);
        return res.status(500).json({ msg: 'Failed to load seller return requests' });
    }
};

exports.getReturn = async (req, res) => {
    try {
        const request = await getReturnDetail({ returnRequestId: req.params.id, actor: req.user });
        if (!request) return res.status(404).json({ msg: 'Return request not found.' });
        return res.status(200).json({ success: true, returnRequest: request });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ msg: error.message || 'Failed to load return request' });
    }
};

exports.updateStatus = async (req, res) => {
    try {
        const returnRequest = await updateReturnStatus({
            returnRequestId: req.params.id,
            actor: req.user,
            nextStatus: req.body?.status,
            note: req.body?.note,
        });
        const order = await Order.findById(returnRequest.order).lean();
        await notifyBuyerReturnStatus(returnRequest, order, req.body?.note || '');
        return res.status(200).json({ success: true, msg: 'Return status updated.', returnRequest });
    } catch (error) {
        console.error('[returns] status update error:', error);
        return res.status(error.statusCode || 500).json({ msg: error.message || 'Failed to update return status', code: error.code });
    }
};

exports.cancelReturn = async (req, res) => {
    try {
        const returnRequest = await cancelReturnRequest({
            returnRequestId: req.params.id,
            buyerId: req.user.id,
            note: req.body?.note,
        });
        const body = `Buyer cancelled return #${returnRequest.returnNumber} for order #${returnRequest.orderId}.`;
        await Promise.allSettled([
            Notification.create({
                user: returnRequest.seller,
                title: 'Return request cancelled',
                body,
                category: 'order',
                linkTo: sellerReturnLink(returnRequest),
                source: 'system',
            }),
            notifySeller(returnRequest.seller, 'return_update', body),
        ]);
        return res.status(200).json({ success: true, msg: 'Return request cancelled.', returnRequest });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ msg: error.message || 'Failed to cancel return request' });
    }
};

exports.acceptReturn = async (req, res) => {
    try {
        if (req.user.role !== 'seller') return res.status(403).json({ msg: 'Seller access required.' });
        const existing = await ReturnRequest.findOne({ _id: req.params.id, seller: req.user.id });
        if (!existing) return res.status(404).json({ msg: 'Return request not found.' });

        if (existing.policySnapshot?.refundType === 'replacement_only') {
            const returnRequest = await approveReplacement({ returnRequestId: existing._id, sellerId: req.user.id });
            const order = await Order.findById(returnRequest.order).lean();
            await notifyBuyerReturnStatus(returnRequest, order);
            return res.status(200).json({ success: true, msg: 'Replacement approved.', returnRequest });
        }

        const fundingSource = req.body?.fundingSource;
        if (fundingSource === 'seller_balance') {
            const returnRequest = await settleFromSellerBalance({ returnRequestId: existing._id, sellerId: req.user.id });
            const order = await Order.findById(returnRequest.order).lean();
            await notifyReturnSettlementCompleted(returnRequest, order);
            return res.status(200).json({
                success: true,
                msg: 'Return completed and buyer wallet credited.',
                returnRequest,
            });
        }
        if (fundingSource === 'card') {
            const result = await createReturnSettlementCheckout({
                returnRequestId: existing._id,
                sellerId: req.user.id,
                platform: req.body?.platform === 'mobile' ? 'mobile' : 'web',
            });
            const order = await Order.findById(result.returnRequest.order).lean();
            await notifyBuyerReturnStatus(result.returnRequest, order);
            return res.status(200).json({
                success: true,
                requiresPayment: true,
                id: result.session.id,
                url: result.session.url,
                returnRequest: result.returnRequest,
            });
        }
        return res.status(400).json({ msg: 'Choose seller balance or card to fund the wallet refund.' });
    } catch (error) {
        console.error('[returns] accept error:', error);
        return res.status(error.statusCode || 500).json({
            msg: error.message || 'Failed to accept return',
            code: error.code,
            availableBalanceUSD: error.availableBalanceUSD,
        });
    }
};
