import {
  addCurrencyAmounts,
  multiplyCurrencyAmount,
  roundCurrencyAmount,
  toCurrencyMinorUnits,
} from './currencySafety.js';

export const toPlainOptions = (value) => {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value.entries());
  if (typeof value === 'object') return { ...value };
  return {};
};

const clean = (value) => String(value ?? '').trim();

const orderPresentationIntegrityError = (label) => {
  const error = new Error(`The stored ${label} is invalid.`);
  error.code = 'ORDER_PRESENTATION_DATA_INVALID';
  return error;
};

const ORDER_CURRENCIES = new Set(['USD', 'PKR', 'EUR', 'GBP']);
const hasOwn = (value, key) => Boolean(value)
  && typeof value === 'object'
  && Object.prototype.hasOwnProperty.call(value, key);

const requireCanonicalOrderCurrency = (value, label = 'order currency') => {
  if (
    typeof value !== 'string'
    || value !== value.trim().toUpperCase()
    || !ORDER_CURRENCIES.has(value)
  ) {
    throw orderPresentationIntegrityError(label);
  }
  return value;
};

export const getOrderCurrency = (order = {}) => {
  const stored = ['currency', 'displayCurrency', 'orderCurrency']
    .filter((key) => hasOwn(order, key))
    .map((key) => order[key])
    .filter((value) => value !== null && value !== undefined)
    .map((value) => requireCanonicalOrderCurrency(value));
  const unique = [...new Set(stored)];
  if (unique.length > 1) throw orderPresentationIntegrityError('order currency metadata');
  return unique[0] || 'USD';
};

const requireExactStoredMoney = (value, label, { signed = false } = {}) => {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || (!signed && value < 0)
    || roundCurrencyAmount(value) !== value
  ) {
    throw orderPresentationIntegrityError(label);
  }
  return value;
};

export const getOrderSummaryAmount = (
  order,
  keys,
  label,
  { signed = false, fallback = 0 } = {},
) => {
  const summary = order?.orderSummary || {};
  const stored = (Array.isArray(keys) ? keys : [keys])
    .filter((key) => summary[key] !== null && summary[key] !== undefined)
    .map((key) => requireExactStoredMoney(summary[key], label, { signed }));
  if (new Set(stored).size > 1) {
    throw orderPresentationIntegrityError(`${label} metadata`);
  }
  return stored.length
    ? stored[0]
    : requireExactStoredMoney(fallback, label, { signed });
};

const readLegacySummaryMoney = (summary, keys, label, options = {}) => {
  const stored = keys
    .filter((key) => summary?.[key] !== null && summary?.[key] !== undefined)
    .map((key) => requireExactStoredMoney(summary[key], label, options));
  if (new Set(stored).size > 1) {
    throw orderPresentationIntegrityError(`${label} metadata`);
  }
  return stored[0] ?? 0;
};

const readLegacyLineQuantity = (item) => {
  const stored = ['quantity', 'qty']
    .filter((key) => hasOwn(item, key) && item[key] !== null && item[key] !== undefined)
    .map((key) => item[key]);
  if (stored.length === 0) return 1;
  if (
    stored.some((value) => !Number.isSafeInteger(value) || value < 1)
    || new Set(stored).size > 1
  ) {
    throw orderPresentationIntegrityError('order item quantity');
  }
  return stored[0];
};

export const getOrderItemQuantity = (item) => readLegacyLineQuantity(item);

export const getOrderSellerShippingBreakdown = (order, sellerId = null) => {
  const summaryShipping = getOrderSummaryAmount(
    order,
    ['shippingCost', 'shippingFee'],
    'order shipping',
  );
  const rawRows = order?.sellerShipping;
  if (rawRows === null || rawRows === undefined || (Array.isArray(rawRows) && rawRows.length === 0)) {
    return { hasBreakdown: false, total: summaryShipping, entries: [] };
  }
  if (!Array.isArray(rawRows)) throw orderPresentationIntegrityError('seller shipping breakdown');

  const entries = rawRows.map((row) => {
    if (!row || typeof row !== 'object' || !row.shippingMethod || typeof row.shippingMethod !== 'object') {
      throw orderPresentationIntegrityError('seller shipping breakdown');
    }
    const seller = String(row.seller?._id || row.seller || '').trim();
    const name = row.shippingMethod.name;
    const estimatedDays = row.shippingMethod.estimatedDays;
    if (
      !seller
      || typeof name !== 'string'
      || !name.trim()
      || name !== name.trim()
      || !Number.isSafeInteger(estimatedDays)
      || estimatedDays < 1
    ) throw orderPresentationIntegrityError('seller shipping breakdown');
    return {
      ...row,
      seller,
      shippingMethod: {
        ...row.shippingMethod,
        name,
        estimatedDays,
        price: requireExactStoredMoney(row.shippingMethod.price, 'seller shipping price'),
      },
    };
  });
  const fullTotal = addCurrencyAmounts(...entries.map(entry => entry.shippingMethod.price));
  if (fullTotal !== summaryShipping) {
    throw orderPresentationIntegrityError('seller shipping total');
  }
  const filtered = sellerId === null
    ? entries
    : entries.filter(entry => entry.seller === String(sellerId));
  return {
    hasBreakdown: true,
    total: addCurrencyAmounts(...filtered.map(entry => entry.shippingMethod.price)),
    entries: filtered,
  };
};

const SELLER_FULFILLMENT_STATUSES = new Set([
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
]);

/**
 * Validate the backend's versioned seller grouping before any buyer UI uses
 * it. Groups reference canonical orderItems by index and all per-seller money
 * must conserve the immutable full-order checkout summary exactly.
 */
export const getOrderSellerGroups = (order = {}) => {
  const rawGroups = order?.sellerGroups;
  if (rawGroups === null || rawGroups === undefined) return [];
  if (!Array.isArray(rawGroups)) throw orderPresentationIntegrityError('seller order groups');
  if (order.sellerGroupingAvailable === false) {
    if (rawGroups.length) throw orderPresentationIntegrityError('seller order grouping state');
    return [];
  }
  if (!Array.isArray(order.orderItems)) throw orderPresentationIntegrityError('order items');

  const seenSellers = new Set();
  const seenIndexes = new Set();
  const groups = rawGroups.map((group) => {
    if (!group || typeof group !== 'object') throw orderPresentationIntegrityError('seller order group');
    const sellerId = clean(group.sellerId);
    const storeName = clean(group.storeName);
    const status = clean(group.status).toLowerCase();
    if (!sellerId || !storeName || seenSellers.has(sellerId) || !SELLER_FULFILLMENT_STATUSES.has(status)) {
      throw orderPresentationIntegrityError('seller order group identity');
    }
    seenSellers.add(sellerId);
    if (!Array.isArray(group.itemIndexes) || !group.itemIndexes.length) {
      throw orderPresentationIntegrityError('seller order item indexes');
    }
    const itemIndexes = group.itemIndexes.map((index) => {
      if (
        !Number.isSafeInteger(index)
        || index < 0
        || index >= order.orderItems.length
        || seenIndexes.has(index)
      ) {
        throw orderPresentationIntegrityError('seller order item indexes');
      }
      seenIndexes.add(index);
      return index;
    });
    const items = itemIndexes.map(index => order.orderItems[index]);
    const units = items.reduce((sum, item) => {
      const next = sum + getOrderItemQuantity(item);
      if (!Number.isSafeInteger(next)) throw orderPresentationIntegrityError('seller order units');
      return next;
    }, 0);
    if (
      group.itemCount !== undefined
      && (!Number.isSafeInteger(group.itemCount) || group.itemCount !== items.length)
    ) throw orderPresentationIntegrityError('seller order item count');
    if (
      group.units !== undefined
      && (!Number.isSafeInteger(group.units) || group.units !== units)
    ) throw orderPresentationIntegrityError('seller order units');

    const summary = group.summary || {};
    const normalizedSummary = {
      subtotal: requireExactStoredMoney(summary.subtotal, 'seller subtotal'),
      shippingCost: requireExactStoredMoney(summary.shippingCost, 'seller shipping'),
      tax: requireExactStoredMoney(summary.tax, 'seller tax'),
      couponDiscount: requireExactStoredMoney(summary.couponDiscount, 'seller discount'),
      reconciliationAdjustment: requireExactStoredMoney(
        summary.reconciliationAdjustment,
        'seller reconciliation adjustment',
        { signed: true },
      ),
      totalAmount: requireExactStoredMoney(summary.totalAmount, 'seller total'),
    };
    const calculatedSellerTotal = addCurrencyAmounts(
      normalizedSummary.subtotal,
      normalizedSummary.shippingCost,
      normalizedSummary.tax,
      -normalizedSummary.couponDiscount,
      normalizedSummary.reconciliationAdjustment,
    );
    if (calculatedSellerTotal !== normalizedSummary.totalAmount) {
      throw orderPresentationIntegrityError('seller summary total');
    }

    let shippingMethod = null;
    if (group.shippingMethod !== null && group.shippingMethod !== undefined) {
      const name = group.shippingMethod?.name;
      const estimatedDays = group.shippingMethod?.estimatedDays;
      const price = requireExactStoredMoney(group.shippingMethod?.price, 'seller shipping method price');
      if (
        typeof name !== 'string'
        || !name.trim()
        || name !== name.trim()
        || (estimatedDays !== null && estimatedDays !== undefined
          && (!Number.isSafeInteger(estimatedDays) || estimatedDays < 1))
        || price !== normalizedSummary.shippingCost
      ) throw orderPresentationIntegrityError('seller shipping method');
      shippingMethod = { ...group.shippingMethod, name, estimatedDays, price };
    }

    return {
      ...group,
      sellerId,
      storeName,
      status,
      itemIndexes,
      itemCount: items.length,
      units,
      items,
      shippingMethod,
      summary: normalizedSummary,
    };
  });

  if (seenIndexes.size !== order.orderItems.length) {
    throw orderPresentationIntegrityError('seller order item coverage');
  }
  const fullSummary = {
    subtotal: getOrderSummaryAmount(order, ['subtotal'], 'order subtotal'),
    shippingCost: getOrderSummaryAmount(order, ['shippingCost', 'shippingFee'], 'order shipping'),
    tax: getOrderSummaryAmount(order, ['tax', 'taxAmount'], 'order tax'),
    couponDiscount: getOrderSummaryAmount(order, ['couponDiscount', 'discountAmount'], 'order discount'),
    reconciliationAdjustment: getOrderSummaryAmount(
      order,
      ['reconciliationAdjustment'],
      'order reconciliation adjustment',
      { signed: true },
    ),
    totalAmount: getOrderTotal(order),
  };
  for (const key of Object.keys(fullSummary)) {
    const groupedTotal = addCurrencyAmounts(...groups.map(group => group.summary[key]));
    if (groupedTotal !== fullSummary[key]) {
      throw orderPresentationIntegrityError(`seller grouped ${key}`);
    }
  }

  return groups;
};

export const inspectOrderListMoney = (order) => {
  try {
    return {
      valid: true,
      currency: getOrderCurrency(order),
      total: getOrderTotal(order),
    };
  } catch (error) {
    return {
      valid: false,
      currency: null,
      total: null,
      error,
    };
  }
};

export const getOrderItemOptionPairs = (item = {}) => {
  const pairs = [];
  const selectedOptions = toPlainOptions(item.selectedOptions);

  Object.entries(selectedOptions).forEach(([name, value]) => {
    const key = clean(name);
    const val = clean(value);
    if (key && val) pairs.push({ name: key, value: val });
  });

  const selectedColor = clean(item.selectedColor);
  const hasColorOption = pairs.some(pair => pair.name.toLowerCase() === 'color');
  if (selectedColor && !hasColorOption) pairs.push({ name: 'Color', value: selectedColor });

  return pairs;
};

export const formatOrderItemOptions = (item = {}) =>
  getOrderItemOptionPairs(item).map(pair => `${pair.name}: ${pair.value}`).join(', ');

export const hasOrderItemOptions = (item = {}) => getOrderItemOptionPairs(item).length > 0;

// New orders persist the line total because a converted unit can round below
// one cent. Only legacy orders should reconstruct it from rounded unit price.
export const getOrderItemLineSubtotal = (item = {}) => {
  if (item.lineSubtotal !== null && item.lineSubtotal !== undefined) {
    return requireExactStoredMoney(item.lineSubtotal, 'order item line subtotal');
  }
  const price = requireExactStoredMoney(item.price, 'legacy order item unit price');
  const quantity = readLegacyLineQuantity(item);
  return multiplyCurrencyAmount(price, quantity);
};

// A converted line is allocated in integer minor units. Derive a visible unit
// amount only when those exact cents divide evenly by the quantity; otherwise
// the UI must describe the authoritative complete line price instead of
// showing a rounded unit that cannot reproduce the line total.
export const getExactLineUnitAmount = (lineSubtotal, quantity) => {
  const total = requireExactStoredMoney(lineSubtotal, 'line subtotal');
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw orderPresentationIntegrityError('line quantity');
  }
  const totalMinor = toCurrencyMinorUnits(total);
  if (!Number.isSafeInteger(totalMinor) || totalMinor % quantity !== 0) return null;
  const unit = roundCurrencyAmount(total / quantity);
  return toCurrencyMinorUnits(unit) * quantity === totalMinor ? unit : null;
};

export const getExactOrderItemUnitAmount = (item = {}) => (
  getExactLineUnitAmount(getOrderItemLineSubtotal(item), readLegacyLineQuantity(item))
);

// A globally converted line can have a non-zero total even when its converted
// unit rounds to 0.00. Only render "quantity x unit" when that visible equation
// reproduces the authoritative stored line total in integer minor units.
export const hasExactOrderItemUnitEquation = (item = {}) => {
  const quantity = readLegacyLineQuantity(item);
  const price = requireExactStoredMoney(item.price, 'order item unit price');
  const multipliedMinor = toCurrencyMinorUnits(price) * quantity;
  return Number.isSafeInteger(multipliedMinor)
    && multipliedMinor === toCurrencyMinorUnits(getOrderItemLineSubtotal(item));
};

// `totalAmount` is the checkout-time settlement source of truth. Reconstruct
// only genuinely legacy summaries, and do that through integer cents so a UI
// never reintroduces float drift or forgets the coupon/rounding adjustment.
export const getOrderTotal = (order = {}) => {
  const summary = order?.orderSummary || {};
  const storedTotals = [summary.totalAmount, summary.total, order?.totalAmount, order?.total]
    .filter((value) => value !== null && value !== undefined)
    .map((value) => requireExactStoredMoney(value, 'order total'));
  if (new Set(storedTotals).size > 1) {
    throw orderPresentationIntegrityError('order total metadata');
  }
  if (storedTotals.length) {
    const storedTotal = storedTotals[0];
    if (summary.subtotal !== null && summary.subtotal !== undefined) {
      const calculatedTotal = addCurrencyAmounts(
        readLegacySummaryMoney(summary, ['subtotal'], 'order subtotal'),
        readLegacySummaryMoney(summary, ['shippingCost', 'shippingFee'], 'order shipping'),
        readLegacySummaryMoney(summary, ['tax', 'taxAmount'], 'order tax'),
        -readLegacySummaryMoney(summary, ['couponDiscount', 'discountAmount'], 'order discount'),
        readLegacySummaryMoney(
          summary,
          ['reconciliationAdjustment'],
          'order reconciliation adjustment',
          { signed: true },
        ),
      );
      if (calculatedTotal < 0 || calculatedTotal !== storedTotal) {
        throw orderPresentationIntegrityError('order summary total');
      }
    }
    return storedTotal;
  }

  const legacyTotal = addCurrencyAmounts(
    readLegacySummaryMoney(summary, ['subtotal'], 'legacy order subtotal'),
    readLegacySummaryMoney(summary, ['shippingCost', 'shippingFee'], 'legacy order shipping'),
    readLegacySummaryMoney(summary, ['tax', 'taxAmount'], 'legacy order tax'),
    -readLegacySummaryMoney(summary, ['couponDiscount', 'discountAmount'], 'legacy order discount'),
    readLegacySummaryMoney(
      summary,
      ['reconciliationAdjustment'],
      'legacy order reconciliation adjustment',
      { signed: true },
    )
  );
  if (legacyTotal < 0) {
    throw orderPresentationIntegrityError('legacy order total');
  }
  return legacyTotal;
};
