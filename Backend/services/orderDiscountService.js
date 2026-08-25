'use strict';

const toId = value => value?._id?.toString?.() || value?.toString?.() || '';
const {
    allocateMinorUnitsByWeights,
    fromMinorUnits,
    percentageOfMoney,
    roundMoney,
    sumMoney,
    toMinorUnits,
} = require('./moneyMath');
const { getOrderItemLineSubtotal } = require('./orderLinePricingService');
const { isSupportedCurrency, normalizeCurrency } = require('./currencyService');

const discountDataError = message => {
    const error = new Error(message);
    error.statusCode = 409;
    error.code = 'ORDER_COUPON_ALLOCATION_INVALID';
    return error;
};

const requireExactDiscountMoney = (value, label) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw discountDataError(`The stored ${label} is invalid.`);
    }
    try {
        if (roundMoney(value) !== value) throw discountDataError(`The stored ${label} is not exact to cents.`);
    } catch (error) {
        if (error?.code === 'ORDER_COUPON_ALLOCATION_INVALID') throw error;
        throw discountDataError(`The stored ${label} is outside the supported money range.`);
    }
    return value;
};

const assertReservedCouponAllocations = (order, totalDiscount) => {
    const usageVersion = order?.couponUsageVersion;
    if (usageVersion === null || usageVersion === undefined || usageVersion === 0) return;
    if (typeof usageVersion !== 'number' || usageVersion !== 1) {
        throw discountDataError('The reserved coupon version is invalid.');
    }
    const coupons = order?.appliedCoupons;
    const rawOrderCurrency = order?.currency;
    const orderCurrency = typeof rawOrderCurrency === 'string'
        && rawOrderCurrency === rawOrderCurrency.trim()
        && isSupportedCurrency(rawOrderCurrency)
        && rawOrderCurrency === normalizeCurrency(rawOrderCurrency)
        ? rawOrderCurrency
        : null;
    const orderProductIds = new Set((order?.orderItems || []).map(item => toId(item?.productId)).filter(Boolean));
    const sellersByProduct = new Map();
    (order?.orderItems || []).forEach(item => {
        const productId = toId(item?.productId);
        if (!productId) return;
        if (!sellersByProduct.has(productId)) sellersByProduct.set(productId, new Set());
        const sellerId = toId(item?.seller);
        if (sellerId) sellersByProduct.get(productId).add(sellerId);
    });
    if (!Array.isArray(coupons) || !orderCurrency) {
        throw discountDataError('The reserved coupon allocation is missing.');
    }

    const seenCoupons = new Set();
    const claimedProducts = new Set();
    let appliedMinor = 0;
    coupons.forEach(coupon => {
        const couponId = toId(coupon?.couponId);
        const couponSeller = toId(coupon?.seller);
        const productIds = Array.isArray(coupon?.applicableProductIds)
            ? coupon.applicableProductIds.map(toId).filter(Boolean)
            : [];
        const rawCouponCurrency = coupon?.currency;
        const couponCurrencyIsCanonical = typeof rawCouponCurrency === 'string'
            && rawCouponCurrency === rawCouponCurrency.trim()
            && isSupportedCurrency(rawCouponCurrency)
            && rawCouponCurrency === normalizeCurrency(rawCouponCurrency);
        if (
            !couponId
            || !couponSeller
            || seenCoupons.has(couponId)
            || !['percentage', 'fixed'].includes(coupon?.discountType)
            || !couponCurrencyIsCanonical
            || rawCouponCurrency !== orderCurrency
            || productIds.length === 0
            || new Set(productIds).size !== productIds.length
            || productIds.some(productId => {
                const productSellers = sellersByProduct.get(productId);
                return !orderProductIds.has(productId)
                    || claimedProducts.has(productId)
                    || !productSellers
                    || productSellers.size !== 1
                    || !productSellers.has(couponSeller);
            })
        ) {
            throw discountDataError('The reserved coupon scope is invalid.');
        }
        const amount = requireExactDiscountMoney(coupon?.appliedDiscountAmount, 'reserved coupon amount');
        const amountMinor = toMinorUnits(amount);
        if (amountMinor <= 0 || !Number.isSafeInteger(appliedMinor + amountMinor)) {
            throw discountDataError('The reserved coupon amount is invalid.');
        }
        appliedMinor += amountMinor;
        seenCoupons.add(couponId);
        productIds.forEach(productId => claimedProducts.add(productId));
    });
    if (appliedMinor !== toMinorUnits(totalDiscount)) {
        throw discountDataError('Reserved coupon amounts do not reconcile with the order discount.');
    }
};

const buildItemKeys = (items = []) => {
    const idCounts = new Map();
    items.forEach(item => {
        const id = toId(item?._id);
        if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1);
    });
    const used = new Set();
    return items.map((item, index) => {
        const id = toId(item?._id);
        let key = id && idCounts.get(id) === 1 ? id : `__item:${index}:${id}`;
        while (used.has(key)) key = `${key}:duplicate`;
        used.add(key);
        return key;
    });
};

const allocateRoundedByWeight = (amount, entries = []) => {
    const exactAmount = requireExactDiscountMoney(amount, 'discount allocation amount');
    const minorAllocations = allocateMinorUnitsByWeights(
        toMinorUnits(exactAmount),
        entries,
    );
    return new Map([...minorAllocations].map(([key, minor]) => [key, fromMinorUnits(minor)]));
};

const buildOrderItemDiscountAllocations = (order, { itemKeys: suppliedItemKeys } = {}) => {
    const rawTotalDiscount = order?.orderSummary?.couponDiscount;
    const totalDiscount = rawTotalDiscount === null || rawTotalDiscount === undefined
        ? 0
        : requireExactDiscountMoney(rawTotalDiscount, 'order coupon discount');
    const items = order?.orderItems || [];
    assertReservedCouponAllocations(order, totalDiscount);
    const itemKeys = suppliedItemKeys?.length === items.length
        ? suppliedItemKeys
        : buildItemKeys(items);
    const allocations = new Map(itemKeys.map(key => [key, 0]));
    if (totalDiscount <= 0 || allocations.size === 0) return allocations;

    const orderItems = items.map((item, index) => ({
        item,
        key: itemKeys[index],
        productId: toId(item.productId),
        subtotal: getOrderItemLineSubtotal(item),
    }));
    const couponAllocations = [];
    const orderProductIds = new Set(orderItems.map(entry => entry.productId).filter(Boolean));

    for (const coupon of order.appliedCoupons || []) {
        const applicableIds = new Set((coupon.applicableProductIds || []).map(toId).filter(Boolean));
        if ([...applicableIds].some(productId => !orderProductIds.has(productId))) {
            throw discountDataError('A stored coupon references a product outside the order.');
        }
        const eligibleItems = applicableIds.size
            ? orderItems.filter(item => applicableIds.has(item.productId))
            : orderItems;
        const eligibleSubtotal = sumMoney(eligibleItems.map(item => item.subtotal));
        if (eligibleSubtotal <= 0) {
            throw discountDataError('A stored coupon has no positive eligible order subtotal.');
        }

        const storedAppliedAmount = coupon.appliedDiscountAmount;
        const rawAmount = storedAppliedAmount !== null && storedAppliedAmount !== undefined
            ? requireExactDiscountMoney(storedAppliedAmount, 'applied coupon amount')
            : coupon.discountType === 'percentage'
                ? (() => {
                    if (
                        typeof coupon.discountValue !== 'number'
                        || !Number.isFinite(coupon.discountValue)
                        || coupon.discountValue < 0
                        || coupon.discountValue > 100
                    ) throw discountDataError('The stored percentage coupon is invalid.');
                    return percentageOfMoney(eligibleSubtotal, coupon.discountValue);
                })()
                : coupon.discountType === 'fixed'
                    ? requireExactDiscountMoney(coupon.discountValue, 'legacy fixed coupon amount')
                    : (() => { throw discountDataError('The stored coupon type is invalid.'); })();
        if (rawAmount > 0) couponAllocations.push({ eligibleItems, eligibleSubtotal, rawAmount });
    }

    if (couponAllocations.length === 0) {
        if ((order.appliedCoupons || []).length > 0) {
            throw discountDataError('Stored coupon allocations do not explain the order discount.');
        }
        return allocateRoundedByWeight(
            totalDiscount,
            orderItems.map(item => ({ key: item.key, weight: item.subtotal }))
        );
    }

    // First conserve the stored order discount across coupons, then conserve
    // each coupon inside only its own eligible lines. This prevents one
    // coupon's rounding cent from crossing a seller/product scope boundary.
    const couponAmounts = allocateRoundedByWeight(
        totalDiscount,
        couponAllocations.map((coupon, index) => ({ key: `coupon:${index}`, weight: coupon.rawAmount }))
    );
    couponAllocations.forEach((coupon, index) => {
        const itemAmounts = allocateRoundedByWeight(
            couponAmounts.get(`coupon:${index}`) || 0,
            coupon.eligibleItems.map(item => ({ key: item.key, weight: item.subtotal }))
        );
        itemAmounts.forEach((amount, key) => {
            allocations.set(key, roundMoney((allocations.get(key) || 0) + amount));
        });
    });
    return allocations;
};

const discountForOrderItems = (order, items = []) => {
    const orderItems = order?.orderItems || [];
    const itemKeys = buildItemKeys(orderItems);
    const allocations = buildOrderItemDiscountAllocations(order, { itemKeys });
    const keyByItem = new Map(orderItems.map((item, index) => [item, itemKeys[index]]));
    return roundMoney(items.reduce((sum, item) => {
        let key = keyByItem.get(item);
        if (!key) {
            const id = toId(item?._id);
            const matchingIndexes = orderItems
                .map((candidate, index) => toId(candidate?._id) === id ? index : -1)
                .filter(index => index >= 0);
            if (id && matchingIndexes.length === 1) key = itemKeys[matchingIndexes[0]];
        }
        return sum + (allocations.get(key) || 0);
    }, 0));
};

module.exports = {
    buildOrderItemDiscountAllocations,
    discountForOrderItems,
};
