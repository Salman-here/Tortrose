const Coupon = require('../models/Coupon');
const { deleteCouponIfUnreserved } = require('../services/couponUsageService');
const Product = require('../models/Product');
const Store = require('../models/Store');
const User = require('../models/User');
const mongoose = require('mongoose');
const { publicProductFilter } = require('../services/productModerationService');
const {
    convertAmountUsingTrustedRates,
    getExchangeRateSnapshot,
    isSupportedCurrency,
    normalizeCurrency,
} = require('../services/currencyService');
const {
    resolveRequestedCurrency,
    allocateRoundedAmount,
    buildOrderItemKeys,
    isSellerRevenueRecognized,
    lineTotal,
    roundMoney,
    sumCurrencyAmountsInCurrency,
    toId,
    itemBelongsToSeller,
    requireStoredOrderMoney,
} = require('../services/orderMoneyService');
const { getOrderItemSourceLineSubtotal } = require('../services/orderLinePricingService');
const { sumMoney } = require('../services/moneyMath');
const {
    assertStoredCouponMoneyTerms,
    assertStoredCouponTerms,
    requireSupportedCheckoutCurrency,
} = require('../services/checkoutPricingService');
const { getActiveSellerIds } = require('../services/publicCatalogService');
const {
    parsePositiveSafeInteger,
    parseStrictFiniteNumber,
} = require('../services/numericInputService');
const {
    assertProductCreationAllowed,
} = require('../services/storeProductCurrencyService');

const isObjectId = (value) => (
    typeof value === 'string' &&
    mongoose.Types.ObjectId.isValid(value) &&
    String(new mongoose.Types.ObjectId(value)) === value.toLowerCase()
);

const isMissingIdentifier = (value) => {
    const normalized = String(value || '').trim();
    return !normalized || ['undefined', 'null', '[object Object]'].includes(normalized);
};
const storedCouponCurrency = coupon => requireSupportedCheckoutCurrency(
    coupon?.currency,
    'USD',
    'COUPON_CURRENCY_NOT_SUPPORTED',
    { requireCanonical: true, statusCode: 409 },
);
const couponMoneyIsSafeForPresentation = coupon => {
    try {
        assertStoredCouponMoneyTerms(coupon);
        return true;
    } catch (_) {
        return false;
    }
};
const stripInternalCouponFields = (coupon) => {
    const obj = coupon.toObject ? coupon.toObject() : { ...coupon };
    assertStoredCouponMoneyTerms(obj);
    obj.currency = storedCouponCurrency(obj);
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

const couponUserUsageCount = (coupon, userId) => (coupon.usedBy || [])
    .filter(entry => toId(entry.user) === toId(userId))
    .reduce((total, entry) => total + Math.max(0, Number(entry.count || 0)), 0);

const couponAvailabilityError = (coupon, userId, now = new Date()) => {
    if (!coupon.isActive) return 'This coupon is no longer active.';
    if (now < new Date(coupon.startDate)) return 'This coupon is not yet valid.';
    if (now > new Date(coupon.expiryDate)) return 'This coupon has expired.';
    if (coupon.maxUses !== null && Number(coupon.usedCount || 0) >= Number(coupon.maxUses)) {
        return 'This coupon has reached its usage limit.';
    }
    if (couponUserUsageCount(coupon, userId) >= Number(coupon.maxUsesPerUser || 1)) {
        return 'You have already used this coupon the maximum number of times.';
    }
    return null;
};

const hasInvalidNumericShape = value => (
    typeof value === 'boolean'
    || (typeof value === 'string' && !value.trim())
);

const parseOptionalPositiveNumber = (value, field, { allowNull = true, integer = false } = {}) => {
    if (value === undefined || value === null) {
        if (allowNull) return { value: null };
        return { error: `${field} is required.` };
    }
    if (hasInvalidNumericShape(value)) return { error: `${field} must be greater than 0.` };
    const number = integer ? parsePositiveSafeInteger(value) : parseStrictFiniteNumber(value);
    if (number === null || number <= 0) return { error: `${field} must be greater than 0.` };
    return { value: number };
};

const parseOptionalNonNegativeNumber = (value, field, fallback = 0) => {
    if (value === undefined || value === null) return { value: fallback };
    if (hasInvalidNumericShape(value)) return { error: `${field} must be zero or higher.` };
    const number = parseStrictFiniteNumber(value);
    if (number === null || number < 0) return { error: `${field} must be zero or higher.` };
    return { value: number };
};

const roundCouponMoney = (value, field = 'Coupon amount') => {
    try {
        return roundMoney(value);
    } catch (error) {
        // Inputs reach this helper only after strict finite-number parsing. At
        // very large magnitudes JavaScript renders that otherwise-finite number
        // in exponent notation, which the exact decimal parser deliberately
        // rejects as MONEY_AMOUNT_INVALID. Both outcomes mean the requested
        // amount cannot be stored losslessly and are client validation errors.
        if (['MONEY_AMOUNT_INVALID', 'MONEY_AMOUNT_OUT_OF_RANGE'].includes(error?.code)) {
            error.message = `${field} is too large.`;
            error.statusCode = 400;
            error.code = 'COUPON_MONEY_AMOUNT_OUT_OF_RANGE';
        }
        throw error;
    }
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

const convertCouponWriteAmounts = async ({
    entries,
    targetCurrency,
    tooSmallMessage = 'A coupon amount is too small to represent in the store currency.',
}) => {
    const conversions = entries.filter(entry => (
        entry.value > 0 && entry.sourceCurrency !== targetCurrency
    ));
    if (!conversions.length) return Object.fromEntries(entries.map(entry => [entry.field, entry.value]));

    // Every term in one coupon write uses the same trusted FX snapshot. This
    // prevents a fixed discount, minimum, and cap from being saved from
    // different live rate tables during the same request.
    const exchangeRateSnapshot = await getExchangeRateSnapshot();
    const converted = Object.fromEntries(entries.map(entry => [entry.field, entry.value]));
    for (const entry of conversions) {
        const value = await convertAmountUsingTrustedRates(
            entry.value,
            entry.sourceCurrency,
            targetCurrency,
            exchangeRateSnapshot,
        );
        if (entry.value > 0 && value <= 0) {
            const error = new Error(tooSmallMessage);
            error.statusCode = 400;
            error.code = 'COUPON_AMOUNT_TOO_SMALL_AFTER_CONVERSION';
            throw error;
        }
        converted[entry.field] = value;
    }
    return converted;
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
        if (discountType === 'percentage' && (parsedDiscount.value < 0.01 || parsedDiscount.value > 100)) {
            return res.status(400).json({ msg: 'Percentage discount must be between 0.01 and 100.' });
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
        if (req.body.currency !== undefined && !isSupportedCurrency(req.body.currency)) {
            return res.status(400).json({ msg: 'Coupon currency must be USD, PKR, EUR, or GBP.' });
        }
        const productCurrencyState = await assertProductCreationAllowed(sellerId);
        const couponCurrency = productCurrencyState.activeCurrency;
        const inputCurrency = req.body.currency === undefined
            ? couponCurrency
            : normalizeCurrency(req.body.currency);

        const parsedMaxUses = parseOptionalPositiveNumber(maxUses, 'Max uses', { integer: true });
        const parsedMaxUsesPerUser = parseOptionalPositiveNumber(maxUsesPerUser ?? 1, 'Max uses per user', { allowNull: false, integer: true });
        const parsedMinOrderAmount = parseOptionalNonNegativeNumber(minOrderAmount, 'Minimum order amount', 0);
        const parsedMaxDiscountAmount = parseOptionalPositiveNumber(maxDiscountAmount ?? req.body.maxDiscount, 'Maximum discount amount');
        for (const parsed of [parsedMaxUses, parsedMaxUsesPerUser, parsedMinOrderAmount, parsedMaxDiscountAmount]) {
            if (parsed.error) return res.status(400).json({ msg: parsed.error });
        }
        let storedDiscountValue = discountType === 'fixed'
            ? roundCouponMoney(parsedDiscount.value, 'Discount value')
            : parsedDiscount.value;
        let storedMaxDiscountAmount = parsedMaxDiscountAmount.value == null
            ? null
            : roundCouponMoney(parsedMaxDiscountAmount.value, 'Maximum discount amount');
        let storedMinOrderAmount = roundCouponMoney(
            parsedMinOrderAmount.value,
            'Minimum order amount',
        );
        if (storedDiscountValue <= 0 || (storedMaxDiscountAmount !== null && storedMaxDiscountAmount <= 0)) {
            return res.status(400).json({ msg: 'Coupon money amounts must be at least 0.01.' });
        }
        if (parsedMinOrderAmount.value > 0 && storedMinOrderAmount <= 0) {
            return res.status(400).json({
                msg: 'Minimum order amount must be zero or large enough to represent at least 0.01.',
            });
        }

        const convertedMoney = await convertCouponWriteAmounts({
            entries: [
                ...(discountType === 'fixed' ? [{
                    field: 'discountValue',
                    value: storedDiscountValue,
                    sourceCurrency: inputCurrency,
                }] : []),
                {
                    field: 'minOrderAmount',
                    value: storedMinOrderAmount,
                    sourceCurrency: inputCurrency,
                },
                ...(storedMaxDiscountAmount === null ? [] : [{
                    field: 'maxDiscountAmount',
                    value: storedMaxDiscountAmount,
                    sourceCurrency: inputCurrency,
                }]),
            ],
            targetCurrency: couponCurrency,
            tooSmallMessage: 'A coupon amount is too small to represent in your store product currency.',
        });
        if (discountType === 'fixed') storedDiscountValue = convertedMoney.discountValue;
        storedMinOrderAmount = convertedMoney.minOrderAmount;
        if (storedMaxDiscountAmount !== null) storedMaxDiscountAmount = convertedMoney.maxDiscountAmount;

        const coupon = await Coupon.create({
            seller: sellerId,
            code: normalizedCode,
            discountType,
            discountValue: storedDiscountValue,
            currency: couponCurrency,
            applicableTo: couponScope,
            applicableProducts: selectedProducts.productIds,
            maxUses: parsedMaxUses.value,
            maxUsesPerUser: parsedMaxUsesPerUser.value,
            minOrderAmount: storedMinOrderAmount,
            maxDiscountAmount: storedMaxDiscountAmount,
            startDate: startsAt,
            expiryDate: expiresAt,
            description: description || '',
        });

        res.status(201).json({ msg: 'Coupon created successfully!', coupon });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ msg: 'You already have a coupon with this code.' });
        }
        const statusCode = error.statusCode || error.status;
        if (!statusCode) console.error('Create coupon error:', error);
        res.status(statusCode || 500).json({
            msg: statusCode ? error.message : 'Failed to create coupon.',
            ...(error.code ? { code: error.code } : {}),
        });
    }
};

// ─── Get seller's coupons ───
exports.getSellerCoupons = async (req, res) => {
    try {
        const sellerId = req.user.id;
        const coupons = await Coupon.find({ seller: sellerId })
            .populate('applicableProducts', 'name image price currency priceCurrency')
            .sort({ createdAt: -1 });
        coupons.forEach(assertStoredCouponTerms);

        res.json({ coupons });
    } catch (error) {
        if (!error.statusCode) console.error('Get coupons error:', error);
        res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : 'Failed to fetch coupons.',
            ...(error.code ? { code: error.code } : {}),
        });
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

        // Updates must not reinterpret corrupt persisted money, but older
        // coupons can legitimately be missing newer non-money metadata. The
        // complete coupon contract is still enforced at checkout/listing.
        assertStoredCouponMoneyTerms(coupon);
        const originalCurrency = storedCouponCurrency(coupon);
        const originalDiscountType = coupon.discountType;
        const originalMoney = {
            discountValue: coupon.discountValue,
            minOrderAmount: coupon.minOrderAmount,
            maxDiscountAmount: coupon.maxDiscountAmount,
        };

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
            if (updates.discountType !== originalDiscountType && updates.discountValue === undefined) {
                return res.status(400).json({
                    msg: 'Provide a new discount value when changing the discount type.',
                });
            }
            coupon.discountType = updates.discountType;
        }

        if (updates.discountValue !== undefined) {
            const parsedDiscount = parseOptionalPositiveNumber(updates.discountValue, 'Discount value', { allowNull: false });
            if (parsedDiscount.error) return res.status(400).json({ msg: parsedDiscount.error });
            coupon.discountValue = coupon.discountType === 'fixed'
                ? roundCouponMoney(parsedDiscount.value, 'Discount value')
                : parsedDiscount.value;
            if (coupon.discountValue <= 0) {
                return res.status(400).json({ msg: 'Coupon money amounts must be at least 0.01.' });
            }
        }
        if (updates.currency !== undefined) {
            if (!isSupportedCurrency(updates.currency)) {
                return res.status(400).json({ msg: 'Coupon currency must be USD, PKR, EUR, or GBP.' });
            }
            coupon.currency = normalizeCurrency(updates.currency);
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
            const storedMinOrderAmount = roundCouponMoney(parsed.value, 'Minimum order amount');
            if (parsed.value > 0 && storedMinOrderAmount <= 0) {
                return res.status(400).json({
                    msg: 'Minimum order amount must be zero or large enough to represent at least 0.01.',
                });
            }
            coupon.minOrderAmount = storedMinOrderAmount;
        }

        if (updates.maxDiscountAmount !== undefined) {
            const parsed = parseOptionalPositiveNumber(updates.maxDiscountAmount, 'Maximum discount amount');
            if (parsed.error) return res.status(400).json({ msg: parsed.error });
            coupon.maxDiscountAmount = parsed.value == null
                ? null
                : roundCouponMoney(parsed.value, 'Maximum discount amount');
            if (coupon.maxDiscountAmount !== null && coupon.maxDiscountAmount <= 0) {
                return res.status(400).json({ msg: 'Coupon money amounts must be at least 0.01.' });
            }
        }

        const targetCurrency = storedCouponCurrency(coupon);
        if (targetCurrency !== originalCurrency) {
            const productCurrencyState = await assertProductCreationAllowed(sellerId);
            if (targetCurrency !== productCurrencyState.activeCurrency) {
                return res.status(409).json({
                    msg: `Coupon currency can only be converted to your active store product currency (${productCurrencyState.activeCurrency}).`,
                    code: 'COUPON_CURRENCY_STORE_MISMATCH',
                });
            }
            const retainedMoney = [];
            if (
                coupon.discountType === 'fixed'
                && originalDiscountType === 'fixed'
                && updates.discountValue === undefined
            ) {
                retainedMoney.push(['discountValue', originalMoney.discountValue]);
            }
            if (updates.minOrderAmount === undefined) {
                retainedMoney.push(['minOrderAmount', originalMoney.minOrderAmount]);
            }
            if (updates.maxDiscountAmount === undefined && originalMoney.maxDiscountAmount != null) {
                retainedMoney.push(['maxDiscountAmount', originalMoney.maxDiscountAmount]);
            }

            const convertedMoney = await convertCouponWriteAmounts({
                entries: retainedMoney.map(([field, value]) => ({
                    field,
                    value,
                    sourceCurrency: originalCurrency,
                })),
                targetCurrency,
                tooSmallMessage: 'A retained coupon amount is too small to represent in the new currency. Provide the amount explicitly.',
            });
            for (const [field] of retainedMoney) {
                coupon[field] = convertedMoney[field];
            }
        }

        if (coupon.discountType === 'fixed') {
            coupon.discountValue = roundCouponMoney(coupon.discountValue, 'Discount value');
            if (coupon.discountValue <= 0) {
                return res.status(400).json({ msg: 'Coupon money amounts must be at least 0.01.' });
            }
        }
        if (coupon.discountType === 'percentage' && (coupon.discountValue < 0.01 || coupon.discountValue > 100)) {
            return res.status(400).json({ msg: 'Percentage discount must be between 0.01 and 100.' });
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
        if (error.name === 'VersionError') {
            return res.status(409).json({
                msg: 'This coupon changed while your update was being saved. Refresh it and retry.',
                code: 'COUPON_UPDATE_CONFLICT',
            });
        }
        const statusCode = error.statusCode || error.status;
        if (!statusCode) console.error('Update coupon error:', error);
        res.status(statusCode || 500).json({
            msg: statusCode ? error.message : 'Failed to update coupon.',
            ...(error.code ? { code: error.code } : {}),
        });
    }
};

// ─── Delete a coupon ───
exports.deleteCoupon = async (req, res) => {
    try {
        const sellerId = req.user.id;
        const { id } = req.params;

        const result = await deleteCouponIfUnreserved({ couponId: id, sellerId });
        if (!result.deleted) return res.status(404).json({ msg: 'Coupon not found.' });

        res.json({ msg: 'Coupon deleted successfully!' });
    } catch (error) {
        console.error('Delete coupon error:', error);
        res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : 'Failed to delete coupon.',
            ...(error.code ? { code: error.code } : {}),
        });
    }
};

// ─── Toggle coupon active/inactive ───
exports.toggleCoupon = async (req, res) => {
    try {
        const sellerId = req.user.id;
        const { id } = req.params;

        const coupon = await Coupon.findOne({ _id: id, seller: sellerId });
        if (!coupon) return res.status(404).json({ msg: 'Coupon not found.' });

        if (!coupon.isActive && new Date(coupon.expiryDate) <= new Date()) {
            return res.status(400).json({ msg: 'Expired coupons cannot be activated.' });
        }

        coupon.isActive = !coupon.isActive;
        await coupon.save();

        res.json({ msg: `Coupon ${coupon.isActive ? 'activated' : 'deactivated'}!`, coupon });
    } catch (error) {
        if (error.name === 'VersionError') {
            return res.status(409).json({
                msg: 'This coupon changed while its status was being saved. Refresh it and retry.',
                code: 'COUPON_UPDATE_CONFLICT',
            });
        }
        console.error('Toggle coupon error:', error);
        res.status(500).json({ msg: 'Failed to toggle coupon.' });
    }
};

// ─── Validate & apply coupon at checkout (called from frontend) ───
exports.validateCoupon = async (req, res) => {
    try {
        const userId = req.user.id;
        const { code, couponId, sellerId } = req.body;
        const productIds = normalizeProductIds(req.body.productIds);
        // productIds = array of product IDs the user is trying to apply this coupon to

        const normalizedCode = normalizeCouponCode(code);
        if (normalizedCode.length < 3 || normalizedCode.length > 32) {
            return res.status(400).json({ msg: 'Coupon code is required.' });
        }
        if (!Array.isArray(req.body.productIds) || req.body.productIds.some(id => !isObjectId(String(id || '').trim()))) {
            return res.status(400).json({ msg: 'Choose valid products before applying a coupon.' });
        }
        if (!productIds.length) return res.status(400).json({ msg: 'Choose at least one product before applying a coupon.' });
        if (couponId !== undefined && !isObjectId(String(couponId))) {
            return res.status(400).json({ msg: 'Invalid coupon id.' });
        }
        if (sellerId !== undefined && !isObjectId(String(sellerId))) {
            return res.status(400).json({ msg: 'Invalid coupon seller.' });
        }

        const couponFilter = { code: normalizedCode };
        if (couponId !== undefined) couponFilter._id = String(couponId);
        if (sellerId !== undefined) couponFilter.seller = String(sellerId);
        const coupons = await Coupon.find(couponFilter).populate('applicableProducts', '_id');
        if (!coupons.length) return res.status(404).json({ msg: 'Invalid coupon code.' });

        const selectedProducts = await Product.find(publicProductFilter({ _id: { $in: productIds } })).select('_id seller').lean();
        if (selectedProducts.length !== productIds.length) {
            return res.status(400).json({ msg: 'Some selected products are no longer available.' });
        }
        const productSeller = new Map(selectedProducts.map(product => [toId(product._id), toId(product.seller)]));
        const scopedCandidates = coupons.map((candidate) => {
            const candidateSellerId = toId(candidate.seller);
            const sellerProductIds = productIds.filter(productId => productSeller.get(productId) === candidateSellerId);
            const configuredProductIds = new Set((candidate.applicableProducts || []).map(product => toId(product._id || product)));
            const applicableProductIds = sellerProductIds.filter(productId => (
                candidate.applicableTo === 'all' || configuredProductIds.has(productId)
            ));
            return { coupon: candidate, applicableProductIds };
        }).filter(candidate => candidate.applicableProductIds.length > 0);

        if (!scopedCandidates.length) {
            return res.status(400).json({ msg: 'This coupon does not apply to any of your selected products.' });
        }
        scopedCandidates.forEach(({ coupon: candidate }) => assertStoredCouponTerms(candidate));

        const now = new Date();
        const eligibleCandidates = scopedCandidates.filter(candidate => !couponAvailabilityError(candidate.coupon, userId, now));
        if (!eligibleCandidates.length) {
            if (scopedCandidates.length === 1) {
                return res.status(400).json({ msg: couponAvailabilityError(scopedCandidates[0].coupon, userId, now) });
            }
            return res.status(400).json({ msg: 'No coupon with this code is currently eligible for your selected products.' });
        }
        if (eligibleCandidates.length > 1) {
            return res.status(409).json({
                msg: 'More than one seller in your cart uses this coupon code. Choose the coupon shown for a specific seller.',
                code: 'COUPON_AMBIGUOUS',
            });
        }

        const { coupon, applicableProductIds } = eligibleCandidates[0];

        res.json({
            valid: true,
            coupon: {
                _id: coupon._id,
                code: coupon.code,
                discountType: coupon.discountType,
                discountValue: coupon.discountValue,
                currency: storedCouponCurrency(coupon),
                applicableTo: coupon.applicableTo,
                applicableProductIds,
                minOrderAmount: coupon.minOrderAmount,
                maxDiscountAmount: coupon.maxDiscountAmount,
                seller: coupon.seller,
                description: coupon.description,
            },
        });
    } catch (error) {
        if (!error.statusCode) console.error('Validate coupon error:', error);
        res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : 'Failed to validate coupon.',
            ...(error.code ? { code: error.code } : {}),
        });
    }
};

// ─── Get available coupons for checkout (by seller IDs in cart) ───
exports.getCheckoutCoupons = async (req, res) => {
    try {
        const userId = req.user.id;
        const sellerIds = normalizeProductIds(req.body.sellerIds);
        const productIds = req.body.productIds === undefined ? [] : normalizeProductIds(req.body.productIds);
        if (!Array.isArray(req.body.sellerIds) || req.body.sellerIds.some(id => !isObjectId(String(id || '').trim()))) {
            return res.status(400).json({ msg: 'Choose valid sellers before loading coupons.' });
        }
        if (req.body.productIds !== undefined && (!Array.isArray(req.body.productIds) || req.body.productIds.some(id => !isObjectId(String(id || '').trim())))) {
            return res.status(400).json({ msg: 'Choose valid products before loading coupons.' });
        }
        if (sellerIds.length === 0) {
            return res.json({ sellerCoupons: {} });
        }

        const activeSellerSet = new Set((await getActiveSellerIds()).map(toId));
        const activeCartSellerIds = sellerIds.filter(sellerId => activeSellerSet.has(sellerId));
        if (!activeCartSellerIds.length) return res.json({ sellerCoupons: {} });

        const now = new Date();
        const coupons = await Coupon.find({
            seller: { $in: activeCartSellerIds },
            isActive: true,
            startDate: { $lte: now },
            expiryDate: { $gte: now },
        }).populate('applicableProducts', '_id name');

        let productSeller = null;
        if (productIds.length) {
            const selectedProducts = await Product.find(publicProductFilter({
                _id: { $in: productIds },
                seller: { $in: activeCartSellerIds },
            })).select('_id seller').lean();
            productSeller = new Map(selectedProducts.map(product => [toId(product._id), toId(product.seller)]));
        }

        // Do not advertise coupons that checkout will reject for global or
        // per-buyer usage, seller ownership, or selected-product scope.
        const validCoupons = coupons.filter((coupon) => {
            try {
                assertStoredCouponTerms(coupon);
            } catch (_) {
                return false;
            }
            if (couponAvailabilityError(coupon, userId, now)) return false;
            if (!productSeller) return true;
            const couponSellerId = toId(coupon.seller);
            const sellerProductIds = productIds.filter(productId => productSeller.get(productId) === couponSellerId);
            if (coupon.applicableTo === 'all') return sellerProductIds.length > 0;
            const configuredProductIds = new Set((coupon.applicableProducts || []).map(product => toId(product._id || product)));
            return sellerProductIds.some(productId => configuredProductIds.has(productId));
        });

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
                currency: storedCouponCurrency(c),
                applicableTo: c.applicableTo,
                applicableProducts: (c.applicableProducts || []).map(p => toId(p?._id || p)).filter(Boolean),
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
        coupons.forEach(assertStoredCouponTerms);

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
                if (!isSellerRevenueRecognized(order, sellerId)) continue;
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

                const orderItems = order.orderItems || [];
                const itemKeys = buildOrderItemKeys(orderItems);
                const applicableIndexes = orderItems
                    .map((item, index) => applicableProductIds.has(toId(item?.productId)) ? index : -1)
                    .filter(index => index >= 0);
                const sellerIndexes = applicableIndexes.filter(index => (
                    itemBelongsToSeller(orderItems[index], sellerId, sellerProductIdSet)
                ));
                if (!sellerIndexes.length) continue;

                const applicableSubtotal = sumMoney(
                    applicableIndexes.map(index => lineTotal(orderItems[index])),
                );
                const sellerSubtotal = sumMoney(
                    sellerIndexes.map(index => lineTotal(orderItems[index])),
                );
                if (sellerSubtotal <= 0) continue;

                // Attribute the persisted coupon amount by exact line-level
                // largest remainder. A coupon cent can never cross into an
                // ineligible product or another seller's line.
                const persistedDiscount = requireStoredOrderMoney(
                    appliedCoupon.appliedDiscountAmount,
                    'applied coupon discount',
                );
                if (persistedDiscount > applicableSubtotal) {
                    const error = new Error(
                        'A stored coupon discount exceeds its frozen eligible-product subtotal.',
                    );
                    error.statusCode = 409;
                    error.code = 'ORDER_COUPON_MONEY_INVALID';
                    throw error;
                }
                const discountAllocations = allocateRoundedAmount(
                    persistedDiscount,
                    applicableIndexes.map(index => ({
                        key: itemKeys[index],
                        weight: lineTotal(orderItems[index]),
                    })),
                );
                const sellerDiscount = sumMoney(
                    sellerIndexes.map(index => discountAllocations.get(itemKeys[index]) ?? 0),
                );

                const sellerSubtotalEntries = sellerIndexes.map(index => {
                    const item = orderItems[index];
                    return {
                        amount: getOrderItemSourceLineSubtotal(item) ?? lineTotal(item),
                        currency: item?.sourceCurrency || item?.priceCurrency || order.currency,
                    };
                });
                const hasNativeDiscount = appliedCoupon.sourceAppliedDiscountAmount !== null
                    && appliedCoupon.sourceAppliedDiscountAmount !== undefined;
                const sellerDiscountEntry = {
                    amount: hasNativeDiscount
                        ? requireStoredOrderMoney(
                            appliedCoupon.sourceAppliedDiscountAmount,
                            'source applied coupon discount',
                        )
                        : sellerDiscount,
                    currency: hasNativeDiscount
                        ? appliedCoupon.sourceCurrency
                        : order.currency,
                };
                attributedOrders.push({ order, sellerSubtotalEntries, sellerDiscountEntry });
            }

            const [totalRevenue, totalDiscount] = await Promise.all([
                sumCurrencyAmountsInCurrency(
                    attributedOrders.flatMap(({ sellerSubtotalEntries }) => sellerSubtotalEntries),
                    targetCurrency,
                ),
                sumCurrencyAmountsInCurrency(
                    attributedOrders.map(({ sellerDiscountEntry }) => sellerDiscountEntry),
                    targetCurrency,
                ),
            ]);

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
                currency: storedCouponCurrency(coupon),
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
        const totalRevenueFromCoupons = sumMoney(couponAnalytics.map(coupon => coupon.totalRevenue));
        const totalDiscountGiven = sumMoney(couponAnalytics.map(coupon => coupon.totalDiscount));
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
                totalRevenueFromCoupons,
                totalDiscountGiven,
                topCouponCode: topCoupon?.code || null,
            },
            moneyBasis: {
                attributedSales: 'recognized_eligible_product_subtotal_before_coupon_discount',
                discount: 'allocated_frozen_coupon_discount',
                excludes: ['shipping', 'tax'],
            },
        });
    } catch (error) {
        console.error('Coupon analytics error:', error);
        res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : 'Failed to fetch coupon analytics.',
            code: error.code,
        });
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
            .filter(c => couponMoneyIsSafeForPresentation(c) && (c.maxUses === null || c.usedCount < c.maxUses))
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
            .filter(c => couponMoneyIsSafeForPresentation(c) && (c.maxUses === null || c.usedCount < c.maxUses))
            .map(stripInternalCouponFields);

        res.json({ coupons: validCoupons });
    } catch (error) {
        console.error('Get store coupons error:', error);
        res.status(500).json({ msg: 'Failed to fetch coupons.' });
    }
};
