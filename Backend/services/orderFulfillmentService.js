const Product = require('../models/Product');

const toId = value => value?._id?.toString?.() || value?.toString?.() || '';

const STATUS_RANK = Object.freeze({
    pending: 0,
    confirmed: 1,
    processing: 2,
    shipped: 3,
    delivered: 4,
});

const getSellerFulfillment = (order, sellerId) =>
    (order?.sellerFulfillment || []).find(entry => toId(entry.seller) === toId(sellerId));

const aggregateOrderStatus = (order) => {
    const entries = order?.sellerFulfillment || [];
    if (!entries.length) return order?.orderStatus || 'pending';

    const active = entries.filter(entry => entry.status !== 'cancelled');
    if (!active.length) return 'cancelled';
    if (active.every(entry => entry.status === 'delivered')) return 'delivered';

    return active.reduce((lowest, entry) => (
        (STATUS_RANK[entry.status] ?? 0) < (STATUS_RANK[lowest] ?? 0)
            ? entry.status
            : lowest
    ), active[0].status || 'pending');
};

const syncAggregateDeliveryState = (order) => {
    order.orderStatus = aggregateOrderStatus(order);
    const active = (order.sellerFulfillment || []).filter(entry => entry.status !== 'cancelled');
    const allDelivered = active.length > 0 && active.every(entry => entry.status === 'delivered');
    order.isDelivered = allDelivered;

    if (allDelivered && !order.deliveredAt) {
        const deliveredTimes = active
            .map(entry => entry.deliveredAt ? new Date(entry.deliveredAt).getTime() : 0)
            .filter(Boolean);
        order.deliveredAt = deliveredTimes.length
            ? new Date(Math.max(...deliveredTimes))
            : new Date();
    }

    return order.orderStatus;
};

const ensureOrderSellerFulfillment = async (order) => {
    const sellerIds = new Set((order.orderItems || []).map(item => toId(item.seller)).filter(Boolean));
    const missingProductIds = (order.orderItems || [])
        .filter(item => !item.seller && item.productId)
        .map(item => item.productId);

    if (missingProductIds.length) {
        const products = await Product.find({ _id: { $in: missingProductIds } }).select('seller').lean();
        products.forEach(product => {
            if (product.seller) sellerIds.add(toId(product.seller));
        });
    }

    for (const sellerId of sellerIds) {
        if (!getSellerFulfillment(order, sellerId)) {
            order.sellerFulfillment.push({
                seller: sellerId,
                status: order.orderStatus || 'pending',
                deliveredAt: order.orderStatus === 'delivered'
                    ? (order.deliveredAt || order.updatedAt || new Date())
                    : null,
                updatedAt: new Date(),
            });
        }
    }

    return [...sellerIds];
};

const setSellerFulfillmentStatus = (order, sellerId, status, at = new Date()) => {
    const fulfillment = getSellerFulfillment(order, sellerId);
    if (!fulfillment) return null;

    fulfillment.status = status;
    fulfillment.updatedAt = at;
    if (status === 'delivered' && !fulfillment.deliveredAt) fulfillment.deliveredAt = at;
    return fulfillment;
};

const setAllSellerFulfillmentStatus = (order, status, at = new Date()) => {
    for (const fulfillment of order.sellerFulfillment || []) {
        fulfillment.status = status;
        fulfillment.updatedAt = at;
        if (status === 'delivered' && !fulfillment.deliveredAt) fulfillment.deliveredAt = at;
    }
};

const getBuyerCancellationBlock = (order) => {
    const statuses = [
        order?.orderStatus,
        ...(order?.sellerFulfillment || []).map(entry => entry.status),
    ];
    if (statuses.some(status => ['shipped', 'delivered'].includes(status))) {
        return {
            code: 'ORDER_FULFILLMENT_STARTED',
            message: 'This order has already shipped or been delivered. Use the return request flow for eligible delivered items.',
        };
    }
    if (order?.isPaid) {
        return {
            code: 'PAID_ORDER_REQUIRES_REFUND',
            message: 'Paid orders cannot be cancelled without a verified refund. Contact support before shipment, or request a return after delivery if eligible.',
        };
    }
    return null;
};

module.exports = {
    aggregateOrderStatus,
    ensureOrderSellerFulfillment,
    getBuyerCancellationBlock,
    getSellerFulfillment,
    sellerFulfillmentFor: getSellerFulfillment,
    setAllSellerFulfillmentStatus,
    setSellerFulfillmentStatus,
    syncAggregateDeliveryState,
};
