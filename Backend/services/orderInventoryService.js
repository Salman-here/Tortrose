const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');

const stockChangedError = (name) => {
  const error = new Error(`${name || 'A product'} no longer has enough stock.`);
  error.statusCode = 409;
  error.code = 'ORDER_STOCK_CHANGED';
  return error;
};

const aggregateOrderInventoryLines = (items = []) => {
  const linesByProduct = new Map();
  for (const item of items) {
    const productId = item?.productId?._id?.toString?.() || item?.productId?.toString?.() || '';
    const quantity = Number(item?.quantity);
    if (!productId || !mongoose.isValidObjectId(productId)) {
      const error = new Error(`${item?.name || 'A product'} has an invalid product reference.`);
      error.statusCode = 409;
      error.code = 'ORDER_PRODUCT_INVALID';
      throw error;
    }
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      const error = new Error(`${item?.name || 'A product'} has an invalid order quantity.`);
      error.statusCode = 409;
      error.code = 'ORDER_QUANTITY_INVALID';
      throw error;
    }
    const current = linesByProduct.get(productId);
    const aggregateQuantity = (current?.quantity || 0) + quantity;
    if (!Number.isSafeInteger(aggregateQuantity)) {
      const error = new Error(`${item?.name || 'A product'} has an invalid aggregate order quantity.`);
      error.statusCode = 409;
      error.code = 'ORDER_QUANTITY_INVALID';
      throw error;
    }
    linesByProduct.set(productId, {
      productId,
      name: current?.name || item?.name || 'A product',
      quantity: aggregateQuantity,
    });
  }
  return [...linesByProduct.values()];
};

/**
 * Atomically commits stock once for COD/Stripe orders. The order flag and all
 * product changes live in the same transaction, making webhook retries safe.
 */
const commitOrderInventoryInSession = async (orderId, session, { allowCancelled = false } = {}) => {
  let result = null;
  const order = await Order.findById(orderId).session(session);
  if (!order) {
    const error = new Error('Order not found');
    error.statusCode = 404;
    throw error;
  }
  if (order.orderStatus === 'cancelled' && !allowCancelled) {
    const error = new Error('This order was cancelled and cannot reserve inventory again.');
    error.statusCode = 409;
    error.code = 'ORDER_CANCELLED';
    throw error;
  }
  if (order.inventoryCommitted) {
    return { order, alreadyCommitted: true };
  }

  const inventoryLines = aggregateOrderInventoryLines(order.orderItems || []);
  for (const item of inventoryLines) {
    const quantity = item.quantity;
    const update = await Product.updateOne(
      { _id: item.productId, stock: { $gte: quantity } },
      { $inc: { stock: -quantity, totalSales: quantity } },
      { session },
    );
    if (update.modifiedCount !== 1) throw stockChangedError(item.name);
  }

  order.inventoryCommitted = true;
  await order.save({ session });
  result = { order, alreadyCommitted: false };
  return result;
};

const commitOrderInventory = async (
  orderId,
  { session: existingSession = null, allowCancelled = false } = {},
) => {
  if (existingSession) return commitOrderInventoryInSession(orderId, existingSession, { allowCancelled });
  const session = await mongoose.startSession();
  let result = null;
  try {
    await session.withTransaction(async () => {
      result = await commitOrderInventoryInSession(orderId, session, { allowCancelled });
    });
    return result;
  } finally {
    await session.endSession();
  }
};

const commitOrderInventoryAndCouponsInSession = async (
  orderId,
  session,
  { allowCancelled = false } = {},
) => {
  const result = await commitOrderInventoryInSession(orderId, session, { allowCancelled });
  const { consumeOrderCoupons } = require('./couponUsageService');
  await consumeOrderCoupons({ orderId, session });
  return result;
};

const commitOrderInventoryAndCoupons = async (
  orderId,
  { session: existingSession = null, allowCancelled = false } = {},
) => {
  if (existingSession) {
    return commitOrderInventoryAndCouponsInSession(orderId, existingSession, { allowCancelled });
  }
  const session = await mongoose.startSession();
  let result = null;
  try {
    await session.withTransaction(async () => {
      result = await commitOrderInventoryAndCouponsInSession(orderId, session, { allowCancelled });
    });
    return result;
  } finally {
    await session.endSession();
  }
};

const restoreOrderInventoryInSession = async (orderId, session) => {
  let result = null;
  const order = await Order.findById(orderId).session(session);
  if (!order) return null;
  if (!order.inventoryCommitted) return { order, alreadyRestored: true };
  const inventoryLines = aggregateOrderInventoryLines(order.orderItems || []);
  for (const item of inventoryLines) {
    const quantity = item.quantity;
    await Product.updateOne(
      { _id: item.productId },
      [
        {
          $set: {
            stock: { $add: [{ $ifNull: ['$stock', 0] }, quantity] },
            totalSales: { $max: [0, { $subtract: [{ $ifNull: ['$totalSales', 0] }, quantity] }] },
          },
        },
      ],
      { session },
    );
  }
  order.inventoryCommitted = false;
  await order.save({ session });
  result = { order, alreadyRestored: false };
  return result;
};

/** Restore previously committed stock exactly once. */
const restoreOrderInventory = async (orderId, { session: existingSession = null } = {}) => {
  if (existingSession) return restoreOrderInventoryInSession(orderId, existingSession);
  const session = await mongoose.startSession();
  let result = null;
  try {
    await session.withTransaction(async () => {
      result = await restoreOrderInventoryInSession(orderId, session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

module.exports = {
  aggregateOrderInventoryLines,
  commitOrderInventory,
  commitOrderInventoryAndCoupons,
  restoreOrderInventory,
};
