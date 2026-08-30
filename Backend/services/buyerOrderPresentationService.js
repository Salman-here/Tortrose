'use strict';

const { sellerOrderSummaryForItems } = require('./orderMoneyService');

const FULFILLMENT_STATUSES = new Set([
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
]);

const toId = value => value?._id?.toString?.() || value?.toString?.() || '';

const presentationError = (message, code = 'BUYER_ORDER_PRESENTATION_INVALID') => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
};

const plainOrder = order => (
  order?.toObject
    ? order.toObject({ virtuals: true })
    : { ...(order || {}) }
);

const uniqueSellerRow = (rows, sellerId, label) => {
  const matches = (rows || []).filter(row => toId(row?.seller) === sellerId);
  if (matches.length > 1) {
    throw presentationError(`The stored ${label} has duplicate rows for one seller.`);
  }
  return matches[0] || null;
};

const normalizeShippingMethod = (row, order, groupCount) => {
  const raw = row?.shippingMethod
    || (groupCount === 1 ? order?.shippingMethod : null);
  if (!raw) return null;
  return {
    name: String(raw.name || '').trim() || 'Shipping',
    price: row?.shippingMethod?.price ?? order?.orderSummary?.shippingCost ?? 0,
    estimatedDays: raw.estimatedDays ?? null,
  };
};

/**
 * Build a buyer-only seller grouping from immutable checkout snapshots. Item
 * indexes deliberately reference the one canonical orderItems array instead
 * of copying financial lines into a second, potentially divergent payload.
 */
const buildBuyerOrderView = order => {
  const result = plainOrder(order);
  const items = Array.isArray(order?.orderItems) ? order.orderItems : [];
  const grouped = new Map();

  for (let index = 0; index < items.length; index += 1) {
    const sellerId = toId(items[index]?.seller);
    if (!sellerId) {
      return {
        ...result,
        buyerPresentationVersion: 1,
        sellerGroupingAvailable: false,
        sellerGroupingReason: 'legacy_missing_seller_snapshot',
        sellerGroups: [],
      };
    }
    if (!grouped.has(sellerId)) grouped.set(sellerId, []);
    grouped.get(sellerId).push(index);
  }

  const sellerGroups = [...grouped.entries()].map(([sellerId, itemIndexes], groupIndex) => {
    const sellerItems = itemIndexes.map(index => items[index]);
    const fulfillment = uniqueSellerRow(order?.sellerFulfillment, sellerId, 'seller fulfillment');
    const shipping = uniqueSellerRow(order?.sellerShipping, sellerId, 'seller shipping');
    const policy = uniqueSellerRow(order?.sellerPolicies, sellerId, 'seller policy');
    const status = String(fulfillment?.status || order?.orderStatus || '').trim().toLowerCase();
    if (!FULFILLMENT_STATUSES.has(status)) {
      throw presentationError('The stored seller fulfillment status is invalid.');
    }
    const summary = sellerOrderSummaryForItems(order, sellerId, sellerItems);

    return {
      sellerId,
      storeName: String(policy?.storeName || '').trim() || `Store ${groupIndex + 1}`,
      itemIndexes,
      itemCount: summary.itemCount,
      units: summary.units,
      status,
      deliveredAt: fulfillment?.deliveredAt || null,
      updatedAt: fulfillment?.updatedAt || order?.updatedAt || null,
      shippingMethod: normalizeShippingMethod(shipping, order, grouped.size),
      summary: {
        subtotal: summary.subtotal,
        shippingCost: summary.shippingCost,
        tax: summary.tax,
        couponDiscount: summary.couponDiscount,
        reconciliationAdjustment: summary.adjustment,
        totalAmount: summary.totalAmount,
      },
    };
  });

  return {
    ...result,
    buyerPresentationVersion: 1,
    sellerGroupingAvailable: sellerGroups.length > 0,
    sellerGroupingReason: sellerGroups.length ? null : 'order_has_no_items',
    sellerGroups,
  };
};

module.exports = {
  FULFILLMENT_STATUSES,
  buildBuyerOrderView,
  presentationError,
};
