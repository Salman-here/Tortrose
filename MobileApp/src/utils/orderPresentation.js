import {
  addCurrencyAmounts,
  multiplyCurrencyAmount,
  roundCurrencyAmount,
  toCurrencyMinorUnits,
} from './currencySafety';

export const ORDER_STAGES = ['pending', 'confirmed', 'processing', 'shipped', 'delivered'];

export const ACTIVE_ORDER_STATUSES = new Set(['pending', 'confirmed', 'processing', 'shipped']);

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
  // Orders created before multi-currency support were USD-only and did not
  // persist this field. Absence/null is therefore a legacy USD contract; any
  // present non-canonical value was rejected above.
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
    .filter((key) => hasOwn(item, key))
    .map((key) => item[key])
    .filter((value) => value !== null && value !== undefined);
  if (
    stored.some((value) => !Number.isSafeInteger(value) || value < 1)
    || new Set(stored).size > 1
  ) {
    throw orderPresentationIntegrityError('order item quantity');
  }
  // Historical order rows could omit the quantity before it became required;
  // those rows represented one unit. Present values must remain canonical.
  return stored[0] ?? 1;
};

export const getOrderItemQuantity = (item) => readLegacyLineQuantity(item);

export const normalizeOrderStatus = (status) => {
  const value = String(status || 'pending').toLowerCase();
  return [...ORDER_STAGES, 'cancelled'].includes(value) ? value : 'pending';
};

export const getOrderDisplayId = (order) => {
  const raw = String(order?.orderId || order?._id || '').trim();
  if (!raw) return 'Order';
  return raw.startsWith('#') ? raw : `#${raw}`;
};

export const getOrderItemCount = (order) => {
  if (!Array.isArray(order?.orderItems)) {
    throw orderPresentationIntegrityError('order items');
  }
  return order.orderItems.reduce((total, item) => {
    const next = total + readLegacyLineQuantity(item);
    if (!Number.isSafeInteger(next)) throw orderPresentationIntegrityError('order item count');
    return next;
  }, 0);
};

export const getOrderTotal = (order) => {
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

export const getSellerCurrencyMoney = (order = {}) => {
  const raw = order?.sellerCurrencyMoney;
  if (raw === null || raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1) {
    throw orderPresentationIntegrityError('seller currency money snapshot');
  }
  const currency = requireCanonicalOrderCurrency(raw.currency, 'seller currency');
  const buyerCurrency = requireCanonicalOrderCurrency(raw.buyerCurrency, 'seller buyer currency');
  if (buyerCurrency !== getOrderCurrency(order)) {
    throw orderPresentationIntegrityError('seller buyer currency');
  }
  const readSummary = (summary, prefix) => {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
      throw orderPresentationIntegrityError(`${prefix} summary`);
    }
    const value = {
      subtotal: requireExactStoredMoney(summary.subtotal, `${prefix} subtotal`),
      shippingCost: requireExactStoredMoney(summary.shippingCost, `${prefix} shipping`),
      tax: requireExactStoredMoney(summary.tax, `${prefix} tax`),
      couponDiscount: requireExactStoredMoney(summary.couponDiscount, `${prefix} discount`),
      reconciliationAdjustment: requireExactStoredMoney(
        summary.reconciliationAdjustment,
        `${prefix} adjustment`,
        { signed: true },
      ),
      totalAmount: requireExactStoredMoney(summary.totalAmount, `${prefix} total`),
    };
    if (addCurrencyAmounts(
      value.subtotal,
      value.shippingCost,
      value.tax,
      -value.couponDiscount,
      value.reconciliationAdjustment,
    ) !== value.totalAmount) throw orderPresentationIntegrityError(`${prefix} total`);
    return value;
  };
  const summary = readSummary(raw.summary, 'seller currency');
  const buyerSummary = readSummary(raw.buyerSummary, 'seller buyer-currency');
  if (buyerSummary.totalAmount !== getOrderTotal(order)) {
    throw orderPresentationIntegrityError('seller buyer-currency total');
  }
  if (
    !raw.exchangeRate
    || raw.exchangeRate.from !== currency
    || raw.exchangeRate.to !== buyerCurrency
    || raw.exchangeRate.frozen !== true
    || typeof raw.exchangeRate.rate !== 'number'
    || !Number.isFinite(raw.exchangeRate.rate)
    || raw.exchangeRate.rate <= 0
    || (currency === buyerCurrency && raw.exchangeRate.rate !== 1)
  ) throw orderPresentationIntegrityError('seller exchange rate');
  if (!Array.isArray(raw.itemMoney) || raw.itemMoney.length !== (order.orderItems || []).length) {
    throw orderPresentationIntegrityError('seller item currency money');
  }
  const itemMoney = raw.itemMoney.map((item, index) => {
    if (
      !item
      || item.sellerItemIndex !== index
      || item.currency !== currency
      || item.buyerCurrency !== buyerCurrency
    ) throw orderPresentationIntegrityError('seller item currency money');
    return {
      ...item,
      lineSubtotal: requireExactStoredMoney(item.lineSubtotal, 'seller item line subtotal'),
      buyerLineSubtotal: requireExactStoredMoney(item.buyerLineSubtotal, 'seller buyer item line subtotal'),
      originalLineSubtotal: requireExactStoredMoney(item.originalLineSubtotal, 'seller original line subtotal'),
      originalUnitPrice: item.originalUnitPrice === null || item.originalUnitPrice === undefined
        ? null
        : requireExactStoredMoney(item.originalUnitPrice, 'seller original unit price'),
      originalCurrency: requireCanonicalOrderCurrency(item.originalCurrency, 'seller original item currency'),
    };
  });
  if (addCurrencyAmounts(...itemMoney.map(item => item.lineSubtotal)) !== summary.subtotal) {
    throw orderPresentationIntegrityError('seller item subtotal');
  }
  return { ...raw, currency, buyerCurrency, summary, buyerSummary, itemMoney };
};

export const getOrderLeadItem = (order) => (order?.orderItems || [])[0] || null;

export const formatOrderItemOptions = (item) => {
  const values = [];
  if (item?.selectedColor) values.push(`Color: ${item.selectedColor}`);
  const options = item?.selectedOptions;
  if (options && typeof options === 'object') {
    Object.entries(options).forEach(([name, value]) => {
      if (value !== undefined && value !== null && String(value).trim()) {
        values.push(`${name}: ${value}`);
      }
    });
  }
  return values.join('  •  ');
};

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

export const hasExactOrderItemUnitEquation = (item = {}) => {
  const quantity = readLegacyLineQuantity(item);
  const price = requireExactStoredMoney(item.price, 'order item unit price');
  const multipliedMinor = toCurrencyMinorUnits(price) * quantity;
  return Number.isSafeInteger(multipliedMinor)
    && multipliedMinor === toCurrencyMinorUnits(getOrderItemLineSubtotal(item));
};

export const getEstimatedDeliveryDate = (order) => {
  if (!order?.createdAt) return null;
  const sellerRows = Array.isArray(order.sellerShipping) ? order.sellerShipping : [];
  const sellerDays = sellerRows.map((entry) => entry?.shippingMethod?.estimatedDays);
  if (sellerDays.some((days) => !Number.isSafeInteger(days) || days < 1)) return null;
  const primaryDays = order?.shippingMethod?.estimatedDays;
  if (
    primaryDays !== null
    && primaryDays !== undefined
    && (!Number.isSafeInteger(primaryDays) || primaryDays < 1)
  ) return null;
  const estimatedDays = sellerDays.length
    ? Math.max(...sellerDays)
    : (Number.isSafeInteger(primaryDays) && primaryDays > 0 ? primaryDays : null);
  if (estimatedDays === null) return null;
  const estimate = new Date(order.createdAt);
  if (Number.isNaN(estimate.getTime())) return null;
  estimate.setDate(estimate.getDate() + estimatedDays);
  return estimate;
};

const hasStoredSummaryValue = (summary, keys) => keys.some((key) => (
  hasOwn(summary, key) && summary[key] !== null && summary[key] !== undefined
));

const canonicalStoredStatus = (order) => {
  const values = ['orderStatus', 'status']
    .filter((key) => hasOwn(order, key) && order[key] !== null && order[key] !== undefined)
    .map((key) => order[key]);
  if (
    values.length === 0
    || new Set(values).size > 1
    || typeof values[0] !== 'string'
    || ![...ORDER_STAGES, 'cancelled'].includes(values[0])
  ) throw orderPresentationIntegrityError('order status');
  return values[0];
};

export const assertOrderDetailPresentation = (order) => {
  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    throw orderPresentationIntegrityError('order');
  }
  getOrderCurrency(order);
  canonicalStoredStatus(order);
  if (typeof order.isPaid !== 'boolean') throw orderPresentationIntegrityError('order payment state');
  if (hasOwn(order, 'isDelivered') && typeof order.isDelivered !== 'boolean') {
    throw orderPresentationIntegrityError('order delivery state');
  }
  if (!['cash_on_delivery', 'stripe', 'wallet'].includes(order.paymentMethod)) {
    throw orderPresentationIntegrityError('order payment method');
  }
  if (!Array.isArray(order.orderItems) || order.orderItems.length === 0) {
    throw orderPresentationIntegrityError('order items');
  }

  const summary = order.orderSummary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    throw orderPresentationIntegrityError('order summary');
  }
  const summaryFields = [
    [['subtotal'], 'order subtotal'],
    [['shippingCost', 'shippingFee'], 'order shipping'],
    [['tax', 'taxAmount'], 'order tax'],
    [['couponDiscount', 'discountAmount'], 'order discount'],
    [['totalAmount', 'total'], 'order total'],
  ];
  summaryFields.forEach(([keys, label]) => {
    if (!hasStoredSummaryValue(summary, keys)) throw orderPresentationIntegrityError(label);
  });

  getOrderItemCount(order);
  order.orderItems.forEach((item) => {
    readLegacyLineQuantity(item);
    getOrderItemLineSubtotal(item);
  });
  getOrderSummaryAmount(order, ['subtotal'], 'order subtotal');
  getOrderSummaryAmount(order, ['shippingCost', 'shippingFee'], 'order shipping');
  getOrderSummaryAmount(order, ['tax', 'taxAmount'], 'order tax');
  getOrderSummaryAmount(order, ['couponDiscount', 'discountAmount'], 'order discount');
  getOrderTotal(order);

  if (order.sellerFulfillment !== undefined && !Array.isArray(order.sellerFulfillment)) {
    throw orderPresentationIntegrityError('seller fulfillment');
  }
  (order.sellerFulfillment || []).forEach((entry) => {
    canonicalStoredStatus({ status: entry?.status });
    const sellerId = String(entry?.seller?._id || entry?.seller || '');
    if (
      !sellerId
      || !order.orderItems.some((item) => String(item?.seller?._id || item?.seller || '') === sellerId)
    ) throw orderPresentationIntegrityError('seller fulfillment items');
  });
  if (order.sellerShipping !== undefined && !Array.isArray(order.sellerShipping)) {
    throw orderPresentationIntegrityError('seller shipping');
  }
  (order.sellerShipping || []).forEach((entry) => {
    const days = entry?.shippingMethod?.estimatedDays;
    if (!Number.isSafeInteger(days) || days < 1) {
      throw orderPresentationIntegrityError('seller shipping estimate');
    }
  });
  if (
    order.shippingMethod?.estimatedDays !== null
    && order.shippingMethod?.estimatedDays !== undefined
    && (
      !Number.isSafeInteger(order.shippingMethod.estimatedDays)
      || order.shippingMethod.estimatedDays < 1
    )
  ) throw orderPresentationIntegrityError('shipping estimate');
  if (order.appliedCoupons !== undefined && !Array.isArray(order.appliedCoupons)) {
    throw orderPresentationIntegrityError('applied coupons');
  }
  const appliedCouponAmounts = [];
  let everyCouponHasAppliedAmount = true;
  (order.appliedCoupons || []).forEach((coupon) => {
    if (!coupon || typeof coupon !== 'object' || Array.isArray(coupon)) {
      throw orderPresentationIntegrityError('applied coupon');
    }
    if (coupon.appliedDiscountAmount !== null && coupon.appliedDiscountAmount !== undefined) {
      appliedCouponAmounts.push(requireExactStoredMoney(coupon.appliedDiscountAmount, 'applied coupon discount'));
    } else {
      everyCouponHasAppliedAmount = false;
    }
    if (
      coupon.discountType === 'percentage'
      && (
        typeof coupon.discountValue !== 'number'
        || !Number.isFinite(coupon.discountValue)
        || coupon.discountValue < 0
        || coupon.discountValue > 100
      )
    ) throw orderPresentationIntegrityError('applied coupon percentage');
    if (coupon.discountType !== undefined && !['fixed', 'percentage'].includes(coupon.discountType)) {
      throw orderPresentationIntegrityError('applied coupon type');
    }
  });
  const storedOrderDiscount = getOrderSummaryAmount(
    order,
    ['couponDiscount', 'discountAmount'],
    'order discount',
  );
  const appliedCouponTotal = appliedCouponAmounts.length
    ? addCurrencyAmounts(...appliedCouponAmounts)
    : 0;
  if (
    appliedCouponTotal > storedOrderDiscount
    || (
      (order.appliedCoupons || []).length > 0
      && everyCouponHasAppliedAmount
      && appliedCouponTotal !== storedOrderDiscount
    )
  ) throw orderPresentationIntegrityError('applied coupon total');
  return order;
};

export const getOrderProgress = (status) => {
  const normalized = normalizeOrderStatus(status);
  if (normalized === 'cancelled') return 0;
  const index = ORDER_STAGES.indexOf(normalized);
  return index < 0 ? 1 : index + 1;
};

export const canCancelOrder = (orderOrStatus) => {
  if (orderOrStatus === null || orderOrStatus === undefined || orderOrStatus === '') return false;
  const order = typeof orderOrStatus === 'string'
    ? { orderStatus: orderOrStatus }
    : (orderOrStatus || {});
  const rawStatus = order.orderStatus || order.status;
  if (!rawStatus || ![...ORDER_STAGES, 'cancelled'].includes(String(rawStatus).toLowerCase())) return false;
  const status = normalizeOrderStatus(rawStatus);
  const fulfillmentStarted = (order.sellerFulfillment || []).some((entry) =>
    ['shipped', 'delivered'].includes(normalizeOrderStatus(entry?.status)));
  return ['pending', 'confirmed', 'processing'].includes(status)
    && !order.isPaid
    && !order.isDelivered
    && !fulfillmentStarted;
};

export const filterOrders = (orders, { search = '', status = 'all', payment = 'all' } = {}) => {
  const term = String(search || '').trim().toLowerCase();
  return (Array.isArray(orders) ? orders : []).filter((order) => {
    const normalizedStatus = normalizeOrderStatus(order?.orderStatus || order?.status);
    const statusMatches = status === 'all'
      || (status === 'active' && ACTIVE_ORDER_STATUSES.has(normalizedStatus))
      || normalizedStatus === status;
    const paymentMatches = payment === 'all'
      || (payment === 'paid' && !!order?.isPaid)
      || (payment === 'unpaid' && !order?.isPaid);
    if (!statusMatches || !paymentMatches) return false;
    if (!term) return true;
    const searchable = [
      order?.orderId,
      order?._id,
      order?.shippingInfo?.fullName,
      ...(order?.orderItems || []).map((item) => item?.name),
      ...(order?.sellerPolicies || []).map((policy) => policy?.storeName),
    ].filter(Boolean).join(' ').toLowerCase();
    return searchable.includes(term);
  });
};
