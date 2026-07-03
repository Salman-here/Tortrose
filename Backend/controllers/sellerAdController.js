const mongoose = require('mongoose');
const SellerAdRequest = require('../models/SellerAdRequest');
const SellerSubscription = require('../models/SellerSubscription');
const Product = require('../models/Product');
const Store = require('../models/Store');

const META_ADS_ADDON_CENTS = Math.max(0, Number(process.env.META_ADS_ADDON_CENTS || 0));

const featuredProductSelect = 'name image images category price discountedPrice currency priceCurrency isFeatured seller';

function isEliteSubscription(subscription) {
    return subscription?.plan === 'elite' && ['active', 'free_period'].includes(subscription?.status);
}

function toId(value) {
    return value?._id?.toString?.() || value?.toString?.() || '';
}

function cleanProductIds(productIds = []) {
    return [...new Set(
        (Array.isArray(productIds) ? productIds : [])
            .map((id) => String(id || '').trim())
            .filter((id) => mongoose.Types.ObjectId.isValid(id))
    )];
}

function serializeRequest(request) {
    if (!request) return null;
    const doc = request.toObject ? request.toObject() : request;
    return {
        ...doc,
        productIds: (doc.products || []).map((product) => toId(product)).filter(Boolean),
    };
}

async function getSellerAdState(sellerId) {
    const [subscription, store, featuredProducts, activeRequest, pendingRequests, recentRequests] = await Promise.all([
        SellerSubscription.findOne({ seller: sellerId }).lean(),
        Store.findOne({ seller: sellerId }).select('storeName storeSlug logo seller').lean(),
        Product.find({
            seller: sellerId,
            isFeatured: true,
            isBlocked: { $ne: true },
            moderationStatus: { $ne: 'blocked' },
        })
            .select(featuredProductSelect)
            .sort({ updatedAt: -1, createdAt: -1 })
            .lean(),
        SellerAdRequest.findOne({ seller: sellerId, status: 'approved', active: true })
            .populate('products', featuredProductSelect)
            .sort({ updatedAt: -1 })
            .lean(),
        SellerAdRequest.find({ seller: sellerId, status: 'pending' })
            .populate('products', featuredProductSelect)
            .sort({ createdAt: -1 })
            .limit(5)
            .lean(),
        SellerAdRequest.find({ seller: sellerId })
            .populate('products', featuredProductSelect)
            .sort({ createdAt: -1 })
            .limit(12)
            .lean(),
    ]);

    return {
        subscription: {
            plan: subscription?.plan || 'free_trial',
            status: subscription?.status || 'trial',
            planName: subscription?.planName || 'Free Trial',
            metaAdsIncluded: Boolean(subscription?.metaAdsIncluded),
        },
        isElite: isEliteSubscription(subscription),
        metaAdsAddonCents: META_ADS_ADDON_CENTS,
        store,
        featuredProducts,
        activeRequest: serializeRequest(activeRequest),
        pendingRequests: pendingRequests.map(serializeRequest),
        recentRequests: recentRequests.map(serializeRequest),
    };
}

exports.getSellerAdsOverview = async (req, res) => {
    try {
        if (req.user.role !== 'seller') {
            return res.status(403).json({ msg: 'Seller access required.' });
        }

        const state = await getSellerAdState(req.user.id);
        res.json(state);
    } catch (error) {
        console.error('Get seller ads overview error:', error);
        res.status(500).json({ msg: 'Failed to load seller ads.' });
    }
};

exports.submitSellerAdRequest = async (req, res) => {
    try {
        if (req.user.role !== 'seller') {
            return res.status(403).json({ msg: 'Seller access required.' });
        }

        const sellerId = req.user.id;
        const subscription = await SellerSubscription.findOne({ seller: sellerId }).lean();
        if (!isEliteSubscription(subscription)) {
            return res.status(403).json({
                msg: 'Subscribe to Rozare Elite to run ads for your store and featured products.',
                requiresElite: true,
            });
        }

        const existingPending = await SellerAdRequest.findOne({ seller: sellerId, status: 'pending' }).select('_id');
        if (existingPending) {
            return res.status(409).json({ msg: 'You already have an ads request waiting for admin approval.' });
        }

        const requestType = ['start', 'update', 'stop'].includes(req.body?.requestType)
            ? req.body.requestType
            : 'start';
        const includeMeta = Boolean(req.body?.includeMeta);
        const sellerNote = String(req.body?.sellerNote || '').trim().slice(0, 500);
        const productIds = cleanProductIds(req.body?.productIds);

        if (requestType !== 'stop' && productIds.length === 0) {
            return res.status(400).json({ msg: 'Select at least one featured product for ads.' });
        }

        if (requestType === 'stop') {
            const activeRequest = await SellerAdRequest.findOne({ seller: sellerId, status: 'approved', active: true }).select('_id');
            if (!activeRequest) {
                return res.status(400).json({ msg: 'There is no active ads campaign to stop.' });
            }
        }

        const store = await Store.findOne({ seller: sellerId }).select('_id');
        const productFilter = {
            seller: sellerId,
            isFeatured: true,
            isBlocked: { $ne: true },
            moderationStatus: { $ne: 'blocked' },
            _id: { $in: productIds },
        };
        const validProducts = requestType === 'stop'
            ? []
            : await Product.find(productFilter).select('_id').lean();

        if (requestType !== 'stop' && validProducts.length !== productIds.length) {
            return res.status(400).json({ msg: 'Only your active featured products can be selected for ads.' });
        }

        const request = await SellerAdRequest.create({
            seller: sellerId,
            store: store?._id || null,
            products: requestType === 'stop' ? [] : validProducts.map((p) => p._id),
            requestType,
            status: 'pending',
            active: false,
            channels: {
                tiktok: true,
                meta: includeMeta,
            },
            sellerNote,
        });

        const populated = await SellerAdRequest.findById(request._id)
            .populate('products', featuredProductSelect)
            .populate('store', 'storeName storeSlug logo')
            .lean();

        res.status(201).json({
            msg: requestType === 'stop'
                ? 'Ads stop request sent for admin approval.'
                : 'Ads request sent for admin approval.',
            request: serializeRequest(populated),
        });
    } catch (error) {
        console.error('Submit seller ad request error:', error);
        res.status(500).json({ msg: 'Failed to submit ads request.' });
    }
};

exports.getAdminAdRequests = async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ msg: 'Admin access required.' });
        }

        const [requests, pendingCount, activeCount, approvedCount, rejectedCount] = await Promise.all([
            SellerAdRequest.find()
                .populate('seller', 'username email')
                .populate('store', 'storeName storeSlug logo')
                .populate('products', featuredProductSelect)
                .populate('reviewedBy', 'username email')
                .sort({ status: 1, createdAt: -1 })
                .limit(100)
                .lean(),
            SellerAdRequest.countDocuments({ status: 'pending' }),
            SellerAdRequest.countDocuments({ status: 'approved', active: true }),
            SellerAdRequest.countDocuments({ status: 'approved' }),
            SellerAdRequest.countDocuments({ status: 'rejected' }),
        ]);

        res.json({
            requests: requests.map(serializeRequest),
            stats: {
                pending: pendingCount,
                active: activeCount,
                approved: approvedCount,
                rejected: rejectedCount,
                total: pendingCount + approvedCount + rejectedCount,
            },
        });
    } catch (error) {
        console.error('Get admin ad requests error:', error);
        res.status(500).json({ msg: 'Failed to load ads requests.' });
    }
};

exports.reviewAdRequest = async (req, res) => {
    const session = await mongoose.startSession();
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ msg: 'Admin access required.' });
        }

        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ msg: 'Invalid ads request id.' });
        }

        const decision = req.body?.status;
        if (!['approved', 'rejected'].includes(decision)) {
            return res.status(400).json({ msg: 'Status must be approved or rejected.' });
        }

        const adminNote = String(req.body?.adminNote || '').trim().slice(0, 1000);
        let reviewedRequest;

        await session.withTransaction(async () => {
            const request = await SellerAdRequest.findById(id).session(session);
            if (!request) {
                const err = new Error('Ads request not found.');
                err.statusCode = 404;
                throw err;
            }

            if (request.status !== 'pending') {
                const err = new Error('This ads request has already been reviewed.');
                err.statusCode = 400;
                throw err;
            }

            if (decision === 'approved') {
                await SellerAdRequest.updateMany(
                    {
                        seller: request.seller,
                        _id: { $ne: request._id },
                        active: true,
                    },
                    { $set: { active: false } },
                    { session }
                );
                request.active = request.requestType !== 'stop';
            } else {
                request.active = false;
            }

            request.status = decision;
            request.adminNote = adminNote;
            request.reviewedBy = req.user.id;
            request.reviewedAt = new Date();
            await request.save({ session });
            reviewedRequest = request;
        });

        const populated = await SellerAdRequest.findById(reviewedRequest._id)
            .populate('seller', 'username email')
            .populate('store', 'storeName storeSlug logo')
            .populate('products', featuredProductSelect)
            .populate('reviewedBy', 'username email')
            .lean();

        res.json({
            msg: `Ads request ${decision}.`,
            request: serializeRequest(populated),
        });
    } catch (error) {
        console.error('Review ad request error:', error);
        res.status(error.statusCode || 500).json({ msg: error.message || 'Failed to review ads request.' });
    } finally {
        session.endSession();
    }
};
