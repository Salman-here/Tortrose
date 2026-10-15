const mongoose = require('mongoose');
const Order = require('../models/Order');
const ReturnRequest = require('../models/ReturnRequest');
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
    notifyBuyerReturnStatus,
    notifyReturnSettlementCompleted,
} = require('../services/returnNotificationService');

const toId = (value) => value?._id?.toString?.() || value?.toString?.() || '';
const kindFilter = req => req.afterSalesKind === 'warranty' ? 'warranty' : { $ne: 'warranty' };

// The router, never request JSON, selects the workflow. This also prevents a
// normal-return endpoint from bypassing warranty approval requirements.
exports.requireWorkflow = async (req, res, next) => {
    if (!/^[a-f\d]{24}$/iu.test(req.params.id || '')) return res.status(400).json({ msg: 'A valid claim is required.' });
    try {
        const owner = req.user.role === 'admin' ? {} : { $or: [{ buyer: req.user.id }, { seller: req.user.id }] };
        if (!await ReturnRequest.exists({ _id: req.params.id, kind: kindFilter(req), ...owner })) {
            return res.status(404).json({ msg: 'Claim not found in this account.' });
        }
        return next();
    } catch (_) { return res.status(500).json({ msg: 'Unable to verify this claim.' }); }
};

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
        const headerRequestKey = req.get?.('Idempotency-Key');
        const bodyRequestKey = req.body?.requestKey;
        if (
            headerRequestKey
            && bodyRequestKey
            && String(headerRequestKey) !== String(bodyRequestKey)
        ) {
            return res.status(400).json({
                msg: 'Idempotency-Key header and request body key must match.',
                code: 'RETURN_IDEMPOTENCY_KEY_MISMATCH',
            });
        }
        const returnRequest = await createReturnRequest({
            orderId: req.body?.orderId,
            buyerId: req.user.id,
            sellerId: req.body?.sellerId,
            items: req.body?.items,
            reasonCategory: req.body?.reasonCategory,
            reasonDetails: req.body?.reasonDetails,
            evidenceIds: req.body?.evidenceIds,
            requestKey: headerRequestKey || bodyRequestKey,
        });
        const replayed = returnRequest.$locals?.idempotencyReplay === true;
        return res.status(replayed ? 200 : 201).json({
            success: true,
            replayed,
            msg: replayed
                ? 'This return request was already received.'
                : 'Return request sent to the seller.',
            returnRequest,
        });
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
        const query = { buyer: req.user.id, kind: kindFilter(req) };
        if (req.query.orderId) {
            if (!mongoose.Types.ObjectId.isValid(req.query.orderId)) {
                return res.status(400).json({ msg: 'A valid order is required.', code: 'RETURN_ORDER_INVALID' });
            }
            query.order = req.query.orderId;
        }
        const parsePageValue = (raw, fallback, maximum) => {
            if (raw === undefined) return fallback;
            if (typeof raw !== 'string' || !/^[1-9]\d*$/u.test(raw)) return null;
            const value = Number(raw);
            return Number.isSafeInteger(value) && value <= maximum ? value : null;
        };
        const page = parsePageValue(req.query.page, 1, 1_000_000);
        const limit = parsePageValue(req.query.limit, 100, 100);
        if (page === null || limit === null) {
            return res.status(400).json({ msg: 'Return pagination is invalid.', code: 'RETURN_PAGINATION_INVALID' });
        }
        const totalReturns = await ReturnRequest.countDocuments(query);
        const totalPages = Math.max(1, Math.ceil(totalReturns / limit));
        const requests = page > totalPages
            ? []
            : await ReturnRequest.find(query)
                .populate('seller', 'username avatar')
                .populate('store', 'storeName storeSlug')
                .sort({ createdAt: -1, _id: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean();
        return res.status(200).json({
            success: true,
            returns: requests,
            pagination: {
                page,
                limit,
                totalReturns,
                totalPages,
                hasMore: page < totalPages,
            },
        });
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
        const query = { seller: sellerId, kind: kindFilter(req) };
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
            expectedUpdatedAt: req.body?.expectedUpdatedAt,
        });
        return res.status(200).json({ success: true, msg: req.afterSalesKind === 'warranty' ? 'Warranty claim updated.' : 'Return status updated.', returnRequest });
    } catch (error) {
        console.error('[returns] status update error:', error);
        return res.status(error.statusCode || 500).json({ msg: error.message || 'Failed to update return status', code: error.code });
    }
};

exports.decideReturn = async (req, res) => {
    if (req.user.role !== 'seller') return res.status(403).json({ msg: 'Seller access required.' });
    if (!['approve', 'reject'].includes(req.body?.outcome)) return res.status(400).json({ msg: 'Choose approve or reject.' });
    try {
        const returnRequest = await updateReturnStatus({ returnRequestId: req.params.id, actor: req.user,
            nextStatus: req.body.outcome === 'approve' ? 'approved' : 'rejected', note: req.body.reason,
            expectedUpdatedAt: req.body.expectedUpdatedAt });
        return res.json({ success: true, returnRequest, msg: 'Return decision sent to the buyer.' });
    } catch (error) { return res.status(error.statusCode || 500).json({ msg: error.statusCode ? error.message : 'Unable to save the return decision.', code: error.code }); }
};

exports.cancelReturn = async (req, res) => {
    try {
        const returnRequest = await cancelReturnRequest({
            returnRequestId: req.params.id,
            buyerId: req.user.id,
            note: req.body?.note,
        });
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
            return res.status(200).json({ success: true, msg: 'Replacement approved.', returnRequest });
        }

        const fundingSource = req.body?.fundingSource;
        const originalOrder = await Order.findById(existing.order).select('paymentMethod isPaid');
        const heldOrder = existing.kind !== 'warranty' && ['wallet', 'safepay'].includes(originalOrder?.paymentMethod) && originalOrder.isPaid === true;
        if (heldOrder || fundingSource === 'seller_balance') {
            const returnRequest = await settleFromSellerBalance({ returnRequestId: existing._id, sellerId: req.user.id,
                expectedRefundAmount: req.body?.expectedRefundAmount, expectedRefundCurrency: req.body?.expectedRefundCurrency,
                expectedUpdatedAt: req.body?.expectedReturnUpdatedAt });
            const order = await Order.findById(returnRequest.order).lean();
            await notifyReturnSettlementCompleted(returnRequest, order);
            return res.status(200).json({
                success: true,
                msg: `${existing.kind === 'warranty' ? 'Warranty claim' : 'Return'} completed and buyer Wallet credited.`,
                returnRequest,
            });
        }
        if (fundingSource === 'card') {
            if (req.body?.paymentProvider === 'safepay') {
                require('../services/safepayPaymentService').requireMobileSafepay(req.body?.platform);
                const payment = await require('../services/returnService').createSafepayReturnSettlement({
                    returnRequestId: existing._id, sellerId: req.user.id, requestKey: req.body.requestKey, clientSurface: req.body.platform,
                });
                return res.status(200).json({ ...payment, success: true, requiresPayment: true });
            }
            if (existing.settlement?.provider === 'safepay' && existing.status === 'accepted_pending_payment') {
                return res.status(409).json({ msg: 'Resume this return using the same Safepay payment attempt.', code: 'RETURN_PROVIDER_MISMATCH' });
            }
            require('../middleware/safepayCutoverGuard').assertCurrentCardProvider('stripe');
            const result = await createReturnSettlementCheckout({
                returnRequestId: existing._id,
                sellerId: req.user.id,
                platform: req.body?.platform === 'mobile' ? 'mobile' : 'web',
            });
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
            availableBalance: error.availableBalance,
            availableBalanceCurrency: error.currency,
            availableBalanceUSD: error.availableBalanceUSD ?? (error.currency === 'USD' ? error.availableBalance : undefined),
        });
    }
};

exports.dispatchReplacement = async (req, res) => {
    try {
        if (req.user.role !== 'seller') return res.status(403).json({ msg: 'Seller access required.' });
        const returnRequest = await require('../services/replacementService').dispatchReplacement({
            requestId: req.params.id, sellerId: req.user.id, shippingMethod: req.body?.shippingMethod,
            carrier: req.body?.carrier, trackingNumber: req.body?.trackingNumber,
            operationKey: req.body?.operationKey, expectedUpdatedAt: req.body?.expectedUpdatedAt,
        });
        return res.json({ success: true, returnRequest, msg: 'Replacement shipped. The buyer can now track and confirm receipt.' });
    } catch (error) { return res.status(error.statusCode || 500).json({ msg: error.message || 'Unable to dispatch replacement.', code: error.code }); }
};

exports.receiveReplacement = async (req, res) => {
    try {
        const returnRequest = await require('../services/replacementService').confirmReplacementReceived({
            requestId: req.params.id, buyerId: req.user.id,
        });
        return res.json({ success: true, returnRequest, msg: 'Replacement received. Your original warranty deadline is unchanged.' });
    } catch (error) { return res.status(error.statusCode || 500).json({ msg: error.message || 'Unable to confirm receipt.', code: error.code }); }
};
