'use strict';

const Order = require('../models/Order');
const Product = require('../models/Product');

const toId = (value) => value?._id?.toString?.() || value?.toString?.() || '';

const isWholeOrderDelivered = (order) =>
  order?.orderStatus === 'delivered' || order?.isDelivered === true;

const isSellerPortionDelivered = (order, sellerId) => {
  const normalizedSellerId = toId(sellerId);
  if (normalizedSellerId) {
    const fulfillment = (order?.sellerFulfillment || []).find(
      (entry) => toId(entry.seller) === normalizedSellerId
    );
    if (fulfillment) return fulfillment.status === 'delivered';
  }
  return isWholeOrderDelivered(order);
};

const qualifyingOrderResult = (orders, sellerId) => {
  const order = (orders || []).find((candidate) => isSellerPortionDelivered(candidate, sellerId));
  if (order) return { eligible: true, reason: 'eligible', order };
  if ((orders || []).length > 0) return { eligible: false, reason: 'order_not_delivered', order: null };
  return { eligible: false, reason: 'not_ordered', order: null };
};

const reviewableOrderFilter = (userId) => ({
  user: userId,
  awaitingPayment: { $ne: true },
  orderStatus: { $ne: 'cancelled' },
  'confirmation.declinedAt': null,
});

const findStoreReviewEligibility = async ({ userId, store }) => {
  const sellerId = store?.seller?._id || store?.seller;
  if (!userId || !sellerId || !store?._id) {
    return { eligible: false, reason: 'not_ordered', order: null };
  }

  const productIds = await Product.find({ seller: sellerId }).distinct('_id');
  const sellerMatch = [
    { 'orderItems.seller': sellerId },
    { 'sellerPolicies.seller': sellerId },
    { 'sellerPolicies.store': store._id },
  ];
  if (productIds.length > 0) sellerMatch.push({ 'orderItems.productId': { $in: productIds } });

  const orders = await Order.find({
    ...reviewableOrderFilter(userId),
    $or: sellerMatch,
  })
    .select('_id orderId orderStatus isDelivered deliveredAt sellerFulfillment createdAt')
    .sort({ deliveredAt: -1, createdAt: -1 })
    .lean();

  return qualifyingOrderResult(orders, sellerId);
};

const findProductReviewEligibility = async ({ userId, product }) => {
  if (!userId || !product?._id) {
    return { eligible: false, reason: 'not_ordered', order: null };
  }

  const orders = await Order.find({
    ...reviewableOrderFilter(userId),
    'orderItems.productId': product._id,
  })
    .select('_id orderId orderStatus isDelivered deliveredAt sellerFulfillment createdAt')
    .sort({ deliveredAt: -1, createdAt: -1 })
    .lean();

  return qualifyingOrderResult(orders, product.seller);
};

module.exports = {
  findProductReviewEligibility,
  findStoreReviewEligibility,
  isSellerPortionDelivered,
  isWholeOrderDelivered,
};
