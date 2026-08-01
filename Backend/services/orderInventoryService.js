const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');

const stockChangedError = (name) => {
  const error = new Error(`${name || 'A product'} no longer has enough stock.`);
  error.statusCode = 409;
  error.code = 'ORDER_STOCK_CHANGED';
  return error;
};

/**
 * Atomically commits stock once for COD/Stripe orders. The order flag and all
 * product changes live in the same transaction, making webhook retries safe.
 */
const commitOrderInventory = async (orderId) => {
  const session = await mongoose.startSession();
  let result = null;
  try {
    await session.withTransaction(async () => {
      const order = await Order.findById(orderId).session(session);
      if (!order) {
        const error = new Error('Order not found');
        error.statusCode = 404;
        throw error;
      }
      if (order.inventoryCommitted) {
        result = { order, alreadyCommitted: true };
        return;
      }

      for (const item of order.orderItems || []) {
        const quantity = Math.max(1, Number(item.quantity) || 1);
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
    });
    return result;
  } finally {
    await session.endSession();
  }
};

/** Restore previously committed stock once when an unpaid COD order is cancelled. */
const restoreOrderInventory = async (orderId) => {
  const session = await mongoose.startSession();
  let result = null;
  try {
    await session.withTransaction(async () => {
      const order = await Order.findById(orderId).session(session);
      if (!order) return;
      if (!order.inventoryCommitted) {
        result = { order, alreadyRestored: true };
        return;
      }
      for (const item of order.orderItems || []) {
        const quantity = Math.max(1, Number(item.quantity) || 1);
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
    });
    return result;
  } finally {
    await session.endSession();
  }
};

module.exports = { commitOrderInventory, restoreOrderInventory };

