'use strict';

const mongoose = require('mongoose');
const Cart = require('../models/Cart');
const Order = require('../models/Order');

const toId = (value) => String(value?._id || value || '');

const cartCleanupDataError = (message) => {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = 'CART_CLEANUP_DATA_INVALID';
  return error;
};

const requireCleanupQuantity = (value, label) => {
  // Pre-default cart rows may genuinely omit qty. Only that nullish legacy
  // sentinel keeps the historical quantity-one meaning; present corruption
  // must never be coerced into a plausible decrement.
  const quantity = value === null || value === undefined ? 1 : value;
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw cartCleanupDataError(`The stored ${label} quantity is invalid.`);
  }
  return quantity;
};

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
const removeFulfilledOrderItemsFromCart = async ({ userId, orderItems, fulfillmentId, session = null }) => {
  const fulfillmentKey = String(fulfillmentId || '').trim();
  if (!mongoose.isValidObjectId(fulfillmentKey)) {
    const error = new Error('A valid fulfillmentId is required for safe cart cleanup.');
    error.code = 'INVALID_FULFILLMENT_ID';
    throw error;
  }
  const fulfillmentObjectId = new mongoose.Types.ObjectId(fulfillmentKey);
  let completedQuery = Order.exists({
    _id: fulfillmentObjectId,
    cartCleanupCompletedAt: { $ne: null },
  });
  if (session) completedQuery = completedQuery.session(session);
  if (await completedQuery) {
    // The order receipt survives cart deletion/recreation. A Cart-only receipt
    // would disappear with the old document and a later retry could otherwise
    // subtract genuinely new quantities from the replacement cart.
    return { matchedLines: 0, removedQuantity: 0 };
  }
  const markOrderCleanupCompleted = () => Order.updateOne(
    { _id: fulfillmentObjectId, cartCleanupCompletedAt: null },
    { $set: { cartCleanupCompletedAt: new Date() } },
    { session },
  );
  if (!userId || !Array.isArray(orderItems) || orderItems.length === 0) {
    await markOrderCleanupCompleted();
    return { matchedLines: 0, removedQuantity: 0 };
  }

  const remainingByVariant = new Map();
  for (const item of orderItems) {
    const quantity = requireCleanupQuantity(item?.quantity, 'order item');
    const productId = toId(item?.productId);
    if (!productId) throw cartCleanupDataError('A stored order item has no product reference.');
    const key = cartVariantKey(item, 'productId');
    const previousQuantity = remainingByVariant.get(key) || 0;
    const combinedQuantity = previousQuantity + quantity;
    if (!Number.isSafeInteger(combinedQuantity)) {
      throw cartCleanupDataError('The fulfilled order quantity is outside the supported range.');
    }
    remainingByVariant.set(key, combinedQuantity);
  }
  let cartQuery = Cart.findOne({ user: userId }).select('_id cartItems');
  if (session) cartQuery = cartQuery.session(session);
  const cart = await cartQuery.lean();
  if (!cart) {
    await markOrderCleanupCompleted();
    return { matchedLines: 0, removedQuantity: 0 };
  }

  const decrements = [];
  for (const line of cart.cartItems || []) {
    const lineQuantity = requireCleanupQuantity(line?.qty, 'cart item');
    const key = cartVariantKey(line, 'product');
    const remaining = remainingByVariant.get(key) || 0;
    if (remaining <= 0) continue;
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
    { session },
  );

  const applied = result.modifiedCount === 1;
  const removedQuantity = applied
    ? decrements.reduce((total, decrement) => total + decrement.quantity, 0)
    : 0;
  // This write is after the cart mutation (and normally shares its caller
  // transaction). If a legacy non-transactional caller retries, the cart
  // receipt prevents a second decrement and repairs this durable order marker.
  // A missing cart is permanently acknowledged so a later replacement cart
  // cannot be mistaken for the cart that produced this order.
  await markOrderCleanupCompleted();

  return { matchedLines: applied ? decrements.length : 0, removedQuantity };
};

module.exports = {
  canonicalOptions,
  cartVariantKey,
  removeFulfilledOrderItemsFromCart,
};
