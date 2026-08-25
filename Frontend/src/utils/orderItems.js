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
