const Coupon = require('../models/Coupon');
const Product = require('../models/Product');
const Store = require('../models/Store');
const User = require('../models/User');
const mongoose = require('mongoose');
const { publicProductFilter } = require('../services/productModerationService');
const {
    resolveRequestedCurrency,
    convertOrderAmount,
    lineTotal,
    roundMoney,
    toId,
    itemBelongsToSeller,
} = require('../services/orderMoneyService');

const isObjectId = (value) => (
    typeof value === 'string' &&
    mongoose.Types.ObjectId.isValid(value) &&
    String(new mongoose.Types.ObjectId(value)) === value.toLowerCase()
);

const isMissingIdentifier = (value) => {
    const normalized = String(value || '').trim();
    return !normalized || ['undefined', 'null', '[object Object]'].includes(normalized);
};

const stripInternalCouponFields = (coupon) => {
    const obj = coupon.toObject ? coupon.toObject() : { ...coupon };
    delete obj.maxUses;
    delete obj.usedCount;
    return obj;
};

const resolveSellerIdForStoreCoupons = async (identifier) => {
    if (isMissingIdentifier(identifier)) return null;

    const value = decodeURIComponent(String(identifier).trim());

    if (isObjectId(value)) {
        const store = await Store.findOne({
            isActive: true,
            $or: [{ _id: value }, { seller: value }],
        }).select('seller');

        return store?.seller || value;
    }

    const store = await Store.findOne({
        isActive: true,
        storeSlug: value.toLowerCase(),
    }).select('seller');

    return store?.seller || null;
};

const normalizeCouponCode = (code) =>
    String(code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');

const parseOptionalPositiveNumber = (value, field, { allowNull = true, integer = false } = {}) => {
    if (value === undefined || value === null || value === '') {
        if (allowNull) return { value: null };
        return { error: `${field} is required.` };
    }
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return { error: `${field} must be greater than 0.` };
    return { value: integer ? Math.floor(number) : number };
};

const parseOptionalNonNegativeNumber = (value, field, fallback = 0) => {
    if (value === undefined || value === null || value === '') return { value: fallback };
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return { error: `${field} must be zero or higher.` };
    return { value: number };
};

const normalizeProductIds = (productIds) => (
    Array.isArray(productIds)
        ? [...new Set(productIds.map(id => String(id || '').trim()).filter(isObjectId))]
        : []
);

const validateSelectedProducts = async (sellerId, applicableTo, productIds) => {
    if (applicableTo !== 'selected') return { productIds: [] };
    const normalizedIds = normalizeProductIds(productIds);
    if (!normalizedIds.length) return { error: 'Choose at least one valid product for a selected-product coupon.' };

    const count = await Product.countDocuments({ _id: { $in: normalizedIds }, seller: sellerId });
    if (count !== normalizedIds.length) return { error: 'Some selected products were not found in your store.' };
    return { productIds: normalizedIds };
};

// ─── Create a coupon ───
exports.createCoupon = async (req, res) => {
    try {
        const sellerId = req.user.id;
        const {
            code, discountType, discountValue, applicableTo, applicableProducts,
            maxUses, maxUsesPerUser, minOrderAmount, maxDiscountAmount,
            startDate, expiryDate, description,
        } = req.body;

        const normalizedCode = normalizeCouponCode(code);
        if (normalizedCode.length < 3 || normalizedCode.length > 32) {
            return res.status(400).json({ msg: 'Coupon code must be 3 to 32 letters or numbers.' });
        }

        if (!['percentage', 'fixed'].includes(discountType)) {
            return res.status(400).json({ msg: 'Discount type must be percentage or fixed.' });
        }

        const parsedDiscount = parseOptionalPositiveNumber(discountValue, 'Discount value', { allowNull: false });
        if (parsedDiscount.error) return res.status(400).json({ msg: parsedDiscount.error });
        if (discountType === 'percentage' && parsedDiscount.value > 100) {
            return res.status(400).json({ msg: 'Percentage discount must be between 1 and 100.' });
        }

        const startsAt = startDate ? new Date(startDate) : new Date();
        const expiresAt = expiryDate ? new Date(expiryDate) : null;
        if (Number.isNaN(startsAt.getTime()) || !expiresAt || Number.isNaN(expiresAt.getTime())) {
            return res.status(400).json({ msg: 'Start date or expiry date is invalid.' });
        }
        if (expiresAt <= new Date()) {
            return res.status(400).json({ msg: 'Expiry date must be in the future.' });
        }
        if (startsAt >= expiresAt) {
            return res.status(400).json({ msg: 'Expiry date must be after the start date.' });
        }

        const couponScope = applicableTo === 'selected' ? 'selected' : 'all';
        const selectedProducts = await validateSelectedProducts(sellerId, couponScope, applicableProducts);
        if (selectedProducts.error) return res.status(400).json({ msg: selectedProducts.error });
        const couponCurrency = await resolveRequestedCurrency(req, User);

        const parsedMaxUses = parseOptionalPositiveNumber(maxUses, 'Max uses', { integer: true });
        const parsedMaxUsesPerUser = parseOptionalPositiveNumber(maxUsesPerUser ?? 1, 'Max uses per user', { allowNull: false, integer: true });
        const parsedMinOrderAmount = parseOptionalNonNegativeNumber(minOrderAmount, 'Minimum order amount', 0);
        const parsedMaxDiscountAmount = parseOptionalPositiveNumber(maxDiscountAmount ?? req.body.maxDiscount, 'Maximum discount amount');
        for (const parsed of [parsedMaxUses, parsedMaxUsesPerUser, parsedMinOrderAmount, parsedMaxDiscountAmount]) {
            if (parsed.error) return res.status(400).json({ msg: parsed.error });
        }

        const coupon = await Coupon.create({
            seller: sellerId,
            code: normalizedCode,
            discountType,
            discountValue: parsedDiscount.value,
            currency: couponCurrency,
            applicableTo: couponScope,
            applicableProducts: selectedProducts.productIds,
            maxUses: parsedMaxUses.value,
            maxUsesPerUser: parsedMaxUsesPerUser.value,
            minOrderAmount: parsedMinOrderAmount.value,
            maxDiscountAmount: parsedMaxDiscountAmount.value,
            startDate: startsAt,
            expiryDate: expiresAt,
            description: description || '',
        });

        res.status(201).json({ msg: 'Coupon created successfully!', coupon });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ msg: 'You already have a coupon with this code.' });
        }
        console.error('Create coupon error:', error);
        res.status(500).json({ msg: 'Failed to create coupon.' });
    }
};

// ─── Get seller's coupons ───
exports.getSellerCoupons = async (req, res) => {
    try {
        const sellerId = req.user.id;
        const coupons = await Coupon.find({ seller: sellerId })
            .populate('applicableProducts', 'name image price currency priceCurrency')
            .sort({ createdAt: -1 });

        res.json({ coupons });
    } catch (error) {
        console.error('Get coupons error:', error);
        res.status(500).json({ msg: 'Failed to fetch coupons.' });
    }
};

// ─── Update a coupon ───
exports.updateCoupon = async (req, res) => {
    try {
        const sellerId = req.user.id;
        const { id } = req.params;
        const updates = req.body;

        if (!isObjectId(id)) return res.status(400).json({ msg: 'Invalid coupon id.' });
        const coupon = await Coupon.findOne({ _id: id, seller: sellerId });
        if (!coupon) return res.status(404).json({ msg: 'Coupon not found.' });

        const allowedFields = [
            'code', 'discountType', 'discountValue', 'currency', 'applicableTo', 'applicableProducts',
            'maxUses', 'maxUsesPerUser', 'minOrderAmount', 'maxDiscountAmount',
            'startDate', 'expiryDate', 'isActive', 'description',
        ];

        if (!allowedFields.some(field => updates[field] !== undefined)) {
            return res.status(400).json({ msg: 'No valid coupon fields were provided.' });
        }

        if (updates.code !== undefined) {
            const normalizedCode = normalizeCouponCode(updates.code);
            if (normalizedCode.length < 3 || normalizedCode.length > 32) {
                return res.status(400).json({ msg: 'Coupon code must be 3 to 32 letters or numbers.' });
            }
            coupon.code = normalizedCode;
        }

        if (updates.discountType !== undefined) {
            if (!['percentage', 'fixed'].includes(updates.discountType)) {
                return res.status(400).json({ msg: 'Discount type must be percentage or fixed.' });
            }
            coupon.discountType = updates.discountType;
        }

        if (updates.discountValue !== undefined) {
            const parsedDiscount = parseOptionalPositiveNumber(updates.discountValue, 'Discount value', { allowNull: false });
            if (parsedDiscount.error) return res.status(400).json({ msg: parsedDiscount.error });
            coupon.discountValue = parsedDiscount.value;
        }
        if (updates.currency !== undefined) {
            coupon.currency = await resolveRequestedCurrency(req, User, coupon.currency || 'USD');
        }

        if (coupon.discountType === 'percentage' && coupon.discountValue > 100) {
            return res.status(400).json({ msg: 'Percentage discount must be between 1 and 100.' });
        }

        if (updates.startDate !== undefined) {
            const startsAt = new Date(updates.startDate);
            if (Number.isNaN(startsAt.getTime())) return res.status(400).json({ msg: 'Start date is invalid.' });
            coupon.startDate = startsAt;
        }

        if (updates.expiryDate !== undefined) {
            const expiresAt = new Date(updates.expiryDate);
            if (Number.isNaN(expiresAt.getTime())) return res.status(400).json({ msg: 'Expiry date is invalid.' });
            if (expiresAt <= new Date()) return res.status(400).json({ msg: 'Expiry date must be in the future.' });
            coupon.expiryDate = expiresAt;
        }

        if (new Date(coupon.startDate) >= new Date(coupon.expiryDate)) {
            return res.status(400).json({ msg: 'Expiry date must be after the start date.' });
        }

        if (updates.isActive !== undefined) {
            const wantsActive = updates.isActive === true || updates.isActive === 'true';
            if (wantsActive && new Date(coupon.expiryDate) <= new Date()) {
                return res.status(400).json({ msg: 'Expired coupons cannot be activated.' });
            }
            coupon.isActive = wantsActive;
        }

        if (updates.maxUses !== undefined) {
            const parsed = parseOptionalPositiveNumber(updates.maxUses, 'Max uses', { integer: true });
            if (parsed.error) return res.status(400).json({ msg: parsed.error });
            coupon.maxUses = parsed.value;
        }

        if (updates.maxUsesPerUser !== undefined) {
            const parsed = parseOptionalPositiveNumber(updates.maxUsesPerUser, 'Max uses per user', { allowNull: false, integer: true });
            if (parsed.error) return res.status(400).json({ msg: parsed.error });
            coupon.maxUsesPerUser = parsed.value;
        }

        if (updates.minOrderAmount !== undefined) {
            const parsed = parseOptionalNonNegativeNumber(updates.minOrderAmount, 'Minimum order amount', coupon.minOrderAmount);
            if (parsed.error) return res.status(400).json({ msg: parsed.error });
            coupon.minOrderAmount = parsed.value;
        }

        if (updates.maxDiscountAmount !== undefined) {
            const parsed = parseOptionalPositiveNumber(updates.maxDiscountAmount, 'Maximum discount amount');
            if (parsed.error) return res.status(400).json({ msg: parsed.error });
            coupon.maxDiscountAmount = parsed.value;
        }

        if (updates.applicableTo !== undefined) {
            if (!['all', 'selected'].includes(updates.applicableTo)) {
                return res.status(400).json({ msg: 'Coupon scope must be all or selected.' });
            }
            coupon.applicableTo = updates.applicableTo;
        }

        if (updates.applicableProducts !== undefined || updates.applicableTo !== undefined) {
            const productSource = updates.applicableProducts !== undefined
                ? updates.applicableProducts
                : coupon.applicableProducts;
            const selectedProducts = await validateSelectedProducts(sellerId, coupon.applicableTo, productSource);
            if (selectedProducts.error) return res.status(400).json({ msg: selectedProducts.error });
            coupon.applicableProducts = selectedProducts.productIds;
        }

        if (updates.description !== undefined) coupon.description = String(updates.description || '');

        await coupon.save();
        res.json({ msg: 'Coupon updated successfully!', coupon });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ msg: 'You already have a coupon with this code.' });
        }
        console.error('Update coupon error:', error);
        res.status(500).json({ msg: 'Failed to update coupon.' });
    }
};

// ─── Delete a coupon ───
exports.deleteCoupon = async (req, res) => {
    try {
        const sellerId = req.user.id;
        const { id } = req.params;

        const coupon = await Coupon.findOneAndDelete({ _id: id, seller: sellerId });
        if (!coupon) return res.status(404).json({ msg: 'Coupon not found.' });

        res.json({ msg: 'Coupon deleted successfully!' });
    } catch (error) {
        console.error('Delete coupon error:', error);
        res.status(500).json({ msg: 'Failed to delete coupon.' });
    }
};

// ─── Toggle coupon active/inactive ───
exports.toggleCoupon = async (req, res) => {
    try {
        const sellerId = req.user.id;
        const { id } = req.params;

        const coupon = await Coupon.findOne({ _id: id, seller: sellerId });
        if (!coupon) return res.status(404).json({ msg: 'Coupon not found.' });

        coupon.isActive = !coupon.isActive;
        await coupon.save();

        res.json({ msg: `Coupon ${coupon.isActive ? 'activated' : 'deactivated'}!`, coupon });
    } catch (error) {
        console.error('Toggle coupon error:', error);
        res.status(500).json({ msg: 'Failed to toggle coupon.' });
    }
};

// ─── Validate & apply coupon at checkout (called from frontend) ───
exports.validateCoupon = async (req, res) => {
    try {
        const userId = req.user.id;
        const { code, productIds } = req.body;
        // productIds = array of product IDs the user is trying to apply this coupon to

        if (!code) return res.status(400).json({ msg: 'Coupon code is required.' });

        const coupon = await Coupon.findOne({ code: code.toUpperCase().trim() })
            .populate('applicableProducts', '_id');

        if (!coupon) return res.status(404).json({ msg: 'Invalid coupon code.' });

        // Check active
        if (!coupon.isActive) return res.status(400).json({ msg: 'This coupon is no longer active.' });

        // Check dates
        const now = new Date();
        if (now < coupon.startDate) return res.status(400).json({ msg: 'This coupon is not yet valid.' });
        if (now > coupon.expiryDate) return res.status(400).json({ msg: 'This coupon has expired.' });

        // Check total usage limit
        if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
            return res.status(400).json({ msg: 'This coupon has reached its usage limit.' });
        }

        // Check per-user usage limit
        const userUsage = coupon.usedBy.find(u => u.user.toString() === userId);
        if (userUsage && userUsage.count >= coupon.maxUsesPerUser) {
            return res.status(400).json({ msg: 'You have already used this coupon the maximum number of times.' });
        }

        // Determine which products the coupon applies to
        let applicableProductIds = [];
        if (coupon.applicableTo === 'all') {
            // All products from this seller — filter productIds by seller
            const sellerProducts = await Product.find({ seller: coupon.seller, _id: { $in: productIds } }).select('_id');
            applicableProductIds = sellerProducts.map(p => p._id.toString());
        } else {
            // Only selected products
            const couponProductIds = coupon.applicableProducts.map(p => p._id.toString());
            applicableProductIds = productIds.filter(pid => couponProductIds.includes(pid));
        }

        if (applicableProductIds.length === 0) {
            return res.status(400).json({ msg: 'This coupon does not apply to any of your selected products.' });
        }

        res.json({
            valid: true,
            coupon: {
                _id: coupon._id,
                code: coupon.code,
                discountType: coupon.discountType,
                discountValue: coupon.discountValue,
                currency: coupon.currency || 'USD',
                applicableTo: coupon.applicableTo,
                applicableProductIds,
                minOrderAmount: coupon.minOrderAmount,
                maxDiscountAmount: coupon.maxDiscountAmount,
                seller: coupon.seller,
                description: coupon.description,
            },
        });
    } catch (error) {
        console.error('Validate coupon error:', error);
        res.status(500).json({ msg: 'Failed to validate coupon.' });
    }
};

// ─── Get available coupons for checkout (by seller IDs in cart) ───
exports.getCheckoutCoupons = async (req, res) => {
    try {
        const { sellerIds } = req.body;
        if (!sellerIds || sellerIds.length === 0) {
            return res.json({ sellerCoupons: {} });
        }

        const now = new Date();
        const coupons = await Coupon.find({
            seller: { $in: sellerIds },
            isActive: true,
            startDate: { $lte: now },
            expiryDate: { $gte: now },
        }).populate('applicableProducts', '_id name');

        // Filter out fully used coupons
        const validCoupons = coupons.filter(c => c.maxUses === null || c.usedCount < c.maxUses);

        // Group by seller
        const sellerCoupons = {};
        validCoupons.forEach(c => {
            const sid = c.seller.toString();
            if (!sellerCoupons[sid]) sellerCoupons[sid] = [];
            sellerCoupons[sid].push({
                _id: c._id,
                code: c.code,
                discountType: c.discountType,
                discountValue: c.discountValue,
                currency: c.currency || 'USD',
                applicableTo: c.applicableTo,
                applicableProducts: c.applicableProducts.map(p => p._id.toString()),
                minOrderAmount: c.minOrderAmount,
                maxDiscountAmount: c.maxDiscountAmount,
                description: c.description,
                expiryDate: c.expiryDate,
            });
        });

        res.json({ sellerCoupons });
    } catch (error) {
        console.error('Get checkout coupons error:', error);
        res.status(500).json({ msg: 'Failed to fetch coupons.' });
    }
};

// ─── Coupon Analytics for Sellers ───
exports.getCouponAnalytics = async (req, res) => {
    try {
        const sellerId = req.user.id;
        const Order = require('../models/Order');
        const targetCurrency = await resolveRequestedCurrency(req, User);

        const coupons = await Coupon.find({ seller: sellerId })
            .populate('applicableProducts', 'name image price currency priceCurrency')
            .sort({ usedCount: -1 });

        const sellerProductIds = await Product.find({ seller: sellerId }).distinct('_id');
        const sellerProductIdSet = new Set(sellerProductIds.map(toId));

        // Get all orders with this seller's coupons
        const sellerCouponIds = coupons.map(c => c._id.toString());
        const ordersWithCoupons = await Order.find({
            'appliedCoupons.couponId': { $in: sellerCouponIds },
            awaitingPayment: { $ne: true },
        });

        // Calculate per-coupon analytics
        const couponAnalytics = await Promise.all(coupons.map(async coupon => {
            const couponId = toId(coupon._id);
            const attributedOrders = [];

            for (const order of ordersWithCoupons) {
                const appliedCoupon = (order.appliedCoupons || []).find(
                    entry => toId(entry?.couponId) === couponId
                );
                if (!appliedCoupon) continue;

                // The checkout snapshot is the source of truth for which lines
                // this coupon actually discounted. Current coupon configuration
                // may have changed since the order was placed.
                const applicableProductIds = new Set(
                    (appliedCoupon.applicableProductIds || []).map(toId).filter(Boolean)
                );
                if (!applicableProductIds.size) continue;

                const applicableItems = (order.orderItems || []).filter(
                    item => applicableProductIds.has(toId(item?.productId))
                );
                const sellerItems = applicableItems.filter(
                    item => itemBelongsToSeller(item, sellerId, sellerProductIdSet)
                );
                if (!sellerItems.length) continue;

                const applicableSubtotal = applicableItems.reduce((sum, item) => sum + lineTotal(item), 0);
                const sellerSubtotal = sellerItems.reduce((sum, item) => sum + lineTotal(item), 0);
                if (sellerSubtotal <= 0) continue;

                // A malformed legacy record can contain another seller's line.
                // Attribute only this seller's proportional share of the exact
                // discount persisted for this coupon, never the global order
                // couponDiscount value.
                const persistedDiscount = Math.max(0, Number(appliedCoupon.appliedDiscountAmount) || 0);
                const sellerDiscount = applicableSubtotal > 0
                    ? Math.min(sellerSubtotal, persistedDiscount * (sellerSubtotal / applicableSubtotal))
                    : 0;

                attributedOrders.push({ order, sellerSubtotal, sellerDiscount });
            }

            let totalRevenue = 0;
            let totalDiscount = 0;
            for (const attribution of attributedOrders) {
                totalRevenue += await convertOrderAmount(
                    attribution.order,
                    attribution.sellerSubtotal,
                    targetCurrency
                );
                totalDiscount += await convertOrderAmount(
                    attribution.order,
                    attribution.sellerDiscount,
                    targetCurrency
                );
            }
            totalRevenue = roundMoney(totalRevenue);
            totalDiscount = roundMoney(totalDiscount);

            const ordersGenerated = attributedOrders.length;
            const uniqueUsers = new Set(
                attributedOrders.map(({ order }) => toId(order.user)).filter(Boolean)
            ).size;

            const conversionRate = coupon.maxUses
                ? Math.round((ordersGenerated / coupon.maxUses) * 100)
                : null;

            return {
                _id: coupon._id,
                code: coupon.code,
                discountType: coupon.discountType,
                discountValue: coupon.discountValue,
                currency: coupon.currency || 'USD',
                applicableTo: coupon.applicableTo,
                applicableProducts: coupon.applicableProducts,
                isActive: coupon.isActive,
                usedCount: coupon.usedCount,
                maxUses: coupon.maxUses,
                expiryDate: coupon.expiryDate,
                startDate: coupon.startDate,
                description: coupon.description,
                totalRevenue,
                totalDiscount,
                ordersGenerated,
                conversionRate,
                avgOrderValue: ordersGenerated > 0
                    ? roundMoney(totalRevenue / ordersGenerated)
                    : 0,
                uniqueUsers,
            };
        }));

        // Summary stats
        const totalCoupons = coupons.length;
        const activeCoupons = coupons.filter(c => c.isActive && new Date() <= new Date(c.expiryDate)).length;
        const totalUses = couponAnalytics.reduce((sum, coupon) => sum + coupon.ordersGenerated, 0);
        const totalRevenueFromCoupons = couponAnalytics.reduce((s, c) => s + c.totalRevenue, 0);
        const totalDiscountGiven = couponAnalytics.reduce((s, c) => s + c.totalDiscount, 0);
        const topCoupon = couponAnalytics.length > 0
            ? couponAnalytics.reduce(
                (best, current) => current.ordersGenerated > best.ordersGenerated ? current : best,
                couponAnalytics[0]
            )
            : null;

        res.json({
            analytics: couponAnalytics,
            summary: {
                currency: targetCurrency,
                totalCoupons,
                activeCoupons,
                totalUses,
                totalRevenueFromCoupons: Math.round(totalRevenueFromCoupons * 100) / 100,
                totalDiscountGiven: Math.round(totalDiscountGiven * 100) / 100,
                topCouponCode: topCoupon?.code || null,
            }
        });
    } catch (error) {
        console.error('Coupon analytics error:', error);
        res.status(500).json({ msg: 'Failed to fetch coupon analytics.' });
    }
};

// ─── Get public coupons for a product ───
exports.getProductCoupons = async (req, res) => {
    try {
        const { productId } = req.params;
        if (!isObjectId(productId)) {
            return res.status(400).json({ coupons: [], msg: 'Invalid product id.' });
        }

        const product = await Product.findOne(publicProductFilter({ _id: productId })).select('seller');
        if (!product) return res.status(404).json({ msg: 'Product not found.' });

        const now = new Date();
        const coupons = await Coupon.find({
            seller: product.seller,
            isActive: true,
            startDate: { $lte: now },
            expiryDate: { $gte: now },
            $or: [
                { applicableTo: 'all' },
                { applicableTo: 'selected', applicableProducts: productId }
            ]
        }).select('code discountType discountValue currency applicableTo description expiryDate minOrderAmount maxDiscountAmount maxUses usedCount');

        const validCoupons = coupons
            .filter(c => c.maxUses === null || c.usedCount < c.maxUses)
            .map(stripInternalCouponFields);

        res.json({ coupons: validCoupons });
    } catch (error) {
        console.error('Get product coupons error:', error);
        res.status(500).json({ msg: 'Failed to fetch coupons.' });
    }
};

// ─── Get public coupons for a store ───
exports.getStoreCoupons = async (req, res) => {
    try {
        const { sellerId } = req.params;
        const resolvedSellerId = await resolveSellerIdForStoreCoupons(sellerId);
        if (!resolvedSellerId) return res.json({ coupons: [] });

        const now = new Date();
        const coupons = await Coupon.find({
            seller: resolvedSellerId,
            isActive: true,
            startDate: { $lte: now },
            expiryDate: { $gte: now },
        })
            .populate('applicableProducts', 'name image')
            .select('code discountType discountValue currency applicableTo applicableProducts description expiryDate minOrderAmount maxDiscountAmount maxUses usedCount');

        const validCoupons = coupons
            .filter(c => c.maxUses === null || c.usedCount < c.maxUses)
            .map(stripInternalCouponFields);

        res.json({ coupons: validCoupons });
    } catch (error) {
        console.error('Get store coupons error:', error);
        res.status(500).json({ msg: 'Failed to fetch coupons.' });
    }
};

// ─── Record coupon usage (called after order is placed) ───
exports.recordCouponUsage = async (couponId, userId) => {
    try {
        const coupon = await Coupon.findById(couponId);
        if (!coupon) return;

        coupon.usedCount += 1;

        const existingUser = coupon.usedBy.find(u => u.user.toString() === userId);
        if (existingUser) {
            existingUser.count += 1;
        } else {
            coupon.usedBy.push({ user: userId, count: 1 });
        }

        await coupon.save();
    } catch (error) {
        console.error('Record coupon usage error:', error);
    }
};
