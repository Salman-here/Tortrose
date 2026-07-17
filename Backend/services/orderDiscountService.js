'use strict';

const toId = value => value?._id?.toString?.() || value?.toString?.() || '';
const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100;

const buildOrderItemDiscountAllocations = order => {
    const totalDiscount = roundMoney(order?.orderSummary?.couponDiscount || 0);
    const allocations = new Map((order?.orderItems || []).map(item => [toId(item._id), 0]));
    if (totalDiscount <= 0 || allocations.size === 0) return allocations;

    const orderItems = (order.orderItems || []).map(item => ({
        orderItemId: toId(item._id),
        productId: toId(item.productId),
        subtotal: Math.max(0, (Number(item.price) || 0) * (Number(item.quantity) || 0)),
    }));
    const couponAllocations = [];

    for (const coupon of order.appliedCoupons || []) {
        const applicableIds = new Set((coupon.applicableProductIds || []).map(toId).filter(Boolean));
        const eligibleItems = applicableIds.size
            ? orderItems.filter(item => applicableIds.has(item.productId))
            : orderItems;
        const eligibleSubtotal = eligibleItems.reduce((sum, item) => sum + item.subtotal, 0);
        if (eligibleSubtotal <= 0) continue;

        const storedAppliedAmount = coupon.appliedDiscountAmount;
        const rawAmount = storedAppliedAmount !== null && storedAppliedAmount !== undefined
            ? Math.max(0, Number(storedAppliedAmount) || 0)
            : coupon.discountType === 'percentage'
                ? eligibleSubtotal * Math.max(0, Number(coupon.discountValue) || 0) / 100
                : Math.max(0, Number(coupon.discountValue) || 0);
        if (rawAmount > 0) couponAllocations.push({ eligibleItems, eligibleSubtotal, rawAmount });
    }

    if (couponAllocations.length === 0) {
        const orderSubtotal = orderItems.reduce((sum, item) => sum + item.subtotal, 0);
        if (orderSubtotal <= 0) return allocations;
        for (const item of orderItems) {
            allocations.set(item.orderItemId, totalDiscount * item.subtotal / orderSubtotal);
        }
    } else {
        const rawTotal = couponAllocations.reduce((sum, coupon) => sum + coupon.rawAmount, 0);
        const scale = rawTotal > 0 ? totalDiscount / rawTotal : 0;
        for (const coupon of couponAllocations) {
            const allocatedCouponAmount = coupon.rawAmount * scale;
            for (const item of coupon.eligibleItems) {
                allocations.set(
                    item.orderItemId,
                    (allocations.get(item.orderItemId) || 0) + allocatedCouponAmount * item.subtotal / coupon.eligibleSubtotal
                );
            }
        }
    }

    for (const [key, amount] of allocations) allocations.set(key, roundMoney(amount));
    const allocatedTotal = roundMoney([...allocations.values()].reduce((sum, amount) => sum + amount, 0));
    const remainder = roundMoney(totalDiscount - allocatedTotal);
    if (remainder !== 0) {
        const allocatedItems = orderItems.filter(item => (allocations.get(item.orderItemId) || 0) > 0);
        const largestItem = [...(allocatedItems.length ? allocatedItems : orderItems)]
            .sort((a, b) => b.subtotal - a.subtotal)[0];
        if (largestItem) {
            allocations.set(largestItem.orderItemId, roundMoney((allocations.get(largestItem.orderItemId) || 0) + remainder));
        }
    }
    return allocations;
};

const discountForOrderItems = (order, items = []) => {
    const allocations = buildOrderItemDiscountAllocations(order);
    return roundMoney(items.reduce((sum, item) => sum + (allocations.get(toId(item._id)) || 0), 0));
};

module.exports = {
    buildOrderItemDiscountAllocations,
    discountForOrderItems,
};
