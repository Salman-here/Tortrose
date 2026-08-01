'use strict';

const mongoose = require('mongoose');
const Cart = require('../models/Cart');
const Order = require('../models/Order');

const toId = (value) => String(value?._id || value || '');

const plainOptions = (value) => {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value);
  if (typeof value.toJSON === 'function') return value.toJSON() || {};
  if (typeof value.toObject === 'function') return value.toObject() || {};
  return typeof value === 'object' ? value : {};
};

const canonicalOptions = (value) => JSON.stringify(
  Object.entries(plainOptions(value))
    .filter(([key, optionValue]) => key && optionValue !== undefined && optionValue !== null)
    .map(([key, optionValue]) => [String(key), String(optionValue)])
    .sort(([left], [right]) => left.localeCompare(right)),
);

const cartVariantKey = (item, productField) => [
  toId(item?.[productField]),
  item?.selectedColor == null ? '' : String(item.selectedColor),
  canonicalOptions(item?.selectedOptions),
].join('\u001f');

/**
 * Removes only the quantities represented by a newly fulfilled order.
 *
 * All decrements and the order receipt are committed in one atomic cart
 * update. If another tab adds quantity while Stripe is open, that new
 * quantity survives; unrelated products and variants are never cleared.
 * Replaying the same fulfillmentId is a no-op, including after an ambiguous
 * database response where the first write may already have succeeded.
 */
const removeFulfilledOrderItemsFromCart = async ({ userId, orderItems, fulfillmentId }) => {
  const fulfillmentKey = String(fulfillmentId || '').trim();
  if (!mongoose.isValidObjectId(fulfillmentKey)) {
    const error = new Error('A valid fulfillmentId is required for safe cart cleanup.');
    error.code = 'INVALID_FULFILLMENT_ID';
    throw error;
  }
  const fulfillmentObjectId = new mongoose.Types.ObjectId(fulfillmentKey);
  const markOrderCleanupCompleted = () => Order.updateOne(
    { _id: fulfillmentObjectId, cartCleanupCompletedAt: null },
    { $set: { cartCleanupCompletedAt: new Date() } },
  );
  if (!userId || !Array.isArray(orderItems) || orderItems.length === 0) {
    await markOrderCleanupCompleted();
    return { matchedLines: 0, removedQuantity: 0 };
  }

  const remainingByVariant = new Map();
  for (const item of orderItems) {
    const quantity = Math.max(0, Math.trunc(Number(item?.quantity) || 0));
    const productId = toId(item?.productId);
    if (!productId || quantity === 0) continue;
    const key = cartVariantKey(item, 'productId');
    remainingByVariant.set(key, (remainingByVariant.get(key) || 0) + quantity);
  }
  const cart = await Cart.findOne({ user: userId }).select('_id cartItems').lean();
  if (!cart) {
    await markOrderCleanupCompleted();
    return { matchedLines: 0, removedQuantity: 0 };
  }

  const decrements = [];
  for (const line of cart.cartItems || []) {
    const key = cartVariantKey(line, 'product');
    const remaining = remainingByVariant.get(key) || 0;
    if (remaining <= 0) continue;
    const lineQuantity = Math.max(1, Math.trunc(Number(line.qty) || 1));
    const decrement = Math.min(lineQuantity, remaining);
    decrements.push({ lineId: line._id, quantity: decrement });
    remainingByVariant.set(key, remaining - decrement);
  }

  const decrementExpression = decrements.length > 0
    ? {
      $switch: {
        branches: decrements.map(decrement => ({
          case: { $eq: ['$$cartItem._id', decrement.lineId] },
          then: decrement.quantity,
        })),
        default: 0,
      },
    }
    : 0;
  const result = await Cart.updateOne(
    {
      _id: cart._id,
      fulfilledOrderIds: { $ne: fulfillmentObjectId },
    },
    [
      {
        $set: {
          cartItems: {
            $filter: {
              input: {
                $map: {
                  input: { $ifNull: ['$cartItems', []] },
                  as: 'cartItem',
                  in: {
                    $mergeObjects: [
                      '$$cartItem',
                      {
                        qty: {
                          $subtract: [
                            { $ifNull: ['$$cartItem.qty', 1] },
                            decrementExpression,
                          ],
                        },
                      },
                    ],
                  },
                },
              },
              as: 'cartItem',
              cond: { $gt: ['$$cartItem.qty', 0] },
            },
          },
          fulfilledOrderIds: {
            $concatArrays: [
              { $ifNull: ['$fulfilledOrderIds', []] },
              [fulfillmentObjectId],
            ],
          },
        },
      },
    ],
  );

  const applied = result.modifiedCount === 1;
  const removedQuantity = applied
    ? decrements.reduce((total, decrement) => total + decrement.quantity, 0)
    : 0;
  // This second write is intentionally after the cart mutation. If it fails,
  // the caller retries: the cart receipt makes that retry a no-op, then this
  // durable order marker is repaired. A missing cart is also permanently
  // acknowledged so an old webhook cannot affect a newly-created cart later.
  await markOrderCleanupCompleted();

  return { matchedLines: applied ? decrements.length : 0, removedQuantity };
};

module.exports = {
  canonicalOptions,
  cartVariantKey,
  removeFulfilledOrderItemsFromCart,
};
