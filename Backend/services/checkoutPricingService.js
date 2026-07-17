'use strict';

const mongoose = require('mongoose');
const Coupon = require('../models/Coupon');
const ShippingMethod = require('../models/ShippingMethod');
const { normalizeCurrency, convertAmount } = require('./currencyService');

const toId = value => value?._id?.toString?.() || value?.toString?.() || '';
const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100;

const checkoutError = (message, code) => {
    const error = new Error(message);
    error.statusCode = 400;
    error.code = code;
    return error;
};

const lineSubtotal = item => roundMoney(
    Math.max(0, Number(item?.price) || 0) * Math.max(0, Number(item?.quantity) || 0)
);

const validateAndPriceCoupons = async ({
    requestedCoupons = [],
    orderItems = [],
    userId,
    orderCurrency,
    at = new Date(),
}) => {
    if (!Array.isArray(requestedCoupons) || requestedCoupons.length === 0) {
        return { appliedCoupons: [], couponDiscount: 0 };
    }
    if (!userId) {
        throw checkoutError('Log in before applying a coupon.', 'COUPON_LOGIN_REQUIRED');
    }

    const currency = normalizeCurrency(orderCurrency || 'USD');
    const requestedById = new Map();
    for (const requested of requestedCoupons) {
        const couponId = toId(requested?.couponId || requested?._id);
        if (!mongoose.isValidObjectId(couponId) || requestedById.has(couponId)) {
            throw checkoutError('Each coupon can be applied only once.', 'DUPLICATE_OR_INVALID_COUPON');
        }
        requestedById.set(couponId, requested);
    }

    const coupons = await Coupon.find({ _id: { $in: [...requestedById.keys()] } }).lean();
    if (coupons.length !== requestedById.size) {
        throw checkoutError('One or more coupons are no longer available.', 'COUPON_NOT_FOUND');
    }

    const orderItemsByProduct = new Map();
    for (const item of orderItems) {
        const productId = toId(item.productId);
        if (!productId) continue;
        if (!orderItemsByProduct.has(productId)) orderItemsByProduct.set(productId, []);
        orderItemsByProduct.get(productId).push(item);
    }

    const claimedProductIds = new Set();
    const appliedCoupons = [];
    let couponDiscount = 0;

    for (const coupon of coupons) {
        const couponId = toId(coupon._id);
        const requested = requestedById.get(couponId);
        const now = new Date(at);
        if (
            coupon.isActive !== true ||
            now < new Date(coupon.startDate) ||
            now > new Date(coupon.expiryDate)
        ) {
            throw checkoutError(`Coupon ${coupon.code} is no longer active.`, 'COUPON_NOT_ACTIVE');
        }
        if (coupon.maxUses !== null && coupon.maxUses !== undefined && Number(coupon.usedCount || 0) >= Number(coupon.maxUses)) {
            throw checkoutError(`Coupon ${coupon.code} has reached its usage limit.`, 'COUPON_USAGE_LIMIT');
        }
        const userUsage = (coupon.usedBy || []).find(entry => toId(entry.user) === toId(userId));
        if (userUsage && Number(userUsage.count || 0) >= Number(coupon.maxUsesPerUser || 1)) {
            throw checkoutError(`Coupon ${coupon.code} has already been used the maximum number of times.`, 'COUPON_USER_LIMIT');
        }

        const sellerId = toId(coupon.seller);
        const sellerProductIds = new Set(orderItems
            .filter(item => toId(item.seller) === sellerId)
            .map(item => toId(item.productId))
            .filter(Boolean));
        const configuredProductIds = new Set((coupon.applicableProducts || []).map(toId).filter(Boolean));
        const allowedProductIds = new Set([...sellerProductIds].filter(productId => (
            coupon.applicableTo === 'all' || configuredProductIds.has(productId)
        )));

        const requestedScope = [...new Set((requested?.applicableProductIds || []).map(toId).filter(Boolean))];
        const applicableProductIds = requestedScope.length ? requestedScope : [...allowedProductIds];
        if (!applicableProductIds.length || applicableProductIds.some(productId => !allowedProductIds.has(productId))) {
            throw checkoutError(`Coupon ${coupon.code} does not apply to the selected products.`, 'COUPON_SCOPE_INVALID');
        }
        if (applicableProductIds.some(productId => claimedProductIds.has(productId))) {
            throw checkoutError('Two coupons cannot discount the same product in one order.', 'OVERLAPPING_COUPONS');
        }

        const applicableSubtotal = roundMoney(applicableProductIds.reduce((sum, productId) => (
            sum + (orderItemsByProduct.get(productId) || []).reduce((lineSum, item) => lineSum + lineSubtotal(item), 0)
        ), 0));
        const couponCurrency = normalizeCurrency(coupon.currency || 'USD');
        const minimumAmount = Number(coupon.minOrderAmount || 0) > 0
            ? roundMoney(await convertAmount(coupon.minOrderAmount, couponCurrency, currency))
            : 0;
        if (applicableSubtotal + 0.0001 < minimumAmount) {
            throw checkoutError(`Coupon ${coupon.code} requires a higher eligible subtotal.`, 'COUPON_MINIMUM_NOT_MET');
        }

        let appliedDiscountAmount;
        let storedDiscountValue;
        if (coupon.discountType === 'percentage') {
            storedDiscountValue = Number(coupon.discountValue) || 0;
            appliedDiscountAmount = applicableSubtotal * storedDiscountValue / 100;
        } else {
            storedDiscountValue = roundMoney(await convertAmount(coupon.discountValue, couponCurrency, currency));
            appliedDiscountAmount = storedDiscountValue;
        }
        if (Number(coupon.maxDiscountAmount || 0) > 0) {
            const maximumAmount = roundMoney(await convertAmount(coupon.maxDiscountAmount, couponCurrency, currency));
            appliedDiscountAmount = Math.min(appliedDiscountAmount, maximumAmount);
        }
        appliedDiscountAmount = roundMoney(Math.min(applicableSubtotal, Math.max(0, appliedDiscountAmount)));
        if (appliedDiscountAmount <= 0) {
            throw checkoutError(`Coupon ${coupon.code} does not provide a valid discount for this order.`, 'COUPON_DISCOUNT_INVALID');
        }

        applicableProductIds.forEach(productId => claimedProductIds.add(productId));
        couponDiscount = roundMoney(couponDiscount + appliedDiscountAmount);
        appliedCoupons.push({
            couponId: coupon._id,
            code: coupon.code,
            discountType: coupon.discountType,
            discountValue: storedDiscountValue,
            appliedDiscountAmount,
            currency,
            sourceDiscountValue: Number(coupon.discountValue) || 0,
            sourceCurrency: couponCurrency,
            applicableProductIds,
        });
    }

    const subtotal = roundMoney(orderItems.reduce((sum, item) => sum + lineSubtotal(item), 0));
    return {
        appliedCoupons,
        couponDiscount: roundMoney(Math.min(subtotal, couponDiscount)),
    };
};

const validateAndPriceShipping = async ({
    requestedSellerShipping = [],
    fallbackShippingMethod = null,
    sellerIds = [],
    orderCurrency,
}) => {
    const currency = normalizeCurrency(orderCurrency || 'USD');
    const canonicalSellerIds = [...new Set(sellerIds.map(toId).filter(Boolean))];
    if (!canonicalSellerIds.length) {
        throw checkoutError('This order does not contain a valid seller.', 'ORDER_SELLER_MISSING');
    }

    const requestedBySeller = new Map();
    for (const entry of Array.isArray(requestedSellerShipping) ? requestedSellerShipping : []) {
        const sellerId = toId(entry?.seller);
        if (!sellerId || !canonicalSellerIds.includes(sellerId) || requestedBySeller.has(sellerId)) {
            throw checkoutError('Shipping selections do not match the sellers in this cart.', 'SHIPPING_SCOPE_INVALID');
        }
        requestedBySeller.set(sellerId, entry.shippingMethod || {});
    }
    if (requestedBySeller.size === 0 && canonicalSellerIds.length === 1 && fallbackShippingMethod) {
        requestedBySeller.set(canonicalSellerIds[0], fallbackShippingMethod);
    }

    const shippingDocuments = await ShippingMethod.find({ seller: { $in: canonicalSellerIds } }).lean();
    const shippingBySeller = new Map(shippingDocuments.map(document => [toId(document.seller), document]));
    const sellerShipping = [];

    for (const sellerId of canonicalSellerIds) {
        const requested = requestedBySeller.get(sellerId);
        if (!requested) {
            throw checkoutError('Select one shipping method for every seller.', 'SHIPPING_METHOD_REQUIRED');
        }
        const requestedType = String(requested.name || requested.type || '').trim().toLowerCase();
        const configured = shippingBySeller.get(sellerId);
        let method;
        if (configured) {
            method = (configured.methods || []).find(entry => entry.isActive !== false && entry.type === requestedType);
        } else if (requestedType === 'free') {
            method = { type: 'free', cost: 0, currency, deliveryDays: 5, isActive: true };
        }
        if (!method) {
            throw checkoutError('A selected shipping method is no longer available. Refresh checkout and choose again.', 'SHIPPING_METHOD_NOT_AVAILABLE');
        }

        const sourceCurrency = normalizeCurrency(method.currency || method.costCurrency || currency);
        const sourceCost = method.type === 'free' ? 0 : Math.max(0, Number(method.cost) || 0);
        const price = method.type === 'free'
            ? 0
            : roundMoney(await convertAmount(sourceCost, sourceCurrency, currency));
        const estimatedDays = Math.max(1, Math.trunc(Number(method.deliveryDays) || 1));
        sellerShipping.push({
            seller: sellerId,
            shippingMethod: {
                name: method.type,
                price,
                estimatedDays,
            },
        });
    }

    return {
        sellerShipping,
        primaryShipping: sellerShipping[0],
        shippingCost: roundMoney(sellerShipping.reduce((sum, entry) => sum + entry.shippingMethod.price, 0)),
    };
};

module.exports = {
    checkoutError,
    lineSubtotal,
    validateAndPriceCoupons,
    validateAndPriceShipping,
};
