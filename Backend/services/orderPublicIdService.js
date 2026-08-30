'use strict';

const Order = require('../models/Order');
const OrderPublicIdCounter = require('../models/OrderPublicIdCounter');

const COUNTER_ID = 'order-public-id-v3';
const SHORT_ORDER_ID_PATTERN = /^ORD-\d{13}$/;
const MAX_COLLISION_RETRIES = 100;

const publicIdError = (message, code) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 503;
  return error;
};

const reserveNextCounterValue = async ({ now = new Date() } = {}) => {
  const nowMs = now.getTime();
  if (!Number.isSafeInteger(nowMs) || nowMs < 1 || nowMs > 9_999_999_999_999) {
    throw publicIdError(
      'The server clock cannot produce a supported order number.',
      'ORDER_PUBLIC_ID_CLOCK_INVALID',
    );
  }

  const counter = await OrderPublicIdCounter.findOneAndUpdate(
    { _id: COUNTER_ID },
    [
      {
        $set: {
          value: {
            $max: [
              nowMs,
              { $add: [{ $ifNull: ['$value', nowMs - 1] }, 1] },
            ],
          },
          createdAt: { $ifNull: ['$createdAt', now] },
          updatedAt: now,
        },
      },
    ],
    { upsert: true, new: true },
  ).lean();

  if (!Number.isSafeInteger(counter?.value) || counter.value < 1) {
    throw publicIdError(
      'The order number allocator returned an invalid value.',
      'ORDER_PUBLIC_ID_ALLOCATION_INVALID',
    );
  }
  return counter.value;
};

/**
 * Reserve a compact public order number without trusting process-local time.
 * The MongoDB counter serializes concurrent writers across every server
 * instance. Existing legacy/V2 values are checked before returning so the V3
 * partial unique index never has to resolve a known historical collision.
 * Counter gaps are intentional when a checkout later aborts.
 */
const nextShortOrderId = async ({ now = new Date() } = {}) => {
  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt += 1) {
    const value = await reserveNextCounterValue({ now });
    const orderId = `ORD-${value}`;
    if (!SHORT_ORDER_ID_PATTERN.test(orderId)) {
      throw publicIdError(
        'The allocated order number is outside the supported format.',
        'ORDER_PUBLIC_ID_FORMAT_INVALID',
      );
    }
    if (!await Order.exists({ orderId })) return orderId;
  }

  throw publicIdError(
    'A unique order number could not be reserved. Please retry checkout.',
    'ORDER_PUBLIC_ID_COLLISION_LIMIT',
  );
};

module.exports = {
  COUNTER_ID,
  MAX_COLLISION_RETRIES,
  SHORT_ORDER_ID_PATTERN,
  nextShortOrderId,
  reserveNextCounterValue,
};
