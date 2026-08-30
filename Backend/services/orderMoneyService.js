const {
  normalizeCurrency,
  isSupportedCurrency,
  convertAmount,
  convertAmountWithRates,
  formatMoneySync,
  getExchangeRateSnapshot,
  normalizeRates,
  exchangeRatesUnavailableError,
} = require('./currencyService');
const { buildOrderItemDiscountAllocations } = require('./orderDiscountService');
const {
  getOrderItemLineSubtotal,
  getOrderItemSourceLineSubtotal,
} = require('./orderLinePricingService');
const {
  allocateConvertedMinorUnitsByRates,
  allocateMinorUnitsByWeights,
  fromMinorUnits,
  roundMoney,
  sumMoney,
  toMinorUnits,
} = require('./moneyMath');
const { parseStrictFiniteNumber } = require('./numericInputService');

const toId = (value) => value?._id?.toString?.() || value?.toString?.() || String(value || '');
const SELLER_SETTLEMENT_VERSION = 1;
const SELLER_CURRENCY_MONEY_VERSION = 1;

const sellerSettlementError = (message, code = 'SELLER_SETTLEMENT_INVALID') => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
};

const storedOrderMoneyIsMissing = value => value === null || value === undefined;

const requireStoredOrderMoney = (value, label, { allowMissing = false, fallback = 0 } = {}) => {
  if (storedOrderMoneyIsMissing(value) && allowMissing) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw sellerSettlementError(`The stored ${label} is invalid.`, 'ORDER_MONEY_INVALID');
  }
  try {
    if (roundMoney(value) !== value) {
      throw sellerSettlementError(`The stored ${label} is not an exact cent amount.`, 'ORDER_MONEY_INVALID');
    }
  } catch (error) {
    if (error?.code === 'ORDER_MONEY_INVALID') throw error;
    throw sellerSettlementError(`The stored ${label} is outside the supported money range.`, 'ORDER_MONEY_INVALID');
  }
  return value;
};

const sumOrderMinorUnits = (values, label) => {
  const total = (values || []).reduce((sum, value) => {
    if (!Number.isSafeInteger(value)) {
      throw sellerSettlementError(`The stored ${label} is invalid.`, 'ORDER_MONEY_INVALID');
    }
    return sum + BigInt(value);
  }, 0n);
  const numeric = Number(total);
  if (!Number.isSafeInteger(numeric)) {
    throw sellerSettlementError(`The stored ${label} is outside the supported range.`, 'ORDER_MONEY_INVALID');
  }
  try {
    // Enforce the stricter boundary at which every cent still round-trips
    // through the Number fields used by MongoDB and the API.
    fromMinorUnits(numeric);
  } catch (_) {
    throw sellerSettlementError(`The stored ${label} is outside the supported range.`, 'ORDER_MONEY_INVALID');
  }
  return numeric;
};

const sumOrderMoney = (values, label) => fromMinorUnits(sumOrderMinorUnits(
  (values || []).map(value => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw sellerSettlementError(`The stored ${label} is invalid.`, 'ORDER_MONEY_INVALID');
    }
    return toMinorUnits(requireStoredOrderMoney(Math.abs(value), label)) * (value < 0 ? -1 : 1);
  }),
  label,
));

const getOrderCurrency = (order, fallbackCurrency = 'USD') =>
  normalizeCurrency(order?.currency || order?.displayCurrency || order?.orderCurrency || fallbackCurrency);

// Presentation helpers retain a USD fallback for incomplete legacy payloads,
// but accounting must never reinterpret a present, unsupported stored code as
// USD. A corrupt currency would otherwise freeze seller revenue, returns, or
// reports against the wrong unit of account.
const getAccountingOrderCurrency = (order, fallbackCurrency = 'USD') => {
  const rawCurrency = order?.currency
    ?? order?.displayCurrency
    ?? order?.orderCurrency
    ?? normalizeCurrency(fallbackCurrency);
  if (
    !isSupportedCurrency(rawCurrency)
    || typeof rawCurrency !== 'string'
    || rawCurrency !== rawCurrency.trim()
    || rawCurrency !== normalizeCurrency(rawCurrency)
  ) {
    throw sellerSettlementError(
      'The stored order currency is unsupported or malformed.',
      'ORDER_CURRENCY_INVALID',
    );
  }
  return normalizeCurrency(rawCurrency);
};

const normalizeRequestedCurrency = (value, fallbackCurrency = 'USD') => {
  const candidate = value ?? fallbackCurrency;
  if (!isSupportedCurrency(candidate)) {
    const error = new Error('Currency must be one of USD, PKR, EUR, or GBP.');
    error.code = 'UNSUPPORTED_CURRENCY';
    error.statusCode = 400;
    throw error;
  }
  return normalizeCurrency(candidate);
};

const getRequestedCurrency = (req, fallbackCurrency = 'USD') =>
  normalizeRequestedCurrency(
    req?.query?.currency ?? req?.body?.currency ?? req?.user?.currency,
    fallbackCurrency,
  );

const resolveRequestedCurrency = async (req, UserModel, fallbackCurrency = 'USD') => {
  const directCurrency = req?.query?.currency ?? req?.body?.currency ?? req?.user?.currency;
  if (directCurrency !== undefined && directCurrency !== null) {
    return normalizeRequestedCurrency(directCurrency, fallbackCurrency);
  }

  const userId = req?.user?.id || req?.user?._id;
  if (userId && UserModel?.findById) {
    const user = await UserModel.findById(userId).select('currency').lean();
    if (user?.currency !== undefined && user?.currency !== null) {
      return normalizeRequestedCurrency(user.currency, fallbackCurrency);
    }
  }

  return normalizeRequestedCurrency(undefined, fallbackCurrency);
};

const lineTotal = (item) => getOrderItemLineSubtotal(item);

const buildOrderItemKeys = (items = []) => {
  const idCounts = new Map();
  items.forEach(item => {
    const id = toId(item?._id);
    if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1);
  });
  const used = new Set();
  return items.map((item, index) => {
    const id = toId(item?._id);
    let key = id && idCounts.get(id) === 1 ? id : `__item:${index}:${id}`;
    while (used.has(key)) key = `${key}:duplicate`;
    used.add(key);
    return key;
  });
};

const resolveOrderItemIndex = (orderItems, item, fallbackIndex = 0) => {
  const referenceIndex = orderItems.indexOf(item);
  if (referenceIndex >= 0) return referenceIndex;
  const id = toId(item?._id);
  if (id) {
    const matches = orderItems
      .map((candidate, index) => toId(candidate?._id) === id ? index : -1)
      .filter(index => index >= 0);
    if (matches.length === 1) return matches[0];
  }
  return fallbackIndex;
};

const orderItemKey = (item, index = 0, itemKeys = null) =>
  itemKeys?.[index] || toId(item?._id) || `__item:${index}:`;

// Allocate a rounded order-level amount in minor units. Independent rounding
// per seller can create or destroy money (for example, one cent of tax split
// between two sellers used to become two cents). Largest-remainder allocation
// guarantees that every component sums back to the buyer's stored order total.
const allocateRoundedAmount = (amount, entries = []) => {
  const exactAmount = requireStoredOrderMoney(amount, 'allocation amount');
  const minorAllocations = allocateMinorUnitsByWeights(
    toMinorUnits(exactAmount),
    entries,
    { fallbackToEqual: true },
  );
  return new Map([...minorAllocations].map(([key, minor]) => [key, fromMinorUnits(minor)]));
};

const allocateRoundedAmountWithCaps = (amount, entries = []) => {
  const normalizedEntries = entries.map((entry, index) => ({
    key: entry.key,
    index,
    weight: requireStoredOrderMoney(entry.weight, `allocation weight ${index + 1}`),
    capMinor: toMinorUnits(requireStoredOrderMoney(entry.cap, `allocation cap ${index + 1}`)),
  }));
  const allocationsMinor = new Map(normalizedEntries.map(entry => [entry.key, 0]));
  const requestedMinor = toMinorUnits(requireStoredOrderMoney(amount, 'capped allocation amount'));
  const totalCapMinor = normalizedEntries.reduce(
    (sum, entry) => sum + BigInt(entry.capMinor),
    0n,
  );
  let remainingMinor = Number(
    BigInt(requestedMinor) < totalCapMinor ? BigInt(requestedMinor) : totalCapMinor
  );
  let active = normalizedEntries.filter(entry => entry.capMinor > 0);

  while (remainingMinor > 0 && active.length) {
    const proposed = allocateRoundedAmount(
      fromMinorUnits(remainingMinor),
      active.map(entry => ({ key: entry.key, weight: entry.weight }))
    );
    const overCapacity = active.filter(entry => (
      toMinorUnits(proposed.get(entry.key) || 0) > entry.capMinor
    ));
    if (!overCapacity.length) {
      active.forEach(entry => {
        allocationsMinor.set(
          entry.key,
          sumOrderMinorUnits([
            allocationsMinor.get(entry.key) || 0,
            toMinorUnits(proposed.get(entry.key) || 0),
          ], 'capped allocation total')
        );
      });
      remainingMinor = 0;
      break;
    }

    const saturated = new Set(overCapacity.map(entry => entry.key));
    overCapacity.forEach(entry => {
      allocationsMinor.set(entry.key, sumOrderMinorUnits([
        allocationsMinor.get(entry.key) || 0,
        entry.capMinor,
      ], 'capped allocation total'));
      remainingMinor -= entry.capMinor;
    });
    active = active.filter(entry => !saturated.has(entry.key));
  }

  return new Map([...allocationsMinor].map(([key, minor]) => [key, fromMinorUnits(minor)]));
};

const sumAllocationForItems = (allocations, items = [], orderItems = items, itemKeys = buildOrderItemKeys(orderItems)) => sumOrderMoney(
  items.map((item, index) => {
    const orderIndex = resolveOrderItemIndex(orderItems, item, index);
    return allocations.get(itemKeys[orderIndex]) || 0;
  }),
  'seller allocation total',
);

const buildOrderItemTaxAllocations = (order) => {
  const items = order?.orderItems || [];
  const itemKeys = buildOrderItemKeys(items);
  return allocateRoundedAmount(
    requireStoredOrderMoney(order?.orderSummary?.tax, 'order tax', { allowMissing: true }),
    items.map((item, index) => ({ key: itemKeys[index], weight: lineTotal(item) }))
  );
};

const orderShippingTotal = (order) => {
  const rawStoredShipping = order?.orderSummary?.shippingCost;
  if (!storedOrderMoneyIsMissing(rawStoredShipping)) {
    return requireStoredOrderMoney(rawStoredShipping, 'order shipping total');
  }
  const sellerShippingTotal = sumOrderMoney(
    (order?.sellerShipping || []).map((entry, index) => requireStoredOrderMoney(
      entry?.shippingMethod?.price,
      `seller shipping line ${index + 1}`,
    )),
    'seller shipping total',
  );
  if (sellerShippingTotal > 0) return sellerShippingTotal;
  return requireStoredOrderMoney(
    order?.shippingMethod?.price,
    'legacy primary shipping line',
    { allowMissing: true },
  );
};

const buildSellerShippingAllocations = (order) => {
  const storedTotalMinor = toMinorUnits(orderShippingTotal(order));
  const snapshots = (order?.sellerShipping || [])
    .map((entry, index) => ({
      key: toId(entry?.seller),
      amountMinor: toMinorUnits(requireStoredOrderMoney(
        entry?.shippingMethod?.price,
        `seller shipping line ${index + 1}`,
      )),
    }))
    .filter(entry => entry.key);
  const sellerKeys = [...new Set(snapshots.map(entry => entry.key))];
  const allocations = new Map(sellerKeys.map(key => [key, 0]));
  if (!storedTotalMinor) return allocations;

  const snapshotTotalMinor = sumOrderMinorUnits(
    snapshots.map(entry => entry.amountMinor),
    'seller shipping snapshot total',
  );
  if (snapshotTotalMinor > 0) {
    if (snapshotTotalMinor > storedTotalMinor) {
      throw sellerSettlementError(
        'Seller shipping snapshots exceed the stored order shipping total.',
        'SELLER_SETTLEMENT_SHIPPING_TOTAL_MISMATCH',
      );
    }
    // A seller-shipping snapshot is authoritative. Never stretch its amount to
    // absorb a stored order residual that may belong to a missing seller row.
    return allocateRoundedAmount(
      fromMinorUnits(snapshotTotalMinor),
      snapshots.map(entry => ({ key: entry.key, weight: entry.amountMinor }))
    );
  }

  const primarySeller = toId(order?.shippingMethod?.seller);
  if (primarySeller && !snapshots.length) allocations.set(primarySeller, fromMinorUnits(storedTotalMinor));
  return allocations;
};

const buildOrderItemShippingAllocations = (order) => {
  const items = order?.orderItems || [];
  const itemKeys = buildOrderItemKeys(items);
  const shippingTotal = orderShippingTotal(order);
  const allocations = new Map(itemKeys.map(key => [key, 0]));
  if (!items.length || shippingTotal <= 0) return allocations;

  const snapshotSellerIds = new Set(
    (order?.sellerShipping || []).map(entry => toId(entry?.seller)).filter(Boolean)
  );

  const allocateWithinItemIndexes = (amount, indexes) => {
    if (amount <= 0 || !indexes.length) return;
    const sellerLineAllocations = allocateRoundedAmount(
      amount,
      indexes.map(index => ({
        key: itemKeys[index],
        weight: Math.max(0, lineTotal(items[index])),
      }))
    );
    indexes.forEach(index => {
      const key = itemKeys[index];
      allocations.set(key, sellerLineAllocations.get(key) || 0);
    });
  };

  if (snapshotSellerIds.size) {
    // Allocate each authoritative seller-shipping snapshot only among that
    // seller's own lines. The equal-weight fallback is intentionally scoped to
    // one seller, so zero-priced items can never absorb another seller's fee.
    const sellerAllocations = buildSellerShippingAllocations(order);
    for (const [sellerId, amount] of sellerAllocations) {
      const indexes = items
        .map((item, index) => (toId(item?.seller) === sellerId ? index : -1))
        .filter(index => index >= 0);
      allocateWithinItemIndexes(amount, indexes);
    }
    return allocations;
  }

  const primarySellerId = toId(order?.shippingMethod?.seller);
  if (primarySellerId) {
    const indexes = items
      .map((item, index) => (toId(item?.seller) === primarySellerId ? index : -1))
      .filter(index => index >= 0);
    allocateWithinItemIndexes(shippingTotal, indexes);
    return allocations;
  }

  // Ownerless legacy orders have no seller snapshot to preserve. A global
  // subtotal allocation (equal only when every legacy line is zero) is the
  // sole deterministic presentation fallback; settlement still fails closed.
  allocateWithinItemIndexes(shippingTotal, items.map((_item, index) => index));
  return allocations;
};

const buildOrderItemMoneyAllocations = (order) => {
  const items = order?.orderItems || [];
  const itemKeys = buildOrderItemKeys(items);
  const subtotal = new Map(items.map((item, index) => [itemKeys[index], roundMoney(lineTotal(item))]));
  const shipping = buildOrderItemShippingAllocations(order);
  const tax = buildOrderItemTaxAllocations(order);
  const storedDiscounts = buildOrderItemDiscountAllocations(order, { itemKeys });
  const discount = new Map(items.map((item, index) => [
    itemKeys[index],
    roundMoney(storedDiscounts.get(itemKeys[index]) || 0),
  ]));
  const adjustment = new Map(items.map((item, index) => [itemKeys[index], 0]));

  const calculatedSubtotal = sumOrderMoney([...subtotal.values()], 'order line subtotal');
  const storedSubtotal = order?.orderSummary?.subtotal;
  if (
    !storedOrderMoneyIsMissing(storedSubtotal)
    && requireStoredOrderMoney(storedSubtotal, 'order subtotal') !== calculatedSubtotal
  ) {
    throw sellerSettlementError(
      'The stored order subtotal does not reconcile with its line snapshots.',
      'ORDER_TOTAL_MISMATCH',
    );
  }
  const allocatedDiscountTotal = sumOrderMoney([...discount.values()], 'order discount allocation');
  if (allocatedDiscountTotal > calculatedSubtotal) {
    throw sellerSettlementError(
      'The stored coupon discount exceeds the product subtotal.',
      'ORDER_TOTAL_MISMATCH',
    );
  }
  // Reconcile against the stored order components, not merely the seller rows
  // that survived. Otherwise a missing seller-shipping snapshot is disguised as
  // an adjustment and leaks onto unrelated sellers.
  const componentTotal = sumOrderMoney([
    calculatedSubtotal,
    orderShippingTotal(order),
    requireStoredOrderMoney(order?.orderSummary?.tax, 'order tax', { allowMissing: true }),
    -allocatedDiscountTotal,
  ], 'order component total');
  const rawStoredTotal = order?.orderSummary?.totalAmount;
  const storedTotal = storedOrderMoneyIsMissing(rawStoredTotal)
    ? componentTotal
    : requireStoredOrderMoney(rawStoredTotal, 'order total');
  const difference = sumOrderMoney([storedTotal, -componentTotal], 'order reconciliation difference');
  if (difference !== 0 && items.length) {
    const entries = items.map((item, index) => {
      const key = itemKeys[index];
      return {
        key,
        weight: lineTotal(item),
        cap: Math.max(0, sumOrderMoney([
          subtotal.get(key) || 0,
          shipping.get(key) || 0,
          tax.get(key) || 0,
          -(discount.get(key) || 0),
        ], 'order item allocation cap')),
      };
    });
    const distributed = difference < 0
      ? allocateRoundedAmountWithCaps(Math.abs(difference), entries)
      : allocateRoundedAmount(difference, entries);
    items.forEach((item, index) => {
      const key = itemKeys[index];
      adjustment.set(key, difference < 0
        ? -(distributed.get(key) || 0)
        : (distributed.get(key) || 0));
    });
  }

  const total = new Map(items.map((item, index) => {
    const key = itemKeys[index];
    return [key, sumOrderMoney([
      subtotal.get(key) || 0,
      shipping.get(key) || 0,
      tax.get(key) || 0,
      -(discount.get(key) || 0),
      adjustment.get(key) || 0,
    ], 'order item total')];
  }));

  const allocatedShippingTotal = sumOrderMoney([...shipping.values()], 'allocated shipping total');
  const allocatedTotal = sumOrderMoney([...total.values()], 'allocated order total');
  return {
    itemKeys,
    subtotal,
    shipping,
    tax,
    discount,
    adjustment,
    total,
    unallocatedShipping: Math.max(0, sumOrderMoney([
      orderShippingTotal(order),
      -allocatedShippingTotal,
    ], 'unallocated shipping total')),
    unallocatedTotal: sumOrderMoney([storedTotal, -allocatedTotal], 'unallocated order total'),
  };
};

const buildIdSet = (ids) =>
  ids instanceof Set ? ids : new Set((ids || []).map(toId));

// Order item seller snapshots are immutable ownership evidence. The current
// product owner is only a compatibility fallback for legacy lines that were
// created before seller snapshots were stored.
const itemBelongsToSeller = (item, sellerId, sellerProductIds = []) => {
  const snapshotSellerId = toId(item?.seller);
  if (snapshotSellerId) return snapshotSellerId === toId(sellerId);
  return buildIdSet(sellerProductIds).has(toId(item?.productId));
};

const orderItemsSubtotal = (order, predicate = () => true) => sumOrderMoney(
  (order?.orderItems || []).filter(predicate).map(item => lineTotal(item)),
  'order items subtotal',
);

const orderSubtotal = (order) => {
  const summarySubtotal = order?.orderSummary?.subtotal;
  return !storedOrderMoneyIsMissing(summarySubtotal)
    ? requireStoredOrderMoney(summarySubtotal, 'order subtotal')
    : orderItemsSubtotal(order);
};

const getOrderExchangeRates = (order) => (
  order?.exchangeRateSnapshot?.fallback === true
    ? null
    : normalizeRates(order?.exchangeRateSnapshot?.rates)
);

const ensureOrderExchangeRateSnapshot = async (
  order,
  { session = null, snapshot = null, allowHistoricalBackfill = false } = {},
) => {
  getAccountingOrderCurrency(order);
  const existingRates = getOrderExchangeRates(order);
  if (existingRates) return existingRates;
  if (!order?._id) return null;

  // A live rate observed during the first dashboard/refund visit is not the
  // checkout-time rate for a historical order. Never create permanent seller
  // entitlement from that unrelated timestamp. A separately audited migration
  // may opt in only by supplying its recovered/cutover snapshot explicitly.
  if (!allowHistoricalBackfill || !snapshot) return null;

  const resolved = snapshot;
  if (resolved.fallback) return null;
  const rates = normalizeRates(resolved.rates);
  if (!rates) return null;
  const capturedAt = new Date(resolved.capturedAt);
  if (!Number.isFinite(capturedAt.getTime())) return null;
  const storedSnapshot = {
    base: 'USD',
    rates,
    capturedAt,
    source: resolved.source || 'historical_backfill',
    fallback: false,
  };

  const Order = require('../models/Order');
  const query = Order.findOneAndUpdate(
    {
      _id: order._id,
      $or: [
        { exchangeRateSnapshot: { $exists: false } },
        { 'exchangeRateSnapshot.fallback': true },
        { 'exchangeRateSnapshot.rates.PKR': null },
        { 'exchangeRateSnapshot.rates.PKR': { $exists: false } },
        { 'exchangeRateSnapshot.rates.EUR': null },
        { 'exchangeRateSnapshot.rates.EUR': { $exists: false } },
        { 'exchangeRateSnapshot.rates.GBP': null },
        { 'exchangeRateSnapshot.rates.GBP': { $exists: false } },
      ],
    },
    { $set: { exchangeRateSnapshot: storedSnapshot } },
    { new: true, ...(session ? { session } : {}) },
  );
  const updated = await query;
  if (updated) {
    order.exchangeRateSnapshot = updated.exchangeRateSnapshot;
    return getOrderExchangeRates(order);
  }

  // Another writer won the compare-and-set. Never keep using our candidate:
  // reload the actually persisted table so the seller settlement is frozen
  // against the same rates stored on the order.
  const currentQuery = Order.findById(order._id).select('exchangeRateSnapshot');
  if (session) currentQuery.session(session);
  const current = await currentQuery;
  const persistedRates = getOrderExchangeRates(current);
  if (!persistedRates) return null;
  order.exchangeRateSnapshot = current.exchangeRateSnapshot;
  return persistedRates;
};

// Presentation/reporting uses the current shared rate table. Amounts already
// in the selected currency remain untouched, but a malformed persisted unit
// of account must never be relabelled as USD in a financial report.
const convertOrderAmount = async (order, amount, targetCurrency = 'USD') => {
  if (!isSupportedCurrency(targetCurrency)) {
    throw sellerSettlementError(
      'The requested reporting currency is unsupported.',
      'ORDER_CURRENCY_INVALID',
    );
  }
  return convertAmount(
    requireStoredOrderMoney(amount, 'order reporting amount'),
    getAccountingOrderCurrency(order, targetCurrency),
    normalizeCurrency(targetCurrency),
  );
};

// Settlement/refund accounting must use the rate captured when the buyer was
// charged so later FX movements cannot create or destroy seller balance.
const convertOrderAmountAtCheckout = async (order, amount, targetCurrency = 'USD') => {
  if (!isSupportedCurrency(targetCurrency)) {
    throw sellerSettlementError(
      'The requested accounting currency is unsupported.',
      'ORDER_CURRENCY_INVALID',
    );
  }
  const sourceCurrency = getAccountingOrderCurrency(order, targetCurrency);
  const storedAmount = requireStoredOrderMoney(amount, 'order accounting amount');
  if (sourceCurrency === normalizeCurrency(targetCurrency)) return storedAmount;
  const snapshotRates = getOrderExchangeRates(order);
  if (!snapshotRates) {
    throw sellerSettlementError(
      'A historical foreign-currency amount has no trusted checkout exchange-rate snapshot.',
      'SELLER_SETTLEMENT_HISTORICAL_RATE_MISSING',
    );
  }
  return convertAmountWithRates(storedAmount, sourceCurrency, targetCurrency, snapshotRates);
};

const convertOrderTotal = async (order, targetCurrency = 'USD') =>
  convertOrderAmount(
    order,
    requireStoredOrderMoney(order?.orderSummary?.totalAmount, 'order total'),
    targetCurrency,
  );

// Aggregate each source currency before conversion so many small orders do not
// lose (or gain) cents by being converted and rounded independently.
const sumOrderAmountsInCurrency = async (
  entries = [],
  targetCurrency = 'USD',
  { rateSnapshot = null, requireTrusted = true } = {},
) => {
  if (!isSupportedCurrency(targetCurrency)) {
    throw sellerSettlementError(
      'The requested reporting currency is unsupported.',
      'ORDER_CURRENCY_INVALID',
    );
  }
  const target = normalizeCurrency(targetCurrency);
  const liveBuckets = new Map();
  for (const entry of entries) {
    const amount = parseStrictFiniteNumber(entry?.amount);
    if (amount === null || amount < 0) {
      throw sellerSettlementError(
        'A stored reporting amount is invalid.',
        'ORDER_MONEY_INVALID',
      );
    }
    try {
      // Reports intentionally aggregate sub-cent values before rounding, but
      // they must still fit the supported six-decimal accounting range.
      toMinorUnits(amount, 6);
    } catch (_) {
      throw sellerSettlementError(
        'A stored reporting amount is outside the supported money range.',
        'ORDER_MONEY_INVALID',
      );
    }
    const source = getAccountingOrderCurrency(entry?.order, target);
    if (amount === 0) continue;
    if (!liveBuckets.has(source)) liveBuckets.set(source, []);
    liveBuckets.get(source).push(amount);
  }
  if (!liveBuckets.size) return 0;
  if ([...liveBuckets.keys()].every(source => source === target)) {
    return roundMoney(sumMoney([...liveBuckets.values()].flat(), 6));
  }
  const snapshot = await (rateSnapshot || getExchangeRateSnapshot());
  if (requireTrusted && snapshot?.fallback) {
    throw exchangeRatesUnavailableError();
  }
  const rates = normalizeRates(snapshot?.rates);
  if (!rates) throw exchangeRatesUnavailableError();
  const converted = allocateConvertedMinorUnitsByRates(
    [...liveBuckets.entries()].map(([source, sourceAmounts]) => ({
      key: source,
      amount: sumMoney(sourceAmounts, 6),
      sourceRate: rates[source],
    })),
    rates[target],
  );
  return fromMinorUnits(converted.totalMinorUnits);
};

// Seller-native reporting entries carry their own frozen source currency.
// Keeping this separate from order-currency reporting prevents a seller total
// from being reinterpreted as the buyer's currency before conversion.
const sumCurrencyAmountsInCurrency = async (
  entries = [],
  targetCurrency = 'USD',
  { rateSnapshot = null, requireTrusted = true } = {},
) => {
  if (!isSupportedCurrency(targetCurrency)) {
    throw sellerSettlementError('The requested reporting currency is unsupported.', 'ORDER_CURRENCY_INVALID');
  }
  const target = normalizeCurrency(targetCurrency);
  const buckets = new Map();
  for (const entry of entries) {
    const amount = parseStrictFiniteNumber(entry?.amount);
    if (amount === null || amount < 0) {
      throw sellerSettlementError('A stored reporting amount is invalid.', 'ORDER_MONEY_INVALID');
    }
    try {
      toMinorUnits(amount, 6);
    } catch (_) {
      throw sellerSettlementError('A stored reporting amount is outside the supported money range.', 'ORDER_MONEY_INVALID');
    }
    const source = requireCanonicalSellerCurrency(entry?.currency, 'reporting source currency');
    if (amount === 0) continue;
    if (!buckets.has(source)) buckets.set(source, []);
    buckets.get(source).push(amount);
  }
  if (!buckets.size) return 0;
  if ([...buckets.keys()].every(source => source === target)) {
    return roundMoney(sumMoney([...buckets.values()].flat(), 6));
  }
  const snapshot = await (rateSnapshot || getExchangeRateSnapshot());
  if (requireTrusted && snapshot?.fallback) throw exchangeRatesUnavailableError();
  const rates = normalizeRates(snapshot?.rates);
  if (!rates) throw exchangeRatesUnavailableError();
  const converted = allocateConvertedMinorUnitsByRates(
    [...buckets.entries()].map(([source, sourceAmounts]) => ({
      key: source,
      amount: sumMoney(sourceAmounts, 6),
      sourceRate: rates[source],
    })),
    rates[target],
  );
  return fromMinorUnits(converted.totalMinorUnits);
};

const sellerOrderSubtotal = (order, sellerProductIds, sellerId) => {
  const idSet = buildIdSet(sellerProductIds);
  return orderItemsSubtotal(order, item => (
    sellerId
      ? itemBelongsToSeller(item, sellerId, idSet)
      : idSet.has(toId(item?.productId))
  ));
};

const sellerOrderUnits = (order, sellerProductIds, sellerId) => {
  const idSet = buildIdSet(sellerProductIds);
  return (order?.orderItems || []).reduce((sum, item) => {
    const included = sellerId
      ? itemBelongsToSeller(item, sellerId, idSet)
      : idSet.has(toId(item?.productId));
    if (!included) return sum;
    if (!Number.isSafeInteger(item?.quantity) || item.quantity < 1) {
      throw sellerSettlementError('A stored order quantity is invalid.', 'ORDER_MONEY_INVALID');
    }
    const next = sum + item.quantity;
    if (!Number.isSafeInteger(next)) {
      throw sellerSettlementError('Stored order units are outside the supported range.', 'ORDER_MONEY_INVALID');
    }
    return next;
  }, 0);
};

const sellerShippingAmount = (order, sellerId) => {
  const sellerShipping = (order?.sellerShipping || []).find(
    ss => toId(ss.seller) === toId(sellerId)
  );
  return sellerShipping
    ? requireStoredOrderMoney(sellerShipping?.shippingMethod?.price, 'seller shipping line')
    : 0;
};

const sellerOrderSummaryForItems = (order, sellerId, sellerItems = []) => {
  if (!sellerItems.length) {
    return {
      itemCount: 0,
      units: 0,
      subtotal: 0,
      shippingCost: 0,
      shipping: 0,
      tax: 0,
      couponDiscount: 0,
      discount: 0,
      adjustment: 0,
      totalAmount: 0,
      total: 0,
    };
  }
  const allocations = buildOrderItemMoneyAllocations(order);
  const orderItems = order?.orderItems || [];
  const subtotal = sumAllocationForItems(allocations.subtotal, sellerItems, orderItems, allocations.itemKeys);
  const sellerShippingAllocations = buildSellerShippingAllocations(order);
  const hasSellerShippingAllocation = sellerShippingAllocations.has(toId(sellerId));
  const shipping = hasSellerShippingAllocation
    ? roundMoney(sellerShippingAllocations.get(toId(sellerId)) || 0)
    : sumAllocationForItems(allocations.shipping, sellerItems, orderItems, allocations.itemKeys);
  const tax = sumAllocationForItems(allocations.tax, sellerItems, orderItems, allocations.itemKeys);
  const discount = sumAllocationForItems(allocations.discount, sellerItems, orderItems, allocations.itemKeys);
  const adjustment = sumAllocationForItems(allocations.adjustment, sellerItems, orderItems, allocations.itemKeys);
  const total = sumOrderMoney(
    [subtotal, shipping, tax, -discount, adjustment],
    'seller order total',
  );
  if (total < 0) {
    throw sellerSettlementError(
      'The stored seller order total is negative and does not reconcile.',
      'ORDER_TOTAL_MISMATCH',
    );
  }
  const units = sellerItems.reduce((sum, item) => {
    if (!Number.isSafeInteger(item?.quantity) || item.quantity < 1) {
      throw sellerSettlementError('A stored order quantity is invalid.', 'ORDER_MONEY_INVALID');
    }
    const next = sum + item.quantity;
    if (!Number.isSafeInteger(next)) {
      throw sellerSettlementError('Stored order units are outside the supported range.', 'ORDER_MONEY_INVALID');
    }
    return next;
  }, 0);
  return {
    itemCount: sellerItems.length,
    units,
    subtotal,
    shippingCost: shipping,
    shipping,
    tax,
    couponDiscount: discount,
    discount,
    adjustment,
    totalAmount: total,
    total,
  };
};

const groupOrderItemsForSellerSettlement = (order, legacySellerByProduct = new Map()) => {
  const groups = new Map();
  let unresolvedItemCount = 0;
  for (const item of order?.orderItems || []) {
    const sellerId = toId(item?.seller)
      || legacySellerByProduct.get(toId(item?.productId))
      || '';
    if (!sellerId) {
      unresolvedItemCount += 1;
      continue;
    }
    if (!groups.has(sellerId)) groups.set(sellerId, []);
    groups.get(sellerId).push(item);
  }
  return { groups, unresolvedItemCount };
};

const normalizedSellerSettlementEntry = (entry, sourceCurrency) => {
  const seller = toId(entry?.seller);
  const rawEntryCurrency = entry?.sourceCurrency ?? sourceCurrency;
  const entryCurrency = normalizeCurrency(rawEntryCurrency);
  const sourceAmountMinor = entry?.sourceAmountMinor;
  const amountUSDMinor = entry?.amountUSDMinor;
  if (
    !seller
    || !isSupportedCurrency(rawEntryCurrency)
    || typeof rawEntryCurrency !== 'string'
    || rawEntryCurrency !== rawEntryCurrency.trim()
    || rawEntryCurrency !== entryCurrency
    || entryCurrency !== sourceCurrency
    || !Number.isSafeInteger(sourceAmountMinor)
    || sourceAmountMinor < 0
    || !Number.isSafeInteger(amountUSDMinor)
    || amountUSDMinor < 0
  ) {
    throw sellerSettlementError('The frozen seller settlement snapshot is malformed.');
  }
  return { seller, sourceCurrency, sourceAmountMinor, amountUSDMinor };
};

const assertSellerSettlementAllocations = (entries, sourceCurrency, rates) => {
  if (!entries.length) return entries;
  if (sourceCurrency === 'USD') {
    if (entries.some(entry => entry.sourceAmountMinor !== entry.amountUSDMinor)) {
      throw sellerSettlementError('The frozen USD seller settlement does not conserve cents.');
    }
    return entries;
  }
  const normalizedRates = normalizeRates(rates);
  if (!normalizedRates) {
    throw sellerSettlementError(
      'A foreign-currency seller settlement has no trusted checkout exchange-rate snapshot.',
      'SELLER_SETTLEMENT_EXCHANGE_RATE_MISSING',
    );
  }
  const expected = allocateConvertedMinorUnitsByRates(
    entries.map(entry => ({
      key: entry.seller,
      amount: fromMinorUnits(entry.sourceAmountMinor),
      sourceRate: normalizedRates[sourceCurrency],
    })),
    normalizedRates.USD,
  );
  for (const entry of entries) {
    if ((expected.allocations.get(entry.seller) || 0) !== entry.amountUSDMinor) {
      throw sellerSettlementError('The frozen seller settlement USD allocation does not conserve order cents.');
    }
  }
  return entries;
};

const getFrozenSellerSettlement = (order) => {
  const rawVersion = order?.sellerSettlementVersion;
  if (rawVersion === null || rawVersion === undefined || rawVersion === 0) return null;
  if (typeof rawVersion !== 'number' || rawVersion !== SELLER_SETTLEMENT_VERSION) {
    throw sellerSettlementError('The frozen seller settlement version is malformed.');
  }
  if (!Array.isArray(order?.sellerSettlement)) {
    throw sellerSettlementError('The versioned seller settlement snapshot is missing.');
  }
  const sourceCurrency = getAccountingOrderCurrency(order);
  const seenSellers = new Set();
  const entries = order.sellerSettlement.map(entry => {
    const normalized = normalizedSellerSettlementEntry(entry, sourceCurrency);
    if (seenSellers.has(normalized.seller)) {
      throw sellerSettlementError('The frozen seller settlement contains a duplicate seller.');
    }
    seenSellers.add(normalized.seller);
    return normalized;
  }).sort((left, right) => left.seller.localeCompare(right.seller));
  const sourceTotalMinor = sumOrderMinorUnits(
    entries.map(entry => entry.sourceAmountMinor),
    'frozen seller settlement source total',
  );
  const orderTotalMinor = toMinorUnits(requireStoredOrderMoney(
    order?.orderSummary?.totalAmount,
    'order total',
  ));
  if (sourceTotalMinor !== orderTotalMinor) {
    throw sellerSettlementError('The frozen seller settlement does not equal the exact order total.');
  }
  return assertSellerSettlementAllocations(entries, sourceCurrency, getOrderExchangeRates(order));
};

const buildOrderSellerSettlement = (
  order,
  {
    legacySellerByProduct = new Map(),
    requireOrderTotal = false,
  } = {},
) => {
  const sourceCurrency = getAccountingOrderCurrency(order);
  const { groups, unresolvedItemCount } = groupOrderItemsForSellerSettlement(
    order,
    legacySellerByProduct,
  );
  const shippingTotalMinor = toMinorUnits(orderShippingTotal(order));
  const explicitShippingRows = (order?.sellerShipping || [])
    .map((entry, index) => ({
      sellerId: toId(entry?.seller),
      amountMinor: toMinorUnits(requireStoredOrderMoney(
        entry?.shippingMethod?.price,
        `seller shipping line ${index + 1}`,
      )),
    }))
    .filter(row => row.amountMinor > 0);
  const explicitShippingMinor = sumOrderMinorUnits(
    explicitShippingRows.map(row => row.amountMinor),
    'seller shipping ownership total',
  );
  const primaryShippingSeller = toId(order?.shippingMethod?.seller);
  if (
    shippingTotalMinor > 0
    && (
      explicitShippingRows.some(row => !row.sellerId || !groups.has(row.sellerId))
      || (primaryShippingSeller && !groups.has(primaryShippingSeller))
      || (explicitShippingRows.length > 0 && explicitShippingMinor !== shippingTotalMinor)
      || (!explicitShippingRows.length && !primaryShippingSeller && groups.size > 1)
    )
  ) {
    throw sellerSettlementError(
      'A legacy multi-seller order has shipping with no durable seller owner.',
      'SELLER_SETTLEMENT_SHIPPING_OWNER_MISSING',
    );
  }
  const entries = [...groups.entries()]
    .map(([seller, items]) => ({
      seller,
      sourceCurrency,
      sourceAmountMinor: toMinorUnits(
        requireStoredOrderMoney(
          sellerOrderSummaryForItems(order, seller, items).total,
          `seller ${seller} settlement total`,
        ),
      ),
    }))
    // Keep zero-allocation sellers in the immutable ownership snapshot. A
    // fully discounted order (or one fully discounted seller in a mixed
    // order) still has inventory, fulfillment, return, cancellation, and
    // notification obligations even though its financial entitlement is 0.
    .sort((left, right) => left.seller.localeCompare(right.seller));
  const sourceTotalMinor = sumOrderMinorUnits(
    entries.map(entry => entry.sourceAmountMinor),
    'seller settlement source total',
  );
  const orderTotalMinor = toMinorUnits(requireStoredOrderMoney(
    order?.orderSummary?.totalAmount,
    'order total',
    { allowMissing: !requireOrderTotal },
  ));
  if (
    (requireOrderTotal || unresolvedItemCount === 0)
    && sourceTotalMinor !== orderTotalMinor
  ) {
    throw sellerSettlementError(
      'Seller entitlements do not add back to the exact order total.',
      'SELLER_SETTLEMENT_ORDER_TOTAL_MISMATCH',
    );
  }
  if (!entries.length) {
    if (orderTotalMinor > 0 && requireOrderTotal) {
      throw sellerSettlementError(
        'A positive order has no seller settlement owner.',
        'SELLER_SETTLEMENT_OWNER_MISSING',
      );
    }
    return [];
  }

  if (sourceCurrency === 'USD') {
    return entries.map(entry => ({ ...entry, amountUSDMinor: entry.sourceAmountMinor }));
  }
  const rates = getOrderExchangeRates(order);
  if (!rates) {
    throw sellerSettlementError(
      'A foreign-currency seller settlement requires trusted checkout exchange rates.',
      'SELLER_SETTLEMENT_EXCHANGE_RATE_MISSING',
    );
  }
  const allocated = allocateConvertedMinorUnitsByRates(
    entries.map(entry => ({
      key: entry.seller,
      amount: fromMinorUnits(entry.sourceAmountMinor),
      sourceRate: rates[sourceCurrency],
    })),
    rates.USD,
  );
  return entries.map(entry => ({
    ...entry,
    amountUSDMinor: allocated.allocations.get(entry.seller) || 0,
  }));
};

const requireCanonicalSellerCurrency = (value, label = 'seller currency') => {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value !== value.toUpperCase()
    || !isSupportedCurrency(value)
  ) {
    throw sellerSettlementError(`The stored ${label} is unsupported or malformed.`, 'SELLER_CURRENCY_MONEY_INVALID');
  }
  return value;
};

const requireStoredMinorUnits = (
  value,
  label,
  { signed = false } = {},
) => {
  if (!Number.isSafeInteger(value) || (!signed && value < 0)) {
    throw sellerSettlementError(`The stored ${label} is invalid.`, 'SELLER_CURRENCY_MONEY_INVALID');
  }
  try {
    fromMinorUnits(value);
  } catch (_) {
    throw sellerSettlementError(`The stored ${label} is outside the supported range.`, 'SELLER_CURRENCY_MONEY_INVALID');
  }
  return value;
};

const allocateFrozenAmountsToCurrency = (order, entries, targetCurrency) => {
  const target = requireCanonicalSellerCurrency(targetCurrency);
  const normalized = (entries || []).map((entry, index) => ({
    key: entry.key ?? `entry:${index}`,
    amount: requireStoredOrderMoney(entry.amount, `seller native source amount ${index + 1}`),
    sourceCurrency: requireCanonicalSellerCurrency(
      entry.sourceCurrency,
      `seller native source currency ${index + 1}`,
    ),
  }));
  if (!normalized.length) return new Map();
  if (normalized.every(entry => entry.sourceCurrency === target)) {
    return new Map(normalized.map(entry => [entry.key, entry.amount]));
  }
  const rates = getOrderExchangeRates(order);
  if (!rates) {
    throw sellerSettlementError(
      'A seller-native amount has no trusted checkout exchange-rate snapshot.',
      'SELLER_CURRENCY_EXCHANGE_RATE_MISSING',
    );
  }
  const allocated = allocateConvertedMinorUnitsByRates(
    normalized.map(entry => ({
      key: entry.key,
      amount: entry.amount,
      sourceRate: rates[entry.sourceCurrency],
    })),
    rates[target],
  );
  return new Map([...allocated.allocations].map(([key, minor]) => [key, fromMinorUnits(minor)]));
};

const sellerCurrencyForOrder = (order, sellerId, sellerItems = []) => {
  const sellerKey = toId(sellerId);
  const policy = (order?.sellerPolicies || []).find(entry => toId(entry?.seller) === sellerKey);
  if (policy?.productCurrency !== null && policy?.productCurrency !== undefined) {
    return requireCanonicalSellerCurrency(policy.productCurrency, 'seller policy product currency');
  }
  const shipping = (order?.sellerShipping || []).find(entry => toId(entry?.seller) === sellerKey);
  if (shipping?.shippingMethod?.sourceCurrency) {
    return requireCanonicalSellerCurrency(
      shipping.shippingMethod.sourceCurrency,
      'seller shipping source currency',
    );
  }
  const itemCurrencies = [...new Set((sellerItems || [])
    .map(item => item?.sourceCurrency ?? item?.priceCurrency)
    .filter(value => value !== null && value !== undefined)
    .map(value => requireCanonicalSellerCurrency(value, 'seller item source currency')))];
  if (itemCurrencies.length === 1) return itemCurrencies[0];
  if (itemCurrencies.length > 1) {
    throw sellerSettlementError(
      'A legacy seller order has mixed native currencies and no frozen store currency.',
      'SELLER_CURRENCY_SNAPSHOT_AMBIGUOUS',
    );
  }
  return getAccountingOrderCurrency(order);
};

const sellerCurrencyItemRows = (order, sellerItems, targetCurrency) => {
  const allItems = order?.orderItems || [];
  const itemKeys = buildOrderItemKeys(allItems);
  const rows = (sellerItems || []).map((item, fallbackIndex) => {
    const orderIndex = resolveOrderItemIndex(allItems, item, fallbackIndex);
    const key = orderItemKey(item, orderIndex, itemKeys);
    const sourceAmount = getOrderItemSourceLineSubtotal(item) ?? getOrderItemLineSubtotal(item);
    const sourceCurrency = requireCanonicalSellerCurrency(
      item?.sourceCurrency ?? item?.priceCurrency ?? getAccountingOrderCurrency(order),
      'seller item source currency',
    );
    return { key, item, orderIndex, sourceAmount, sourceCurrency };
  });
  const converted = allocateFrozenAmountsToCurrency(
    order,
    rows.map(row => ({ key: row.key, amount: row.sourceAmount, sourceCurrency: row.sourceCurrency })),
    targetCurrency,
  );
  return rows.map(row => ({
    ...row,
    targetAmount: converted.get(row.key) || 0,
  }));
};

const sellerNativeDiscount = (order, sellerId, sellerCurrency, buyerMoney) => {
  const sellerKey = toId(sellerId);
  const rows = (order?.appliedCoupons || [])
    .filter(coupon => toId(coupon?.seller) === sellerKey)
    .map((coupon, index) => {
      const hasNativeAmount = coupon?.sourceAppliedDiscountAmount !== null
        && coupon?.sourceAppliedDiscountAmount !== undefined;
      return {
        key: `coupon:${toId(coupon?.couponId) || index}`,
        amount: hasNativeAmount
          ? requireStoredOrderMoney(coupon.sourceAppliedDiscountAmount, 'seller native coupon discount')
          : requireStoredOrderMoney(coupon?.appliedDiscountAmount, 'seller buyer-currency coupon discount'),
        sourceCurrency: hasNativeAmount
          ? requireCanonicalSellerCurrency(coupon?.sourceCurrency, 'seller coupon source currency')
          : getAccountingOrderCurrency(order),
      };
    });
  if (!rows.length && buyerMoney.couponDiscount > 0) {
    rows.push({
      key: 'legacy-seller-discount',
      amount: buyerMoney.couponDiscount,
      sourceCurrency: getAccountingOrderCurrency(order),
    });
  }
  const converted = allocateFrozenAmountsToCurrency(order, rows, sellerCurrency);
  return sumOrderMoney([...converted.values()], 'seller native coupon discount');
};

const sellerNativeShipping = (order, sellerId, sellerCurrency, buyerMoney) => {
  const shipping = (order?.sellerShipping || []).find(
    entry => toId(entry?.seller) === toId(sellerId),
  );
  const hasSource = shipping?.shippingMethod?.sourceCost !== null
    && shipping?.shippingMethod?.sourceCost !== undefined;
  const amount = hasSource
    ? requireStoredOrderMoney(shipping.shippingMethod.sourceCost, 'seller native shipping')
    : buyerMoney.shippingCost;
  const sourceCurrency = hasSource
    ? requireCanonicalSellerCurrency(shipping.shippingMethod.sourceCurrency, 'seller shipping source currency')
    : getAccountingOrderCurrency(order);
  const converted = allocateFrozenAmountsToCurrency(
    order,
    [{ key: 'shipping', amount, sourceCurrency }],
    sellerCurrency,
  );
  return converted.get('shipping') || 0;
};

const sellerLedgerTotalInCurrency = (order, settlement, sellerCurrency) => {
  const buyerCurrency = getAccountingOrderCurrency(order);
  if (sellerCurrency === buyerCurrency) return fromMinorUnits(settlement.sourceAmountMinor);
  if (sellerCurrency === 'USD') return fromMinorUnits(settlement.amountUSDMinor);
  const converted = allocateFrozenAmountsToCurrency(
    order,
    [{ key: 'total', amount: fromMinorUnits(settlement.amountUSDMinor), sourceCurrency: 'USD' }],
    sellerCurrency,
  );
  return converted.get('total') || 0;
};

const buildSellerCurrencyMoneyEntry = (order, sellerId, sellerItems = []) => {
  const sellerKey = toId(sellerId);
  if (!sellerKey || !sellerItems.length) {
    throw sellerSettlementError('Seller-native money requires an owned order line.', 'SELLER_CURRENCY_MONEY_INVALID');
  }
  const frozenSettlement = getFrozenSellerSettlement(order);
  const settlement = (frozenSettlement || []).find(entry => entry.seller === sellerKey);
  if (!settlement) {
    throw sellerSettlementError(
      'Seller-native money requires a frozen seller settlement.',
      'SELLER_CURRENCY_SETTLEMENT_MISSING',
    );
  }
  const buyerCurrency = getAccountingOrderCurrency(order);
  const currency = sellerCurrencyForOrder(order, sellerKey, sellerItems);
  const buyerMoney = sellerOrderSummaryForItems(order, sellerKey, sellerItems);
  if (toMinorUnits(buyerMoney.totalAmount) !== settlement.sourceAmountMinor) {
    throw sellerSettlementError(
      'Seller-native money does not reconcile with the frozen buyer-currency allocation.',
      'SELLER_CURRENCY_MONEY_INVALID',
    );
  }
  const itemRows = sellerCurrencyItemRows(order, sellerItems, currency);
  const subtotal = sumOrderMoney(itemRows.map(row => row.targetAmount), 'seller native subtotal');
  const shipping = sellerNativeShipping(order, sellerKey, currency, buyerMoney);
  const tax = (allocateFrozenAmountsToCurrency(
    order,
    [{ key: 'tax', amount: buyerMoney.tax, sourceCurrency: buyerCurrency }],
    currency,
  ).get('tax') || 0);
  const discount = sellerNativeDiscount(order, sellerKey, currency, buyerMoney);
  const total = sellerLedgerTotalInCurrency(order, settlement, currency);
  const adjustment = sumOrderMoney(
    [total, -subtotal, -shipping, -tax, discount],
    'seller native reconciliation adjustment',
  );
  return {
    seller: sellerKey,
    currency,
    buyerCurrency,
    subtotalMinor: toMinorUnits(subtotal),
    shippingMinor: toMinorUnits(shipping),
    taxMinor: toMinorUnits(tax),
    discountMinor: toMinorUnits(discount),
    adjustmentMinor: toMinorUnits(Math.abs(adjustment)) * (adjustment < 0 ? -1 : 1),
    totalMinor: toMinorUnits(total),
    buyerTotalMinor: settlement.sourceAmountMinor,
  };
};

const buildOrderSellerCurrencyMoney = (order) => {
  const settlement = getFrozenSellerSettlement(order);
  if (!settlement) {
    throw sellerSettlementError('Seller-native money requires a frozen seller settlement.');
  }
  const { groups, unresolvedItemCount } = groupOrderItemsForSellerSettlement(order);
  if (unresolvedItemCount > 0) {
    throw sellerSettlementError(
      'Seller-native money cannot resolve one or more seller-owned lines.',
      'SELLER_CURRENCY_OWNER_MISSING',
    );
  }
  return settlement.map(entry => buildSellerCurrencyMoneyEntry(
    order,
    entry.seller,
    groups.get(entry.seller) || [],
  ));
};

const normalizedSellerCurrencyMoneyEntry = (entry, buyerCurrency) => {
  const normalized = {
    seller: toId(entry?.seller),
    currency: requireCanonicalSellerCurrency(entry?.currency),
    buyerCurrency: requireCanonicalSellerCurrency(entry?.buyerCurrency, 'seller buyer currency'),
    subtotalMinor: requireStoredMinorUnits(entry?.subtotalMinor, 'seller native subtotal'),
    shippingMinor: requireStoredMinorUnits(entry?.shippingMinor, 'seller native shipping'),
    taxMinor: requireStoredMinorUnits(entry?.taxMinor, 'seller native tax'),
    discountMinor: requireStoredMinorUnits(entry?.discountMinor, 'seller native discount'),
    adjustmentMinor: requireStoredMinorUnits(entry?.adjustmentMinor, 'seller native adjustment', { signed: true }),
    totalMinor: requireStoredMinorUnits(entry?.totalMinor, 'seller native total'),
    buyerTotalMinor: requireStoredMinorUnits(entry?.buyerTotalMinor, 'seller buyer-currency total'),
  };
  if (!normalized.seller || normalized.buyerCurrency !== buyerCurrency) {
    throw sellerSettlementError('The frozen seller-native money identity is malformed.', 'SELLER_CURRENCY_MONEY_INVALID');
  }
  const calculated = BigInt(normalized.subtotalMinor)
    + BigInt(normalized.shippingMinor)
    + BigInt(normalized.taxMinor)
    - BigInt(normalized.discountMinor)
    + BigInt(normalized.adjustmentMinor);
  if (calculated !== BigInt(normalized.totalMinor)) {
    throw sellerSettlementError('The frozen seller-native money components do not reconcile.', 'SELLER_CURRENCY_MONEY_INVALID');
  }
  return normalized;
};

const getFrozenSellerCurrencyMoney = (order) => {
  const version = order?.sellerCurrencyMoneyVersion;
  if (version === null || version === undefined || version === 0) return null;
  if (version !== SELLER_CURRENCY_MONEY_VERSION || !Array.isArray(order?.sellerCurrencyMoney)) {
    throw sellerSettlementError('The frozen seller-native money snapshot is malformed.', 'SELLER_CURRENCY_MONEY_INVALID');
  }
  const buyerCurrency = getAccountingOrderCurrency(order);
  const settlement = getFrozenSellerSettlement(order);
  if (!settlement) {
    throw sellerSettlementError('The seller-native snapshot has no seller settlement.', 'SELLER_CURRENCY_MONEY_INVALID');
  }
  const seen = new Set();
  const entries = order.sellerCurrencyMoney.map(entry => {
    const normalized = normalizedSellerCurrencyMoneyEntry(entry, buyerCurrency);
    if (seen.has(normalized.seller)) {
      throw sellerSettlementError('The seller-native snapshot contains a duplicate seller.', 'SELLER_CURRENCY_MONEY_INVALID');
    }
    seen.add(normalized.seller);
    const ledger = settlement.find(candidate => candidate.seller === normalized.seller);
    if (!ledger || ledger.sourceAmountMinor !== normalized.buyerTotalMinor) {
      throw sellerSettlementError('The seller-native snapshot disagrees with the frozen settlement.', 'SELLER_CURRENCY_MONEY_INVALID');
    }
    const expectedTotal = sellerLedgerTotalInCurrency(order, ledger, normalized.currency);
    if (toMinorUnits(expectedTotal) !== normalized.totalMinor) {
      throw sellerSettlementError('The seller-native total disagrees with the frozen settlement rate.', 'SELLER_CURRENCY_MONEY_INVALID');
    }
    return normalized;
  }).sort((left, right) => left.seller.localeCompare(right.seller));
  if (
    entries.length !== settlement.length
    || settlement.some(entry => !seen.has(entry.seller))
  ) {
    throw sellerSettlementError('The seller-native snapshot does not cover every seller.', 'SELLER_CURRENCY_MONEY_INVALID');
  }
  return entries;
};

// Notification delivery and other total-only consumers must not reconstruct a
// complete item allocation for legacy orders. Older rows can contain an
// authoritative seller settlement while lacking the newer per-line snapshots.
// The frozen settlement plus frozen checkout rates is sufficient to present
// the seller's total safely; detailed seller views continue to use the stricter
// sellerCurrencyMoneyPresentation path below.
const sellerCurrencyTotalEntry = (order, sellerId, sellerItems = []) => {
  const sellerKey = toId(sellerId);
  const frozen = getFrozenSellerCurrencyMoney(order);
  const frozenEntry = frozen?.find(candidate => candidate.seller === sellerKey);
  if (frozenEntry) return { ...frozenEntry, persisted: true };

  const settlement = getFrozenSellerSettlement(order);
  const ledger = settlement?.find(candidate => candidate.seller === sellerKey);
  if (!sellerKey || !ledger) return null;

  const currency = sellerCurrencyForOrder(order, sellerKey, sellerItems);
  return {
    seller: sellerKey,
    currency,
    buyerCurrency: getAccountingOrderCurrency(order),
    totalMinor: toMinorUnits(sellerLedgerTotalInCurrency(order, ledger, currency)),
    buyerTotalMinor: ledger.sourceAmountMinor,
    persisted: false,
  };
};

const sellerCurrencyMoneyPresentation = (order, sellerId, sellerItems = []) => {
  const sellerKey = toId(sellerId);
  const frozen = getFrozenSellerCurrencyMoney(order);
  const entry = frozen?.find(candidate => candidate.seller === sellerKey)
    || (!frozen && getFrozenSellerSettlement(order)
      ? buildSellerCurrencyMoneyEntry(order, sellerKey, sellerItems)
      : null);
  if (!entry) return null;
  const buyerMoney = sellerOrderSummaryForItems(order, sellerKey, sellerItems);
  const itemRows = sellerCurrencyItemRows(order, sellerItems, entry.currency);
  if (toMinorUnits(sumOrderMoney(itemRows.map(row => row.targetAmount), 'seller item native total')) !== entry.subtotalMinor) {
    throw sellerSettlementError('Seller-native item lines do not equal the frozen subtotal.', 'SELLER_CURRENCY_MONEY_INVALID');
  }
  const rates = getOrderExchangeRates(order);
  const exchangeRate = entry.currency === entry.buyerCurrency
    ? 1
    : rates
      ? rates[entry.buyerCurrency] / rates[entry.currency]
      : null;
  if (entry.currency !== entry.buyerCurrency && (!Number.isFinite(exchangeRate) || exchangeRate <= 0)) {
    throw sellerSettlementError('The frozen seller display exchange rate is unavailable.', 'SELLER_CURRENCY_EXCHANGE_RATE_MISSING');
  }
  return {
    version: SELLER_CURRENCY_MONEY_VERSION,
    persisted: Boolean(frozen),
    currency: entry.currency,
    buyerCurrency: entry.buyerCurrency,
    summary: {
      subtotal: fromMinorUnits(entry.subtotalMinor),
      shippingCost: fromMinorUnits(entry.shippingMinor),
      tax: fromMinorUnits(entry.taxMinor),
      couponDiscount: fromMinorUnits(entry.discountMinor),
      reconciliationAdjustment: fromMinorUnits(entry.adjustmentMinor),
      totalAmount: fromMinorUnits(entry.totalMinor),
    },
    buyerSummary: {
      subtotal: buyerMoney.subtotal,
      shippingCost: buyerMoney.shippingCost,
      tax: buyerMoney.tax,
      couponDiscount: buyerMoney.couponDiscount,
      reconciliationAdjustment: buyerMoney.adjustment,
      totalAmount: buyerMoney.totalAmount,
    },
    exchangeRate: {
      from: entry.currency,
      to: entry.buyerCurrency,
      rate: exchangeRate,
      capturedAt: order?.exchangeRateSnapshot?.capturedAt || null,
      source: order?.exchangeRateSnapshot?.source || '',
      frozen: true,
    },
    itemMoney: itemRows.map((row, sellerItemIndex) => ({
      sellerItemIndex,
      orderItemKey: row.key,
      orderItemIndex: row.orderIndex,
      currency: entry.currency,
      lineSubtotal: row.targetAmount,
      buyerCurrency: entry.buyerCurrency,
      buyerLineSubtotal: getOrderItemLineSubtotal(row.item),
      originalCurrency: row.sourceCurrency,
      originalLineSubtotal: row.sourceAmount,
      originalUnitPrice: row.item?.sourcePrice ?? row.item?.priceOriginal ?? null,
    })),
  };
};

const buildSellerCurrencyItemMoneyAllocations = (order, sellerId, sellerItems = []) => {
  const presentation = sellerCurrencyMoneyPresentation(order, sellerId, sellerItems);
  if (!presentation) return null;
  const weights = presentation.itemMoney.map(item => ({
    key: item.orderItemKey,
    weight: item.lineSubtotal,
  }));
  return {
    currency: presentation.currency,
    itemKeys: buildOrderItemKeys(order?.orderItems || []),
    total: allocateRoundedAmount(presentation.summary.totalAmount, weights),
    presentation,
  };
};

const ensureOrderSellerSettlement = async (
  order,
  { session = null, requireOrderTotal = false, rateSnapshot = null } = {},
) => {
  const existing = getFrozenSellerSettlement(order);
  if (existing) return existing;
  if (!order?._id) {
    throw sellerSettlementError('The order must be persisted before its seller settlement can be frozen.');
  }

  if (getAccountingOrderCurrency(order) !== 'USD' && !getOrderExchangeRates(order)) {
    // `rateSnapshot` is deliberately ignored here. It represents the current
    // request's live table, not evidence of the historical checkout rate.
    // Quarantine the order until an explicit audited backfill stores a rate.
    void rateSnapshot;
    throw sellerSettlementError(
      'This legacy foreign-currency order has no checkout exchange-rate snapshot and requires an audited backfill.',
      'SELLER_SETTLEMENT_HISTORICAL_RATE_MISSING',
    );
  }

  const missingProductIds = (order.orderItems || [])
    .filter(item => !toId(item?.seller) && toId(item?.productId))
    .map(item => item.productId);
  const legacySellerByProduct = new Map();
  if (missingProductIds.length) {
    const Product = require('../models/Product');
    const query = Product.find({ _id: { $in: missingProductIds } }).select('_id seller').lean();
    if (session) query.session(session);
    const products = await query;
    products.forEach(product => legacySellerByProduct.set(toId(product._id), toId(product.seller)));
  }
  const settlement = buildOrderSellerSettlement(order, {
    legacySellerByProduct,
    requireOrderTotal,
  });

  const Order = require('../models/Order');
  const updatedQuery = Order.findOneAndUpdate(
    {
      _id: order._id,
      $or: [
        { sellerSettlementVersion: { $exists: false } },
        { sellerSettlementVersion: { $lt: SELLER_SETTLEMENT_VERSION } },
      ],
    },
    {
      $set: {
        sellerSettlementVersion: SELLER_SETTLEMENT_VERSION,
        sellerSettlement: settlement,
      },
    },
    {
      new: true,
      runValidators: true,
      overwriteImmutable: true,
      ...(session ? { session } : {}),
    },
  );
  const updated = await updatedQuery;
  if (updated) {
    return getFrozenSellerSettlement(updated);
  }

  const currentQuery = Order.findById(order._id);
  if (session) currentQuery.session(session);
  const current = await currentQuery;
  const frozen = getFrozenSellerSettlement(current);
  if (!frozen) {
    throw sellerSettlementError('The seller settlement could not be frozen safely.');
  }
  return frozen;
};

const sellerSettlementEntry = (entries, sellerId) => (
  (entries || []).find(entry => toId(entry?.seller) === toId(sellerId)) || null
);

const multiplyDivideAndRoundMinor = (amountMinor, numerator, denominator) => {
  const parsedAmount = amountMinor;
  const parsedNumerator = numerator;
  const parsedDenominator = denominator;
  if (
    typeof parsedAmount !== 'number'
    || typeof parsedNumerator !== 'number'
    || typeof parsedDenominator !== 'number'
    || !Number.isSafeInteger(parsedAmount)
    || !Number.isSafeInteger(parsedNumerator)
    || !Number.isSafeInteger(parsedDenominator)
    || parsedAmount < 0
    || parsedNumerator < 0
    || parsedDenominator < 0
  ) {
    throw sellerSettlementError('The seller settlement ratio is malformed.');
  }
  const amount = BigInt(parsedAmount);
  const top = BigInt(parsedNumerator);
  const bottom = BigInt(parsedDenominator);
  if (bottom <= 0n || amount <= 0n || top <= 0n) return 0;
  const product = amount * (top > bottom ? bottom : top);
  const rounded = (product * 2n + bottom) / (bottom * 2n);
  const numeric = Number(rounded);
  if (!Number.isSafeInteger(numeric)) {
    throw sellerSettlementError('The seller settlement allocation is too large.');
  }
  return numeric;
};

const sellerSettlementUsdTargetForSource = (entry, cumulativeSourceMinor) => {
  if (!entry) {
    throw sellerSettlementError('A seller settlement entry is required for cumulative allocation.');
  }
  const fullSourceMinor = entry.sourceAmountMinor;
  const fullUsdMinor = entry.amountUSDMinor;
  const requestedSourceMinor = cumulativeSourceMinor;
  if (
    typeof fullSourceMinor !== 'number'
    || typeof fullUsdMinor !== 'number'
    || typeof requestedSourceMinor !== 'number'
    || !Number.isSafeInteger(fullSourceMinor)
    || !Number.isSafeInteger(fullUsdMinor)
    || !Number.isSafeInteger(requestedSourceMinor)
    || fullSourceMinor < 0
    || fullUsdMinor < 0
    || requestedSourceMinor < 0
  ) {
    throw sellerSettlementError('The cumulative seller settlement target is malformed.');
  }
  const sourceTarget = Math.min(
    fullSourceMinor,
    requestedSourceMinor,
  );
  if (sourceTarget >= fullSourceMinor) return fullUsdMinor;
  return multiplyDivideAndRoundMinor(
    fullUsdMinor,
    sourceTarget,
    fullSourceMinor,
  );
};

const allocateSellerSettlementUsdTargets = ({
  settlementEntries = [],
  sourceTargets = new Map(),
}) => {
  // Cumulative risk exposure must be monotonic for every seller. Re-running a
  // largest-remainder FX allocation at each partial refund can trigger the
  // Alabama paradox: increasing the overall refund makes one seller lose a
  // previously debited cent. Anchor each seller to its frozen full-order USD
  // entitlement instead. This is monotonic, capped, replay-stable, and reaches
  // the exact frozen cent allocation when that seller is fully reversed.
  return new Map(settlementEntries
    .map(entry => {
      const seller = toId(entry?.seller);
      const rawTarget = sourceTargets.get(seller);
      const target = rawTarget ?? 0;
      if (typeof target !== 'number' || !Number.isSafeInteger(target) || target < 0) {
        throw sellerSettlementError('The cumulative seller reversal target is malformed.');
      }
      return [seller, sellerSettlementUsdTargetForSource(entry, target)];
    })
    .sort(([left], [right]) => left.localeCompare(right)));
};

const sellerOrderSummary = (order, sellerProductIds, sellerId) => {
  const idSet = buildIdSet(sellerProductIds);
  const sellerItems = (order?.orderItems || []).filter(item => (
    sellerId
      ? itemBelongsToSeller(item, sellerId, idSet)
      : idSet.has(toId(item?.productId))
  ));
  return sellerOrderSummaryForItems(order, sellerId, sellerItems);
};

const sellerOrderSummaryInCurrency = async (order, sellerProductIds, sellerId, targetCurrency = 'USD') => {
  const summary = sellerOrderSummary(order, sellerProductIds, sellerId);
  const [subtotal, shippingCost, tax, couponDiscount, adjustment, totalAmount] = await Promise.all([
    convertOrderAmount(order, summary.subtotal, targetCurrency),
    convertOrderAmount(order, summary.shippingCost, targetCurrency),
    convertOrderAmount(order, summary.tax, targetCurrency),
    convertOrderAmount(order, summary.couponDiscount, targetCurrency),
    convertOrderAmount(order, summary.adjustment, targetCurrency),
    convertOrderAmount(order, summary.totalAmount, targetCurrency),
  ]);

  return { subtotal, shippingCost, tax, couponDiscount, adjustment, totalAmount };
};

const sellerFulfillmentStatus = (order, sellerId) => {
  const fulfillment = (order?.sellerFulfillment || []).find(
    entry => toId(entry?.seller) === toId(sellerId)
  );
  return fulfillment?.status || order?.orderStatus || 'pending';
};

const isSellerOrderLive = (order, sellerId) => (
  order?.awaitingPayment !== true
  && order?.orderStatus !== 'cancelled'
  && sellerFulfillmentStatus(order, sellerId) !== 'cancelled'
);

const isSellerOrderDelivered = (order, sellerId) => (
  sellerFulfillmentStatus(order, sellerId) === 'delivered'
  || (!(order?.sellerFulfillment || []).length && order?.isDelivered === true)
);

// Online sales are recognized only after payment confirmation. COD revenue is
// recognized only after this seller's fulfillment is delivered/collected.
const isSellerRevenueRecognized = (order, sellerId) => {
  if (!isSellerOrderLive(order, sellerId)) return false;
  const method = order?.paymentMethod || 'cash_on_delivery';
  if (method === 'cash_on_delivery') return isSellerOrderDelivered(order, sellerId);
  if (method === 'stripe' || method === 'wallet') return order?.isPaid === true;
  return false;
};

const formatOrderMoney = (amount, currency) => {
  const storedCurrency = getAccountingOrderCurrency({ currency });
  return formatMoneySync(
    requireStoredOrderMoney(amount, 'order presentation amount'),
    storedCurrency,
    { sourceCurrency: storedCurrency },
  );
};

module.exports = {
  roundMoney,
  toId,
  getOrderCurrency,
  getAccountingOrderCurrency,
  requireStoredOrderMoney,
  getRequestedCurrency,
  resolveRequestedCurrency,
  lineTotal,
  buildOrderItemKeys,
  orderItemKey,
  allocateRoundedAmount,
  sumAllocationForItems,
  buildOrderItemTaxAllocations,
  orderShippingTotal,
  buildSellerShippingAllocations,
  buildOrderItemShippingAllocations,
  buildOrderItemMoneyAllocations,
  itemBelongsToSeller,
  orderItemsSubtotal,
  orderSubtotal,
  convertOrderAmount,
  convertOrderAmountAtCheckout,
  convertOrderTotal,
  getOrderExchangeRates,
  ensureOrderExchangeRateSnapshot,
  sumOrderAmountsInCurrency,
  sumCurrencyAmountsInCurrency,
  sellerOrderSubtotal,
  sellerOrderUnits,
  sellerShippingAmount,
  sellerOrderSummaryForItems,
  sellerOrderSummary,
  sellerOrderSummaryInCurrency,
  sellerFulfillmentStatus,
  isSellerOrderLive,
  isSellerOrderDelivered,
  isSellerRevenueRecognized,
  formatOrderMoney,
  SELLER_SETTLEMENT_VERSION,
  SELLER_CURRENCY_MONEY_VERSION,
  sellerSettlementError,
  getFrozenSellerSettlement,
  buildOrderSellerSettlement,
  buildSellerCurrencyMoneyEntry,
  buildOrderSellerCurrencyMoney,
  getFrozenSellerCurrencyMoney,
  sellerCurrencyTotalEntry,
  sellerCurrencyMoneyPresentation,
  buildSellerCurrencyItemMoneyAllocations,
  ensureOrderSellerSettlement,
  sellerSettlementEntry,
  sellerSettlementUsdTargetForSource,
  allocateSellerSettlementUsdTargets,
};
