'use strict';
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const { verifyOrderPricingAtCommit } = require('./orderPricingCommitGuard');
const { aggregateOrderInventoryLines } = require('./orderInventoryService');
const { validateProductSelection } = require('./productSelectionService');
const { reserveOrderCoupons } = require('./couponUsageService');
const fail = (message, code) => Object.assign(new Error(message), { code, statusCode: 409 });
const POLICY = 'revalidate-on-payment-v1';

async function assertOrderAvailable(payment, session, { reserveCoupons = false } = {}) {
  const order = await Order.findById(payment.order).session(session);
  if (!order || String(order.safepayPaymentId) !== String(payment._id) || order.paymentMethod !== 'safepay') {
    throw fail('The order does not match its payment.', 'SAFEPAY_ORDER_BINDING_INVALID');
  }
  if (order.isPaid || !order.awaitingPayment || order.orderStatus === 'cancelled' || order.confirmation?.declinedAt || payment.localCancelledAt) {
    throw fail('This purchase is already completed or was cancelled.', 'SAFEPAY_ORDER_INTENT_CLOSED');
  }
  const sellerIds = [...new Set(order.orderItems.map(item => String(item.seller)))].sort();
  // Share actual documents with account/store/product mutations. A competing
  // stock or block write forces the transaction to retry against fresh data.
  for (const seller of sellerIds) {
    const found = await User.updateOne({ _id: seller, role: 'seller', status: 'active' }, { $inc: { __v: 1 } }, { session });
    if (found.matchedCount !== 1) throw fail('A seller is no longer available.', 'SAFEPAY_SELLER_UNAVAILABLE');
  }
  // Revalidate the original native prices/shipping, not today's exchange
  // rate. The frozen buyer/seller money itself is never rewritten.
  await verifyOrderPricingAtCommit(order, session);
  const products = await Product.find({ _id: { $in: order.orderItems.map(item => item.productId) } }).session(session).lean();
  const byId = new Map(products.map(product => [String(product._id), product]));
  for (const item of order.orderItems) {
    const product = byId.get(String(item.productId));
    const selectedOptions = item.selectedOptions?.toObject ? item.selectedOptions.toObject() : item.selectedOptions;
    const selection = validateProductSelection(product, { selectedColor: item.selectedColor, selectedOptions });
    if (!selection.ok) throw fail('A selected product option is no longer available.', 'SAFEPAY_OPTIONS_CHANGED');
  }
  if (!order.inventoryCommitted) for (const line of aggregateOrderInventoryLines(order.orderItems)) {
    if (!Number.isSafeInteger(byId.get(line.productId)?.stock) || byId.get(line.productId).stock < line.quantity) {
      throw fail('The full order no longer has enough stock.', 'ORDER_STOCK_CHANGED');
    }
  }
  if (reserveCoupons && order.appliedCoupons?.length) await reserveOrderCoupons({ orderId: order._id, userId: order.user, session });
  return order;
}
module.exports = { POLICY, assertOrderAvailable };
