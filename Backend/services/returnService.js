'use strict';

const crypto = require('crypto');
const ReturnRequest = require('../models/ReturnRequest');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Store = require('../models/Store');
const User = require('../models/User');
const SellerBalanceTransaction = require('../models/SellerBalanceTransaction');
const SellerSettlementLock = require('../models/SellerSettlementLock');
const { stripe, STRIPE_MODE } = require('../config/stripe');
const { isSupportedCurrency, normalizeCurrency } = require('./currencyService');
const {
  normalizeReturnPolicy,
  returnEligibilityDeadline,
  canTransitionReturnStatus,
} = require('./returnPolicyService');
const {
  runInTransaction,
  creditWalletInSession,
  roundMoney,
} = require('./walletService');
const {
  claimStripePaymentCompletion,
  markStripePaymentCompletionDone,
} = require('./stripePaymentRiskMarkerService');
const {
  attachReturnedWalletFundingProvenance,
  assertWalletOrderFundingReturnable,
} = require('./walletOrderFundingRiskService');
const { buildOrderItemDiscountAllocations } = require('./orderDiscountService');
const {
  buildOrderItemMoneyAllocations,
  SELLER_SETTLEMENT_VERSION,
  ensureOrderSellerSettlement,
  getAccountingOrderCurrency,
  sellerSettlementEntry,
  sellerSettlementUsdTargetForSource,
  sellerOrderSummaryForItems,
} = require('./orderMoneyService');
const {
  allocateOrderLineAmountForQuantity,
  getOrderItemLineSubtotal,
} = require('./orderLinePricingService');
const { fromMinorUnits, sumMoney, toMinorUnits } = require('./moneyMath');
const { parsePositiveSafeInteger } = require('./numericInputService');
const {
  isAuthoritativeStripeIdempotentReplayRejection,
  isDefinitiveStripeCreationError,
} = require('./stripePaymentIntentFactory');
const {
  enqueueReturnSettlementNotifications,
} = require('./financialNotificationOutboxService');
const {
  enqueueReturnSafetyRefundSellerNotification,
} = require('./stripePaymentRiskNotificationService');
const {
  enqueueReturnCancellationNotifications,
  notifyBuyerReturnStatus,
  notifySellerReturnRequested,
} = require('./returnNotificationService');

const CLOSED_WITHOUT_CONSUMING_QUANTITY = ['rejected', 'cancelled_by_buyer'];
const BUYER_CANCELLABLE_STATUSES = ['requested', 'approved', 'pickup_scheduled'];
const UNRESOLVED_RETURN_STATUSES = [
  'requested',
  'approved',
  'pickup_scheduled',
  'picked_up',
  'in_transit_to_seller',
  'received_by_seller',
  'under_review',
  'accepted_pending_payment',
];
const REASON_CATEGORIES = [
  'damaged',
  'defective',
  'wrong_item',
  'not_as_described',
  'size_or_fit',
  'changed_mind',
  'other',
];

const toId = (value) => value?._id?.toString?.() || value?.toString?.() || '';
const queryWithSession = (query, session) => (
  session && typeof query?.session === 'function' ? query.session(session) : query
);
const cleanNote = (value, max = 1000) => String(value || '').trim().slice(0, max);
const RETURN_REQUEST_KEY_MIN_LENGTH = 16;
const RETURN_REQUEST_KEY_MAX_LENGTH = 256;

const returnRequestInputError = (message, code) => {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
};

const normalizeReturnRequestKey = (requestKey) => {
  if (typeof requestKey !== 'string' || !requestKey.trim()) {
    throw returnRequestInputError(
      'A reusable Idempotency-Key is required to create a return request.',
      'RETURN_IDEMPOTENCY_KEY_REQUIRED',
    );
  }
  const normalized = requestKey.trim();
  if (
    normalized !== requestKey
    || normalized.length < RETURN_REQUEST_KEY_MIN_LENGTH
    || normalized.length > RETURN_REQUEST_KEY_MAX_LENGTH
    || !/^[A-Za-z0-9._:-]+$/u.test(normalized)
  ) {
    throw returnRequestInputError(
      `Idempotency-Key must be ${RETURN_REQUEST_KEY_MIN_LENGTH}-${RETURN_REQUEST_KEY_MAX_LENGTH} URL-safe characters without surrounding whitespace.`,
      'RETURN_IDEMPOTENCY_KEY_INVALID',
    );
  }
  return normalized;
};

const returnRequestStorageKey = (buyerId, requestKey) => (
  `return:v2:${toId(buyerId)}:${crypto.createHash('sha256').update(requestKey, 'utf8').digest('hex')}`
);

const normalizeReturnCreationInput = ({
  orderId,
  buyerId,
  sellerId,
  items,
  reasonCategory,
  reasonDetails,
  requestKey,
}) => {
  const normalizedRequestKey = normalizeReturnRequestKey(requestKey);
  if (!REASON_CATEGORIES.includes(reasonCategory)) {
    throw returnRequestInputError('Choose a valid return reason.', 'INVALID_RETURN_REASON');
  }
  const cleanReason = cleanNote(reasonDetails, 1500);
  if (cleanReason.length < 10) {
    throw returnRequestInputError(
      'Please explain the return reason in at least 10 characters.',
      'RETURN_REASON_TOO_SHORT',
    );
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw returnRequestInputError('Select at least one item to return.', 'RETURN_ITEMS_REQUIRED');
  }

  const normalizedItems = items.map((requested) => ({
    orderItemId: toId(requested?.orderItemId),
    quantity: parsePositiveSafeInteger(requested?.quantity),
  }));
  const seen = new Set();
  if (normalizedItems.some(({ orderItemId, quantity }) => (
    !orderItemId || quantity === null || seen.has(orderItemId) || !seen.add(orderItemId)
  ))) {
    throw returnRequestInputError(
      'Return items must contain unique order item IDs and positive quantities.',
      'RETURN_ITEMS_INVALID',
    );
  }
  normalizedItems.sort((left, right) => left.orderItemId.localeCompare(right.orderItemId));

  const fingerprintPayload = {
    version: 1,
    orderId: toId(orderId),
    buyerId: toId(buyerId),
    sellerId: toId(sellerId),
    items: normalizedItems,
    reasonCategory,
    reasonDetails: cleanReason,
  };
  return {
    ...fingerprintPayload,
    requestKey: returnRequestStorageKey(buyerId, normalizedRequestKey),
    requestFingerprint: crypto
      .createHash('sha256')
      .update(JSON.stringify(fingerprintPayload), 'utf8')
      .digest('hex'),
  };
};

const idempotencyConflict = () => {
  const error = new Error('This return Idempotency-Key was already used for a different request.');
  error.statusCode = 409;
  error.code = 'RETURN_IDEMPOTENCY_CONFLICT';
  return error;
};

const assertReturnReplayMatches = (existing, requestFingerprint) => {
  if (!existing?.requestFingerprint) {
    const error = new Error(
      'This legacy return retry key has no request fingerprint and requires support review before replay.',
    );
    error.statusCode = 409;
    error.code = 'RETURN_IDEMPOTENCY_LEGACY_RECOVERY_REQUIRED';
    throw error;
  }
  if (existing.requestFingerprint !== requestFingerprint) throw idempotencyConflict();
  existing.$locals = existing.$locals || {};
  existing.$locals.idempotencyReplay = true;
  return existing;
};

const returnFinancialDataError = (message, code = 'RETURN_FINANCIAL_DATA_INVALID') => {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = code;
  return error;
};

const requireStoredReturnCurrency = value => {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || !isSupportedCurrency(value)
    || value !== normalizeCurrency(value)
  ) {
    throw returnFinancialDataError(
      'The stored return currency is unsupported or malformed.',
      'RETURN_CURRENCY_INVALID',
    );
  }
  return value;
};

const requireExactReturnMoney = (value, label, { positive = false } = {}) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (positive && value === 0)) {
    throw returnFinancialDataError(`The stored ${label} is invalid.`);
  }
  try {
    if (roundMoney(value) !== value) {
      throw returnFinancialDataError(`The stored ${label} is not an exact cent amount.`);
    }
    toMinorUnits(value);
  } catch (error) {
    if (error?.code === 'RETURN_FINANCIAL_DATA_INVALID') throw error;
    throw returnFinancialDataError(`The stored ${label} is outside the supported money range.`);
  }
  return value;
};

const requireStoredReturnQuantity = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw returnFinancialDataError(`The stored ${label} is invalid.`);
  }
  return value;
};

const makeReturnNumber = () =>
  `RET-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

const getItemSellerMap = async (order, session = null) => {
  const result = new Map();
  const missingProductIds = [];

  for (const item of order.orderItems || []) {
    const orderItemId = toId(item._id);
    const sellerId = toId(item.seller);
    if (sellerId) result.set(orderItemId, sellerId);
    else if (item.productId) missingProductIds.push(item.productId);
  }

  if (missingProductIds.length) {
    const products = await queryWithSession(
      Product.find({ _id: { $in: missingProductIds } }).select('_id seller').lean(),
      session
    );
    const sellerByProduct = new Map(products.map(product => [toId(product._id), toId(product.seller)]));
    for (const item of order.orderItems || []) {
      if (!result.has(toId(item._id))) {
        result.set(toId(item._id), sellerByProduct.get(toId(item.productId)) || '');
      }
    }
  }

  return result;
};

const getSellerFulfillment = (order, sellerId) => {
  const entry = (order.sellerFulfillment || []).find(item => toId(item.seller) === toId(sellerId));
  if (entry) {
    return {
      status: entry.status || 'pending',
      deliveredAt: entry.deliveredAt || null,
    };
  }

  return {
    status: order.orderStatus || 'pending',
    deliveredAt: order.deliveredAt || (order.orderStatus === 'delivered' ? order.updatedAt : null),
  };
};

const getSellerPolicy = async (order, sellerId, session = null) => {
  const snapshot = (order.sellerPolicies || []).find(item => toId(item.seller) === toId(sellerId));
  if (snapshot?.returnPolicy) {
    return {
      storeId: snapshot.store || null,
      storeName: snapshot.storeName || '',
      policy: normalizeReturnPolicy(snapshot.returnPolicy),
      source: 'order_snapshot',
    };
  }

  const store = await queryWithSession(
    Store.findOne({ seller: sellerId }).select('_id storeName returnPolicy').lean(),
    session
  );
  return {
    storeId: store?._id || null,
    storeName: store?.storeName || '',
    policy: normalizeReturnPolicy(store?.returnPolicy || {}),
    source: 'current_store_policy',
  };
};

const getConsumedQuantities = async (orderId, session = null) => {
  const requests = await queryWithSession(
    ReturnRequest.find({
      order: orderId,
      status: { $nin: CLOSED_WITHOUT_CONSUMING_QUANTITY },
    }).select('status seller items refund.shippingAmount refund.totalAmount policySnapshot.refundType').lean(),
    session
  );
  const consumed = new Map();
  const settledQuantities = new Map();
  const shippingRefundedBySeller = new Set();
  const refundedMinorBySeller = new Map();

  for (const request of requests) {
    const sellerId = toId(request.seller);
    if (!sellerId) throw returnFinancialDataError('A stored return has no seller owner.');
    const shippingAmount = requireExactReturnMoney(
      request.refund?.shippingAmount,
      'return shipping refund',
    );
    if (shippingAmount > 0) shippingRefundedBySeller.add(sellerId);
    if (request.policySnapshot?.refundType !== 'replacement_only') {
      const totalMinor = toMinorUnits(requireExactReturnMoney(
        request.refund?.totalAmount,
        'return total',
      ));
      const nextMinor = (refundedMinorBySeller.get(sellerId) || 0) + totalMinor;
      if (!Number.isSafeInteger(nextMinor)) {
        throw returnFinancialDataError('Stored return totals are outside the supported money range.');
      }
      refundedMinorBySeller.set(
        sellerId,
        nextMinor,
      );
    }
    for (const item of request.items || []) {
      const key = toId(item.orderItemId);
      const quantity = requireStoredReturnQuantity(item.quantity, 'return item quantity');
      if (!key) throw returnFinancialDataError('A stored return item has no order-line reference.');
      const nextConsumed = (consumed.get(key) || 0) + quantity;
      if (!Number.isSafeInteger(nextConsumed)) {
        throw returnFinancialDataError('Stored return quantities are outside the supported range.');
      }
      consumed.set(key, nextConsumed);
      if (request.status === 'returned') {
        const nextSettled = (settledQuantities.get(key) || 0) + quantity;
        if (!Number.isSafeInteger(nextSettled)) {
          throw returnFinancialDataError('Stored settled return quantities are outside the supported range.');
        }
        settledQuantities.set(key, nextSettled);
      }
    }
  }
  const refundedAmountBySeller = new Map(
    [...refundedMinorBySeller].map(([sellerId, minor]) => [sellerId, fromMinorUnits(minor)]),
  );
  return { consumed, settledQuantities, shippingRefundedBySeller, refundedAmountBySeller };
};

const buildOrderReturnEligibility = async (order, { session = null, at = new Date() } = {}) => {
  const sellerByItem = await getItemSellerMap(order, session);
  const { consumed } = await getConsumedQuantities(order._id, session);
  const groupedItems = new Map();

  for (const item of order.orderItems || []) {
    const sellerId = sellerByItem.get(toId(item._id));
    if (!sellerId) continue;
    if (!groupedItems.has(sellerId)) groupedItems.set(sellerId, []);
    const purchasedQuantity = requireStoredReturnQuantity(item.quantity, 'purchased order quantity');
    const consumedQuantity = consumed.get(toId(item._id)) || 0;
    const lineSubtotal = getOrderItemLineSubtotal(item);
    groupedItems.get(sellerId).push({
      orderItemId: item._id,
      productId: item.productId,
      name: item.name || 'Product',
      image: item.image || '',
      purchasedQuantity,
      alreadyRequestedQuantity: consumedQuantity,
      remainingReturnableQuantity: Math.max(0, purchasedQuantity - consumedQuantity),
      unitPrice: purchasedQuantity > 0 ? lineSubtotal / purchasedQuantity : 0,
      lineSubtotal,
      selectedColor: item.selectedColor || null,
      selectedOptions: item.selectedOptions || undefined,
      returnPolicy: Number(item.returnPolicySnapshotVersion) >= 1
        ? normalizeReturnPolicy(item.returnPolicy)
        : null,
    });
  }

  const groups = [];
  for (const [sellerId, items] of groupedItems.entries()) {
    const [policyInfo, seller] = await Promise.all([
      getSellerPolicy(order, sellerId, session),
      queryWithSession(User.findById(sellerId).select('_id username').lean(), session),
    ]);
    const fulfillment = getSellerFulfillment(order, sellerId);
    const evaluatedItems = items.map(item => {
      const policy = item.returnPolicy || policyInfo.policy;
      const itemDeadline = fulfillment.deliveredAt
        ? returnEligibilityDeadline(fulfillment.deliveredAt, policy.returnDuration)
        : null;
      let itemReason = '';

      if (order.awaitingPayment) itemReason = 'This order has not been paid.';
      else if (order.orderStatus === 'cancelled') itemReason = 'Cancelled orders cannot be returned.';
      else if (!policy.returnsEnabled) itemReason = 'Returns are not available for this item.';
      else if (policy.refundType === 'none') itemReason = 'No return resolution is configured for this item.';
      else if (fulfillment.status !== 'delivered' || !fulfillment.deliveredAt) itemReason = 'Return requests open after this seller portion is delivered.';
      else if (!itemDeadline || new Date(at).getTime() > itemDeadline.getTime()) itemReason = 'The return window has closed for this item.';
      else if (item.remainingReturnableQuantity <= 0) itemReason = 'All eligible quantities already have a return request.';

      return {
        ...item,
        returnPolicy: policy,
        eligibilityDeadline: itemDeadline,
        eligible: !itemReason,
        reason: itemReason,
      };
    });
    const eligibleItems = evaluatedItems.filter(item => item.eligible);
    const eligibleDeadlines = eligibleItems.map(item => item.eligibilityDeadline).filter(Boolean);
    const deadline = eligibleDeadlines.length
      ? new Date(Math.max(...eligibleDeadlines.map(value => new Date(value).getTime())))
      : null;
    const reason = eligibleItems.length
      ? ''
      : (evaluatedItems.find(item => item.reason)?.reason || 'No items are eligible for return.');

    groups.push({
      seller: { _id: sellerId, username: seller?.username || '' },
      store: { _id: policyInfo.storeId, storeName: policyInfo.storeName },
      policy: eligibleItems[0]?.returnPolicy || policyInfo.policy,
      policyVariants: [...new Set(evaluatedItems.map(item => item.returnPolicy.refundType))],
      policySource: policyInfo.source,
      fulfillment,
      eligibilityDeadline: deadline,
      eligible: eligibleItems.length > 0,
      reason,
      items: evaluatedItems,
    });
  }

  return groups;
};

const selectedReturnMoney = ({
  order,
  sellerId,
  sellerItems,
  selected,
  consumed = new Map(),
  settledQuantities = consumed,
  shippingAlreadyRefunded,
  sellerRefundedAmount,
}) => {
  const moneyAllocations = buildOrderItemMoneyAllocations(order);
  const discountAllocations = moneyAllocations.discount;
  const allocationKeyFor = (orderItemId) => {
    const matchingIndexes = (order.orderItems || [])
      .map((item, index) => toId(item?._id) === toId(orderItemId) ? index : -1)
      .filter(index => index >= 0);
    return matchingIndexes.length === 1 ? moneyAllocations.itemKeys[matchingIndexes[0]] : '';
  };
  const allocatedComponent = (allocationMap, item) => {
    const fullAmount = allocationMap.get(allocationKeyFor(item.orderItemId)) || 0;
    return allocateOrderLineAmountForQuantity(
      fullAmount,
      requireStoredReturnQuantity(item.purchasedQuantity, 'purchased return quantity'),
      consumed.get(toId(item.orderItemId)) || 0,
      item.quantity,
    );
  };
  const selectedSubtotal = sumMoney(selected.map(item => (
    allocatedComponent(moneyAllocations.subtotal, item)
  )));
  let taxAmount = sumMoney(selected.map(item => allocatedComponent(moneyAllocations.tax, item)));
  let discountAmount = sumMoney(selected.map(item => allocatedComponent(discountAllocations, item)));
  const reconciliationAmount = sumMoney(selected.map(item => (
    allocatedComponent(moneyAllocations.adjustment, item)
  )));

  const selectedByItem = new Map(selected.map(item => [toId(item.orderItemId), item.quantity]));
  const allSellerQuantityCovered = sellerItems.every(item => {
    const before = settledQuantities.get(toId(item.orderItemId)) || 0;
    const now = selectedByItem.get(toId(item.orderItemId)) || 0;
    return before + now >= item.purchasedQuantity;
  });
  const sellerOrderItemIds = new Set(sellerItems.map(item => toId(item.orderItemId)));
  const persistedSellerItems = (order.orderItems || []).filter(item => sellerOrderItemIds.has(toId(item._id)));
  const sellerMoney = sellerOrderSummaryForItems(order, sellerId, persistedSellerItems);
  const sellerShipping = sellerMoney.shippingCost;
  const shippingAmount = allSellerQuantityCovered && !shippingAlreadyRefunded
    ? roundMoney(sellerShipping)
    : 0;
  const sellerMaximumRefund = sellerMoney.totalAmount;
  const hasRefundLedger = sellerRefundedAmount !== undefined && sellerRefundedAmount !== null;
  const refundedSoFar = hasRefundLedger
    ? requireExactReturnMoney(sellerRefundedAmount, 'seller cumulative return total')
    : null;
  if (hasRefundLedger && refundedSoFar > sellerMaximumRefund) {
    throw returnFinancialDataError(
      'Stored seller returns exceed the seller\'s frozen order entitlement.',
      'RETURN_SELLER_SETTLEMENT_EXCEEDED',
    );
  }
  const remainingSellerRefund = hasRefundLedger
    ? roundMoney(sellerMaximumRefund - refundedSoFar)
    : null;

  const rawCalculatedTotal = sumMoney([
    selectedSubtotal,
    taxAmount,
    shippingAmount,
    -discountAmount,
    reconciliationAmount,
  ]);
  if (rawCalculatedTotal < 0) {
    throw returnFinancialDataError(
      'The stored order allocations produce a negative return amount.',
      'RETURN_ORDER_ALLOCATION_INVALID',
    );
  }
  const calculatedTotal = rawCalculatedTotal;
  const totalAmount = hasRefundLedger
    ? (allSellerQuantityCovered
      ? remainingSellerRefund
      : roundMoney(Math.min(calculatedTotal, remainingSellerRefund)))
    : calculatedTotal;

  // Keep the component breakdown equal to the capped total. The final split
  // request absorbs any one-cent proportional rounding remainder.
  const componentTotal = roundMoney(selectedSubtotal + taxAmount + shippingAmount - discountAmount);
  const adjustment = roundMoney(totalAmount - componentTotal);
  if (adjustment > 0) taxAmount = roundMoney(taxAmount + adjustment);
  else if (adjustment < 0) discountAmount = roundMoney(discountAmount + Math.abs(adjustment));

  return {
    itemSubtotal: roundMoney(selectedSubtotal),
    taxAmount,
    shippingAmount,
    discountAmount,
    totalAmount,
  };
};

const sellerShippingSnapshotAmount = (order, sellerId) => {
  const sellerShipping = (order?.sellerShipping || []).find(
    entry => toId(entry?.seller) === toId(sellerId),
  );
  if (sellerShipping) {
    return requireExactReturnMoney(
      sellerShipping.shippingMethod?.price,
      'seller shipping snapshot',
    );
  }
  if (toId(order?.shippingMethod?.seller) === toId(sellerId)) {
    return requireExactReturnMoney(
      order.shippingMethod?.price,
      'seller shipping snapshot',
    );
  }
  return 0;
};

// A return request freezes its item/tax/discount allocation when it is opened,
// but shipping belongs to the one settlement that makes every line for this
// seller actually returned. SellerSettlementLock must be held by the caller.
// This calculation is intentionally based only on `returned` predecessors;
// rejected, cancelled, replacement, and merely pending quantities cannot
// unlock shipping. An in-flight external card settlement is a separate,
// explicit reservation: siblings wait until that attempt completes or closes.
const buildSettlementShippingAllocation = async ({ request, order, sellerEntitlement, session }) => {
  if (request?.policySnapshot?.refundType === 'replacement_only') return null;

  const sellerId = toId(request?.seller);
  if (!sellerId || toId(request?.order) !== toId(order?._id)) {
    throw returnFinancialDataError(
      'The return shipping allocation has an invalid order or seller identity.',
      'RETURN_ORDER_IDENTITY_MISMATCH',
    );
  }

  const frozenShipping = sellerShippingSnapshotAmount(order, sellerId);
  const relatedRequests = await queryWithSession(
    ReturnRequest.find({
      order: request.order,
      seller: request.seller,
      status: { $nin: CLOSED_WITHOUT_CONSUMING_QUANTITY },
    }).select(
      'returnNumber status seller items refund.shippingAmount refund.totalAmount policySnapshot.refundType '
      + 'settlement.fundingSource settlement.status'
    ).lean(),
    session,
  );
  const inFlightCardReservation = relatedRequests.find(other => (
    toId(other?._id) !== toId(request._id)
    && other.status === 'accepted_pending_payment'
    && other.settlement?.fundingSource === 'card'
    && other.settlement?.status === 'pending_payment'
  ));
  if (inFlightCardReservation) {
    const error = returnFinancialDataError(
      `Return ${inFlightCardReservation.returnNumber || inFlightCardReservation._id} has an in-flight card settlement. Recover, complete, or definitively close that attempt before settling another return for this seller.`,
      'RETURN_SELLER_SETTLEMENT_RESERVED',
    );
    error.reservedByReturnRequestId = toId(inFlightCardReservation._id);
    throw error;
  }
  if (frozenShipping === 0) return null;

  const sellerByItem = await getItemSellerMap(order, session);
  const sellerItems = (order.orderItems || []).filter(
    item => sellerByItem.get(toId(item?._id)) === sellerId,
  );
  if (!sellerItems.length) {
    throw returnFinancialDataError(
      'The return seller owns no original order lines.',
      'RETURN_ORDER_IDENTITY_MISMATCH',
    );
  }

  const returnedQuantityByItem = new Map();
  let priorReturnedMinor = 0;
  let returnedShippingOwner = null;
  let pendingShippingOwner = null;

  for (const other of relatedRequests) {
    const otherId = toId(other?._id);
    const isCurrent = otherId === toId(request._id);
    const shippingAmount = requireExactReturnMoney(
      other?.refund?.shippingAmount,
      'return shipping refund',
    );
    if (!isCurrent && shippingAmount > 0) {
      if (other.status === 'returned') returnedShippingOwner = other;
      else pendingShippingOwner = other;
    }
    if (isCurrent || other.status !== 'returned') continue;

    if (other.policySnapshot?.refundType !== 'replacement_only') {
      const nextMinor = priorReturnedMinor + toMinorUnits(requireExactReturnMoney(
        other?.refund?.totalAmount,
        'settled return total',
      ));
      if (!Number.isSafeInteger(nextMinor)) {
        throw returnFinancialDataError('Settled return totals are outside the supported money range.');
      }
      priorReturnedMinor = nextMinor;
    }
    for (const item of other.items || []) {
      const orderItemId = toId(item?.orderItemId);
      const quantity = requireStoredReturnQuantity(item?.quantity, 'settled return quantity');
      if (!orderItemId || sellerByItem.get(orderItemId) !== sellerId) {
        throw returnFinancialDataError(
          'A settled return contains an item outside its seller order lines.',
          'RETURN_ORDER_IDENTITY_MISMATCH',
        );
      }
      const nextQuantity = (returnedQuantityByItem.get(orderItemId) || 0) + quantity;
      if (!Number.isSafeInteger(nextQuantity)) {
        throw returnFinancialDataError('Settled return quantities are outside the supported range.');
      }
      returnedQuantityByItem.set(orderItemId, nextQuantity);
    }
  }

  const currentQuantityByItem = new Map();
  for (const item of request.items || []) {
    const orderItemId = toId(item?.orderItemId);
    const quantity = requireStoredReturnQuantity(item?.quantity, 'current return quantity');
    if (!orderItemId || sellerByItem.get(orderItemId) !== sellerId || currentQuantityByItem.has(orderItemId)) {
      throw returnFinancialDataError(
        'The current return contains invalid seller order lines.',
        'RETURN_ORDER_IDENTITY_MISMATCH',
      );
    }
    currentQuantityByItem.set(orderItemId, quantity);
  }

  const completesSellerReturn = sellerItems.every(item => {
    const orderItemId = toId(item._id);
    const purchasedQuantity = requireStoredReturnQuantity(item.quantity, 'purchased order quantity');
    const returnedQuantity = returnedQuantityByItem.get(orderItemId) || 0;
    const currentQuantity = currentQuantityByItem.get(orderItemId) || 0;
    if (returnedQuantity > purchasedQuantity || returnedQuantity + currentQuantity > purchasedQuantity) {
      throw returnFinancialDataError(
        'Settled return quantities exceed the original order quantity.',
        'RETURN_QUANTITY_EXCEEDED',
      );
    }
    return returnedQuantity + currentQuantity === purchasedQuantity;
  });

  const currentShipping = requireExactReturnMoney(
    request.refund?.shippingAmount,
    'current return shipping refund',
  );
  if (!completesSellerReturn) {
    if (currentShipping > 0) {
      throw returnFinancialDataError(
        'Shipping was allocated before all seller quantities were returned.',
        'RETURN_SHIPPING_ALLOCATION_INVALID',
      );
    }
    return null;
  }
  if (pendingShippingOwner) {
    throw returnFinancialDataError(
      'Another unresolved return currently owns this seller shipping refund.',
      'RETURN_SHIPPING_ALLOCATION_RESERVED',
    );
  }
  if (returnedShippingOwner) {
    if (currentShipping > 0) {
      throw returnFinancialDataError(
        'Seller shipping is allocated to more than one return.',
        'RETURN_SHIPPING_ALREADY_REFUNDED',
      );
    }
    return null;
  }
  if (currentShipping !== 0 && currentShipping !== frozenShipping) {
    throw returnFinancialDataError(
      'The stored shipping refund does not match the seller shipping snapshot.',
      'RETURN_SHIPPING_ALLOCATION_INVALID',
    );
  }

  const sellerOrderItemIds = new Set(sellerItems.map(item => toId(item._id)));
  const sellerMoney = sellerOrderSummaryForItems(
    order,
    sellerId,
    (order.orderItems || []).filter(item => sellerOrderItemIds.has(toId(item._id))),
  );
  const sellerMaximumMinor = toMinorUnits(requireExactReturnMoney(
    sellerMoney.totalAmount,
    'seller frozen order entitlement',
  ));
  if (
    !sellerEntitlement
    || typeof sellerEntitlement.sourceAmountMinor !== 'number'
    || !Number.isSafeInteger(sellerEntitlement.sourceAmountMinor)
    || sellerEntitlement.sourceAmountMinor < 0
    || sellerMaximumMinor !== sellerEntitlement.sourceAmountMinor
  ) {
    throw returnFinancialDataError(
      'The seller return entitlement no longer matches its frozen settlement.',
      'RETURN_SELLER_SETTLEMENT_MISMATCH',
    );
  }
  if (toMinorUnits(requireExactReturnMoney(
    sellerMoney.shippingCost,
    'seller frozen shipping entitlement',
  )) !== toMinorUnits(frozenShipping)) {
    throw returnFinancialDataError(
      'The seller shipping snapshots do not reconcile.',
      'RETURN_SHIPPING_ALLOCATION_INVALID',
    );
  }

  const currentTotal = requireExactReturnMoney(request.refund?.totalAmount, 'current return total');
  const shippingDeltaMinor = toMinorUnits(frozenShipping) - toMinorUnits(currentShipping);
  const nextTotalMinor = toMinorUnits(currentTotal) + shippingDeltaMinor;
  if (
    !Number.isSafeInteger(nextTotalMinor)
    || priorReturnedMinor + nextTotalMinor !== sellerEntitlement.sourceAmountMinor
  ) {
    throw returnFinancialDataError(
      'The final seller return does not reconcile with the frozen seller entitlement.',
      'RETURN_SHIPPING_ALLOCATION_MISMATCH',
    );
  }

  return {
    previousShippingAmount: currentShipping,
    previousTotalAmount: currentTotal,
    set: {
      'refund.shippingAmount': frozenShipping,
      'refund.totalAmount': fromMinorUnits(nextTotalMinor),
      'settlement.shippingAllocationVersion': 1,
      'settlement.shippingAllocatedAt': new Date(),
    },
  };
};

const applySettlementShippingAllocation = (request, allocation) => {
  if (!allocation) return request;
  for (const [path, value] of Object.entries(allocation.set)) {
    if (typeof request.set === 'function') {
      request.set(path, value, undefined, { overwriteImmutable: true });
    } else {
      const parts = path.split('.');
      const leaf = parts.pop();
      let target = request;
      for (const part of parts) {
        target[part] = target[part] || {};
        target = target[part];
      }
      target[leaf] = value;
    }
  }
  return request;
};

const createReturnRequest = async (input) => {
  const prepared = normalizeReturnCreationInput(input);
  const {
    orderId,
    buyerId,
    sellerId,
    items,
    reasonCategory,
    reasonDetails: cleanReason,
    requestKey: cleanRequestKey,
    requestFingerprint,
  } = prepared;

  try {
    return await runInTransaction(async (session) => {
      const existing = await ReturnRequest.findOne({
        requestKey: cleanRequestKey,
        buyer: buyerId,
      }).select('+requestFingerprint').session(session);
      if (existing) {
        const replay = assertReturnReplayMatches(existing, requestFingerprint);
        const replayOrder = await Order.findById(existing.order).session(session);
        // Replays repair a pre-outbox legacy request, while the dedupe key makes
        // this a no-op for requests that already committed their event.
        await notifySellerReturnRequested(replay, replayOrder, { session });
        return replay;
      }

      const order = await Order.findOne({
        _id: orderId,
        user: buyerId,
        awaitingPayment: { $ne: true },
      }).session(session);
      if (!order) {
        const error = new Error('Order not found or it does not belong to this account.');
        error.statusCode = 404;
        throw error;
      }
      const orderCurrency = getAccountingOrderCurrency(order);
      await assertWalletOrderFundingReturnable({ orderId: order._id, session });

      // Serializes concurrent return requests for the same order.
      await Order.updateOne({ _id: order._id }, { $inc: { returnVersion: 1 } }, { session });

      const unresolvedReturn = await ReturnRequest.findOne({
        order: order._id,
        seller: sellerId,
        status: { $in: UNRESOLVED_RETURN_STATUSES },
      }).select('_id returnNumber status').session(session).lean();
      if (unresolvedReturn) {
        const error = new Error(
          `Finish return ${unresolvedReturn.returnNumber} before opening another return for this seller.`,
        );
        error.statusCode = 409;
        error.code = 'RETURN_REQUEST_ALREADY_OPEN';
        throw error;
      }

      const groups = await buildOrderReturnEligibility(order, { session });
      const group = groups.find(entry => toId(entry.seller?._id) === toId(sellerId));
      if (!group) {
        const error = new Error('The selected seller is not part of this order.');
        error.statusCode = 400;
        throw error;
      }
      if (!group.eligible) {
        const error = new Error(group.reason || 'This seller portion is not eligible for return.');
        error.statusCode = 400;
        error.code = 'RETURN_NOT_ELIGIBLE';
        throw error;
      }

      const requestedByItem = new Map(items.map(item => [item.orderItemId, item.quantity]));

      const selected = [];
      for (const item of group.items) {
    const quantity = requestedByItem.get(toId(item.orderItemId));
    if (!quantity) continue;
    if (!item.eligible) {
      const error = new Error(item.reason || `${item.name} is not eligible for return.`);
      error.statusCode = 409;
      error.code = 'RETURN_ITEM_NOT_ELIGIBLE';
      throw error;
    }
    if (quantity > item.remainingReturnableQuantity) {
      const error = new Error(`Only ${item.remainingReturnableQuantity} unit(s) of ${item.name} can still be returned.`);
      error.statusCode = 409;
      error.code = 'RETURN_QUANTITY_EXCEEDED';
      throw error;
    }
    selected.push({
      ...item,
      quantity,
      lineSubtotal: allocateOrderLineAmountForQuantity(
        item.lineSubtotal,
        item.purchasedQuantity,
        item.alreadyRequestedQuantity,
        quantity,
      ),
    });
      }
      if (selected.length !== requestedByItem.size) {
        const error = new Error('One or more selected items do not belong to this seller.');
        error.statusCode = 400;
        throw error;
      }

      const selectedRefundTypes = [...new Set(selected.map(item => item.returnPolicy.refundType))];
      if (selectedRefundTypes.length !== 1) {
    const error = new Error('Items with different return resolutions must be submitted as separate return requests.');
    error.statusCode = 400;
    error.code = 'MIXED_RETURN_RESOLUTIONS';
    throw error;
      }
      const selectedPolicy = selected[0].returnPolicy;
      const selectedDeadline = new Date(Math.min(
        ...selected.map(item => new Date(item.eligibilityDeadline).getTime())
      ));

      const {
    consumed,
    settledQuantities,
    shippingRefundedBySeller,
    refundedAmountBySeller,
      } = await getConsumedQuantities(order._id, session);
      const refund = selectedReturnMoney({
    order,
    sellerId,
    sellerItems: group.items,
    selected,
    consumed,
    settledQuantities,
    shippingAlreadyRefunded: shippingRefundedBySeller.has(toId(sellerId)),
    sellerRefundedAmount: refundedAmountBySeller.get(toId(sellerId)) || 0,
      });
      if (selectedPolicy.refundType !== 'replacement_only' && refund.totalAmount <= 0) {
    const error = new Error('The calculated refund amount is zero. Please contact support.');
    error.statusCode = 409;
    throw error;
      }

      const [returnRequest] = await ReturnRequest.create([{
    returnNumber: makeReturnNumber(),
        requestKey: cleanRequestKey,
        requestFingerprint,
    order: order._id,
    orderId: order.orderId,
    buyer: buyerId,
    seller: sellerId,
    store: group.store?._id || null,
    storeName: group.store?.storeName || '',
    currency: orderCurrency,
    items: selected.map(item => ({
      orderItemId: item.orderItemId,
      productId: item.productId,
      name: item.name,
      image: item.image,
      quantity: item.quantity,
      purchasedQuantity: item.purchasedQuantity,
      unitPrice: item.unitPrice,
      lineSubtotal: item.lineSubtotal,
      selectedColor: item.selectedColor,
      selectedOptions: item.selectedOptions,
    })),
    reasonCategory,
    reasonDetails: cleanReason,
    status: 'requested',
    statusHistory: [{
      status: 'requested',
      note: cleanReason,
      changedBy: buyerId,
      actorRole: 'buyer',
    }],
    requestedAt: new Date(),
    eligibilityDeadline: selectedDeadline,
    policySnapshot: {
      returnsEnabled: true,
      returnDuration: selectedPolicy.returnDuration,
      refundType: selectedPolicy.refundType,
      policyDescription: selectedPolicy.policyDescription || '',
    },
    refund,
      }], { session });

      returnRequest.$locals = returnRequest.$locals || {};
      returnRequest.$locals.idempotencyReplay = false;
      await notifySellerReturnRequested(returnRequest, order, { session });
      return returnRequest;
    });
  } catch (error) {
    const duplicateRequestKey = error?.code === 11000
      && (error?.keyPattern?.requestKey || error?.keyValue?.requestKey);
    if (!duplicateRequestKey) throw error;
    const existing = await ReturnRequest.findOne({
      requestKey: cleanRequestKey,
      buyer: buyerId,
    }).select('+requestFingerprint');
    if (!existing) throw error;
    return assertReturnReplayMatches(existing, requestFingerprint);
  }
};

const getReturnDetail = async ({ returnRequestId, actor }) => {
  const request = await ReturnRequest.findById(returnRequestId)
    .populate('buyer', 'username email avatar')
    .populate('seller', 'username email avatar')
    .populate('store', 'storeName storeSlug')
    .populate('order', 'orderId shippingInfo orderStatus sellerFulfillment currency paymentMethod')
    .lean();
  if (!request) return null;
  const actorId = toId(actor?.id || actor?._id);
  if (actor?.role !== 'admin' && actorId !== toId(request.buyer) && actorId !== toId(request.seller)) {
    const error = new Error('You do not have access to this return request.');
    error.statusCode = 403;
    throw error;
  }
  return request;
};

const updateReturnStatus = async ({ returnRequestId, actor, nextStatus, note }) => {
  if (['accepted_pending_payment', 'returned', 'replacement_approved'].includes(nextStatus)) {
    const error = new Error('Use the Accept Return action to finalize a return.');
    error.statusCode = 400;
    throw error;
  }
  return runInTransaction(async (session) => {
    const request = await ReturnRequest.findById(returnRequestId).session(session);
    if (!request) {
      const error = new Error('Return request not found.');
      error.statusCode = 404;
      throw error;
    }
    if (actor.role !== 'admin' && (actor.role !== 'seller' || toId(request.seller) !== toId(actor.id))) {
      const error = new Error('Only this order seller can update the return.');
      error.statusCode = 403;
      throw error;
    }
    if (!canTransitionReturnStatus(request.status, nextStatus)) {
      const error = new Error(`Return cannot move from ${request.status} to ${nextStatus}.`);
      error.statusCode = 409;
      error.code = 'INVALID_RETURN_STATUS_TRANSITION';
      throw error;
    }
    const clean = cleanNote(note);
    if (nextStatus === 'rejected' && clean.length < 5) {
      const error = new Error('Add a clear rejection reason.');
      error.statusCode = 400;
      throw error;
    }

    request.status = nextStatus;
    request.sellerNote = clean || request.sellerNote;
    request.statusHistory.push({
      status: nextStatus,
      note: clean,
      changedBy: actor.id,
      actorRole: actor.role === 'admin' ? 'admin' : 'seller',
    });
    await request.save({ session });
    const order = await queryWithSession(Order.findById(request.order).lean(), session);
    if (!order) {
      const error = new Error('The return order no longer exists.');
      error.statusCode = 409;
      error.code = 'RETURN_ORDER_MISSING';
      throw error;
    }
    await notifyBuyerReturnStatus(request, order, clean, { session });
    return request;
  });
};

const cancelReturnRequest = async ({ returnRequestId, buyerId, note }) => runInTransaction(async (session) => {
  const request = await ReturnRequest.findOne({ _id: returnRequestId, buyer: buyerId }).session(session);
  if (!request) {
    const error = new Error('Return request not found.');
    error.statusCode = 404;
    throw error;
  }
  if (!BUYER_CANCELLABLE_STATUSES.includes(request.status)) {
    const error = new Error('This return can no longer be cancelled because pickup or review has started.');
    error.statusCode = 409;
    throw error;
  }
  request.status = 'cancelled_by_buyer';
  request.buyerCancelledAt = new Date();
  request.statusHistory.push({
    status: 'cancelled_by_buyer',
    note: cleanNote(note),
    changedBy: buyerId,
    actorRole: 'buyer',
  });
  await request.save({ session });
  const order = await queryWithSession(Order.findById(request.order).lean(), session);
  if (!order) {
    const error = new Error('The return order no longer exists.');
    error.statusCode = 409;
    error.code = 'RETURN_ORDER_MISSING';
    throw error;
  }
  // State and every notification channel commit together. A crash or enqueue
  // failure cannot leave a cancelled return without its durable event.
  await enqueueReturnCancellationNotifications(request, order, { session });
  return request;
});

const settleFromSellerBalance = async ({ returnRequestId, sellerId }) => runInTransaction(async (session) => {
  await SellerSettlementLock.findOneAndUpdate(
    { seller: sellerId },
    { $setOnInsert: { seller: sellerId }, $inc: { version: 1 } },
    { upsert: true, new: true, session }
  );

  const request = await ReturnRequest.findOne({ _id: returnRequestId, seller: sellerId }).session(session);
  if (!request) {
    const error = new Error('Return request not found.');
    error.statusCode = 404;
    throw error;
  }
  if (request.status === 'returned' && request.settlement?.status === 'completed') return request;
  if (request.status !== 'under_review') {
    const error = new Error('The return must be under review before it can be accepted.');
    error.statusCode = 409;
    throw error;
  }
  await assertWalletOrderFundingReturnable({ orderId: request.order, session });

  const order = await queryWithSession(
    Order.findById(request.order).select(
      'orderId user shippingInfo currency exchangeRateSnapshot orderItems sellerShipping shippingMethod orderSummary appliedCoupons sellerSettlementVersion sellerSettlement'
    ),
    session
  );
  if (!order) {
    const error = new Error('The original order for this return no longer exists.');
    error.statusCode = 409;
    throw error;
  }
  const sourceCurrency = getAccountingOrderCurrency(order);
  if (requireStoredReturnCurrency(request.currency) !== sourceCurrency) {
    const error = new Error('The return currency no longer matches the original order.');
    error.statusCode = 409;
    error.code = 'RETURN_CURRENCY_MISMATCH';
    throw error;
  }
  let settlement;
  try {
    settlement = await ensureOrderSellerSettlement(order, {
      session,
      requireOrderTotal: true,
    });
  } catch (error) {
    if (error?.code === 'SELLER_SETTLEMENT_HISTORICAL_RATE_MISSING') {
      const quarantined = new Error(
        'This legacy foreign-currency order is missing its checkout exchange-rate snapshot. The refund requires an audited financial backfill.'
      );
      quarantined.statusCode = 409;
      quarantined.code = 'LEGACY_ORDER_FX_BACKFILL_REQUIRED';
      throw quarantined;
    }
    if (error?.code === 'SELLER_SETTLEMENT_EXCHANGE_RATE_MISSING') {
      const unavailable = new Error('Exchange rates are temporarily unavailable. Please try the refund again shortly.');
      unavailable.statusCode = 503;
      unavailable.code = 'EXCHANGE_RATES_UNAVAILABLE';
      throw unavailable;
    }
    throw error;
  }
  const frozenSellerSettlement = sellerSettlementEntry(settlement, sellerId);
  if (!frozenSellerSettlement) {
    const error = new Error('This seller does not own a frozen entitlement in the original order.');
    error.statusCode = 409;
    error.code = 'RETURN_SELLER_SETTLEMENT_MISSING';
    throw error;
  }
  const shippingAllocation = await buildSettlementShippingAllocation({
    request,
    order,
    sellerEntitlement: frozenSellerSettlement,
    session,
  });
  applySettlementShippingAllocation(request, shippingAllocation);
  // Debit the seller's monotonic cumulative share of their exact frozen USD
  // entitlement. Partial returns cannot create independent FX rounding drift,
  // and a full seller refund always cancels the exact credited cents.
  const priorBalanceReturns = await queryWithSession(ReturnRequest.find({
    _id: { $ne: request._id },
    order: request.order,
    seller: sellerId,
    status: 'returned',
    'settlement.fundingSource': 'seller_balance',
    'settlement.status': 'completed',
  }).select('_id refund.totalAmount').lean(), session);
  const priorReferenceIds = priorBalanceReturns.map(entry => String(entry._id));
  const priorDebits = priorReferenceIds.length
    ? await queryWithSession(SellerBalanceTransaction.find({
    seller: sellerId,
    type: 'return_refund',
    direction: 'debit',
    status: 'completed',
    referenceType: 'return_request',
    referenceId: { $in: priorReferenceIds },
  }).select('amountUSD').lean(), session)
    : [];
  const cumulativeSourceMinor = [
    ...priorBalanceReturns.map(entry => entry.refund?.totalAmount),
    request.refund.totalAmount,
  ].reduce((sum, amount) => {
    const next = sum + toMinorUnits(requireExactReturnMoney(amount, 'seller-funded return total'));
    if (!Number.isSafeInteger(next)) {
      throw returnFinancialDataError('Seller-funded return totals are outside the supported money range.');
    }
    return next;
  }, 0);
  if (cumulativeSourceMinor > frozenSellerSettlement.sourceAmountMinor) {
    const error = new Error('Seller-funded returns exceed this seller\'s frozen order entitlement.');
    error.statusCode = 409;
    error.code = 'RETURN_SELLER_SETTLEMENT_EXCEEDED';
    throw error;
  }
  const cumulativeUsdMinor = sellerSettlementUsdTargetForSource(
    frozenSellerSettlement,
    cumulativeSourceMinor,
  );
  const priorDebitedUsdMinor = priorDebits.reduce(
    (sum, entry) => {
      const next = sum + toMinorUnits(requireExactReturnMoney(entry.amountUSD, 'seller return ledger debit'));
      if (!Number.isSafeInteger(next)) {
        throw returnFinancialDataError('Seller return ledger debits are outside the supported money range.');
      }
      return next;
    },
    0,
  );
  if (priorDebitedUsdMinor > cumulativeUsdMinor) {
    const error = new Error('The existing seller refund ledger exceeds the frozen settlement target.');
    error.statusCode = 409;
    error.code = 'RETURN_SELLER_LEDGER_MISMATCH';
    throw error;
  }
  const amountUsdMinor = cumulativeUsdMinor - priorDebitedUsdMinor;
  const amountUSD = fromMinorUnits(amountUsdMinor);
  const { buildSellerPaymentSummary } = require('../controllers/PaymentController');
  const summary = await buildSellerPaymentSummary(sellerId, { session });
  const withdrawableBalanceUSD = requireExactReturnMoney(
    summary?.revenue?.withdrawableBalance,
    'seller withdrawable balance',
  );
  if (amountUSD > withdrawableBalanceUSD) {
    const error = new Error('Your available seller balance is not enough for this refund. Pay by card instead.');
    error.statusCode = 400;
    error.code = 'INSUFFICIENT_SELLER_BALANCE';
    error.availableBalanceUSD = withdrawableBalanceUSD;
    throw error;
  }

  const sellerDebit = (await SellerBalanceTransaction.create([{
      seller: sellerId,
      type: 'return_refund',
      direction: 'debit',
      status: 'completed',
      amountUSD,
      sourceAmount: request.refund.totalAmount,
      sourceCurrency,
      referenceType: 'return_request',
      referenceId: String(request._id),
      description: `Wallet refund for return ${request.returnNumber}`,
      completedAt: new Date(),
      metadata: {
        sellerSettlementVersion: SELLER_SETTLEMENT_VERSION,
        cumulativeSourceMinor,
        cumulativeUsdMinor,
      },
    }], { session }))[0];

  const walletTransaction = await creditWalletInSession({
    userId: request.buyer,
    amount: request.refund.totalAmount,
    currency: request.currency,
    type: 'return_refund',
    referenceType: 'return_request',
    referenceId: request._id,
    idempotencyKey: `return-refund:${request._id}`,
    description: `Refund for return ${request.returnNumber}`,
    metadata: { orderId: request.orderId, sellerId: String(sellerId) },
    allowLocked: true,
  }, session);
  await attachReturnedWalletFundingProvenance({
    walletTransaction,
    orderId: request.order,
    sellerId,
    returnRequestId: request._id,
    refundAmount: request.refund.totalAmount,
    currency: request.currency,
    session,
  });

  request.status = 'returned';
  request.settlement.fundingSource = 'seller_balance';
  request.settlement.status = 'completed';
  request.settlement.setupState = 'complete';
  request.settlement.sellerBalanceTransaction = sellerDebit?._id || null;
  request.settlement.walletTransaction = walletTransaction._id;
  request.settlement.settledAt = new Date();
  request.statusHistory.push({
    status: 'returned',
    note: 'Seller balance funded the buyer wallet refund.',
    changedBy: sellerId,
    actorRole: 'seller',
  });
  await request.save({ session });
  await enqueueReturnSettlementNotifications(request, order, { session, walletTransaction });
  return request;
});

const approveReplacement = async ({ returnRequestId, sellerId }) => runInTransaction(async (session) => {
  const request = await ReturnRequest.findOne({ _id: returnRequestId, seller: sellerId }).session(session);
  if (!request) {
    const error = new Error('Return request not found.');
    error.statusCode = 404;
    throw error;
  }
  if (request.status !== 'under_review') {
    const error = new Error('The return must be under review before approving a replacement.');
    error.statusCode = 409;
    throw error;
  }
  request.status = 'replacement_approved';
  request.settlement.fundingSource = 'replacement';
  request.settlement.status = 'not_required';
  request.settlement.setupState = 'closed';
  request.settlement.settledAt = new Date();
  request.statusHistory.push({
    status: 'replacement_approved',
    note: 'Seller approved the replacement resolution.',
    changedBy: sellerId,
    actorRole: 'seller',
  });
  await request.save({ session });
  const order = await queryWithSession(Order.findById(request.order).lean(), session);
  if (!order) {
    const error = new Error('The return order no longer exists.');
    error.statusCode = 409;
    error.code = 'RETURN_ORDER_MISSING';
    throw error;
  }
  await notifyBuyerReturnStatus(request, order, '', { session });
  return request;
});

const returnSettlementError = (message, code, statusCode = 400, cause = null) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (cause) error.cause = cause;
  return error;
};

const sameReturnSettlementInstant = (left, right) => (
  left instanceof Date
  && right instanceof Date
  && Number.isFinite(left.getTime())
  && Number.isFinite(right.getTime())
  && left.getTime() === right.getTime()
);

const assertReturnRequestFinancialIdentity = async (request, { session = null } = {}) => {
  if (!request?._id || !request?.order) {
    throw returnFinancialDataError('The return financial snapshot has no original order reference.');
  }
  const currency = requireStoredReturnCurrency(request.currency);
  const itemSubtotal = requireExactReturnMoney(request.refund?.itemSubtotal, 'return item subtotal');
  const taxAmount = requireExactReturnMoney(request.refund?.taxAmount, 'return tax amount');
  const shippingAmount = requireExactReturnMoney(request.refund?.shippingAmount, 'return shipping amount');
  const discountAmount = requireExactReturnMoney(request.refund?.discountAmount, 'return discount amount');
  const totalAmount = requireExactReturnMoney(
    request.refund?.totalAmount,
    'return total',
    { positive: true },
  );
  const grossAmount = sumMoney([itemSubtotal, taxAmount, shippingAmount]);
  if (discountAmount > grossAmount || roundMoney(grossAmount - discountAmount) !== totalAmount) {
    throw returnFinancialDataError('The stored return total does not reconcile with its components.');
  }

  const requestItems = request.items || [];
  const seenOrderItems = new Set();
  let storedItemSubtotalMinor = 0;
  for (const [index, item] of requestItems.entries()) {
    const orderItemId = toId(item?.orderItemId);
    if (!orderItemId || seenOrderItems.has(orderItemId)) {
      throw returnFinancialDataError('The stored return item references are invalid.');
    }
    seenOrderItems.add(orderItemId);
    requireStoredReturnQuantity(item?.quantity, `return item ${index + 1} quantity`);
    requireStoredReturnQuantity(item?.purchasedQuantity, `return item ${index + 1} purchased quantity`);
    const lineMinor = toMinorUnits(requireExactReturnMoney(
      item?.lineSubtotal,
      `return item ${index + 1} subtotal`,
    ));
    storedItemSubtotalMinor += lineMinor;
    if (!Number.isSafeInteger(storedItemSubtotalMinor)) {
      throw returnFinancialDataError('Stored return item totals are outside the supported money range.');
    }
  }
  if (!requestItems.length || storedItemSubtotalMinor !== toMinorUnits(itemSubtotal)) {
    throw returnFinancialDataError('The stored return items do not reconcile with the return subtotal.');
  }

  const orderQuery = Order.findById(request.order).select(
    'currency orderId user orderItems sellerShipping shippingMethod orderSummary appliedCoupons couponUsageVersion exchangeRateSnapshot sellerSettlementVersion sellerSettlement',
  );
  const order = await queryWithSession(orderQuery, session);
  if (!order) {
    throw returnFinancialDataError('The original order for this return no longer exists.');
  }
  const orderCurrency = getAccountingOrderCurrency(order);
  if (
    currency !== orderCurrency
    || String(request.orderId || '') !== String(order.orderId || '')
    || toId(request.buyer) !== toId(order.user)
  ) {
    throw returnFinancialDataError(
      'The return financial snapshot no longer matches its original order.',
      'RETURN_ORDER_IDENTITY_MISMATCH',
    );
  }

  const sellerId = toId(request.seller);
  const sellerByItem = await getItemSellerMap(order, session);
  const orderItemsById = new Map((order.orderItems || []).map(item => [toId(item._id), item]));
  for (const item of requestItems) {
    const orderItemId = toId(item.orderItemId);
    const orderItem = orderItemsById.get(orderItemId);
    if (
      !sellerId
      || !orderItem
      || sellerByItem.get(orderItemId) !== sellerId
      || item.quantity > requireStoredReturnQuantity(orderItem.quantity, 'purchased order quantity')
    ) {
      throw returnFinancialDataError(
        'The return items no longer match the original seller order lines.',
        'RETURN_ORDER_IDENTITY_MISMATCH',
      );
    }
  }

  const settlement = await ensureOrderSellerSettlement(order, {
    session,
    requireOrderTotal: true,
  });
  const sellerEntitlement = sellerSettlementEntry(settlement, sellerId);
  if (!sellerEntitlement) {
    throw returnFinancialDataError(
      'The return seller has no frozen entitlement in the original order.',
      'RETURN_ORDER_IDENTITY_MISMATCH',
    );
  }
  const { refundedAmountBySeller } = await getConsumedQuantities(order._id, session);
  const cumulativeRefundMinor = toMinorUnits(requireExactReturnMoney(
    refundedAmountBySeller.get(sellerId) || 0,
    'seller cumulative return total',
  ));
  if (cumulativeRefundMinor > sellerEntitlement.sourceAmountMinor) {
    throw returnFinancialDataError(
      'Stored seller returns exceed the frozen original-order entitlement.',
      'RETURN_SELLER_SETTLEMENT_EXCEEDED',
    );
  }
  return { currency, order, sellerEntitlement, totalAmount };
};

const returnSettlementMinor = request => {
  requireStoredReturnCurrency(request?.currency);
  return toMinorUnits(requireExactReturnMoney(
    request?.refund?.totalAmount,
    'return settlement total',
    { positive: true },
  ));
};

const requireStripeReturnCurrency = value => {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw returnSettlementError(
      'Stripe return settlement currency is invalid.',
      'RETURN_SETTLEMENT_CURRENCY_INVALID',
    );
  }
  const currency = value.toUpperCase();
  if (!isSupportedCurrency(currency)) {
    throw returnSettlementError(
      'Stripe return settlement currency is invalid.',
      'RETURN_SETTLEMENT_CURRENCY_INVALID',
    );
  }
  return currency;
};

const requireReturnSettlementAttemptCounter = (request, { allowZero = false } = {}) => {
  const attempt = request?.settlement?.attempt;
  if (
    typeof attempt !== 'number'
    || !Number.isSafeInteger(attempt)
    || attempt < (allowZero ? 0 : 1)
  ) {
    throw returnSettlementError(
      'The return payment attempt snapshot is invalid.',
      'RETURN_SETTLEMENT_SETUP_INVALID',
      503,
    );
  }
  return attempt;
};

const returnSettlementAttempt = request => requireReturnSettlementAttemptCounter(request);

const returnSettlementExpiryUnix = request => {
  const expiresAt = new Date(request?.settlement?.stripeExpiresAt || 0);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= 0) {
    throw returnSettlementError(
      'The return payment setup snapshot is incomplete.',
      'RETURN_SETTLEMENT_SETUP_INVALID',
      503
    );
  }
  return Math.floor(expiresAt.getTime() / 1000);
};

const returnSettlementMetadata = request => ({
  type: 'return_settlement',
  returnRequestId: String(request._id),
  returnNumber: String(request.returnNumber || ''),
  sellerId: String(request.seller || ''),
  buyerId: String(request.buyer || ''),
  attempt: String(returnSettlementAttempt(request)),
  amountMinor: String(returnSettlementMinor(request)),
  currency: requireStoredReturnCurrency(request.currency),
  stripeMode: String(request.settlement?.stripeMode || ''),
  clientSurface: (() => {
    const surface = request.settlement?.clientSurface;
    if (!['web', 'mobile'].includes(surface)) {
      throw returnSettlementError(
        'The return payment client snapshot is invalid.',
        'RETURN_SETTLEMENT_SETUP_INVALID',
        503,
      );
    }
    return surface;
  })(),
});

const createReturnSettlementStripeSession = request => {
  if (!stripe) {
    throw returnSettlementError(
      'Card payments are not configured.',
      'CARD_PAYMENTS_UNAVAILABLE',
      503
    );
  }
  const stripeMode = request?.settlement?.stripeMode;
  if (!['test', 'live'].includes(stripeMode)) {
    throw returnSettlementError(
      'The return payment mode snapshot is incomplete.',
      'RETURN_SETTLEMENT_SETUP_INVALID',
      503
    );
  }
  if (!request.settlement?.stripeSuccessUrl || !request.settlement?.stripeCancelUrl) {
    throw returnSettlementError(
      'The return payment redirect snapshot is incomplete.',
      'RETURN_SETTLEMENT_SETUP_INVALID',
      503
    );
  }
  const metadata = returnSettlementMetadata(request);

  return stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: request.settlement.stripeCustomerEmail || undefined,
    client_reference_id: String(request._id),
    payment_intent_data: { metadata },
    line_items: [{
      price_data: {
        currency: request.currency.toLowerCase(),
        product_data: {
          name: `Return refund ${request.returnNumber}`,
          description: `Funds the buyer Rozare Wallet refund for order ${request.orderId}`,
        },
        unit_amount: returnSettlementMinor(request),
      },
      quantity: 1,
    }],
    success_url: request.settlement.stripeSuccessUrl,
    cancel_url: request.settlement.stripeCancelUrl,
    expires_at: returnSettlementExpiryUnix(request),
    metadata,
  }, {
    idempotencyKey: [
      'rozare-return-checkout',
      stripeMode,
      request._id,
      `attempt-${returnSettlementAttempt(request)}`,
    ].join(':'),
  });
};

const validateReturnSettlementSession = (request, stripeSession) => {
  if (!request || !stripeSession?.id) {
    throw returnSettlementError(
      'Stripe return settlement recovery is missing its request or session.',
      'RETURN_SETTLEMENT_REFERENCE_MISSING'
    );
  }
  if (String(request.settlement?.stripeSessionId || '') !== stripeSession.id) {
    throw returnSettlementError(
      'The Stripe session does not belong to this return settlement.',
      'RETURN_SETTLEMENT_SESSION_MISMATCH'
    );
  }
  if (stripeSession.mode !== 'payment') {
    throw returnSettlementError(
      'The Stripe return settlement has an invalid mode.',
      'RETURN_SETTLEMENT_MODE_MISMATCH'
    );
  }
  if (String(stripeSession.client_reference_id || '') !== String(request._id)) {
    throw returnSettlementError(
      'The Stripe return settlement reference is invalid.',
      'RETURN_SETTLEMENT_REFERENCE_MISMATCH'
    );
  }
  if (
    !Number.isSafeInteger(stripeSession.amount_total)
    || stripeSession.amount_total <= 0
    || stripeSession.amount_total !== returnSettlementMinor(request)
    || requireStripeReturnCurrency(stripeSession.currency) !== requireStoredReturnCurrency(request.currency)
  ) {
    throw returnSettlementError(
      'Stripe return settlement amount or currency did not match.',
      'RETURN_SETTLEMENT_AMOUNT_MISMATCH'
    );
  }

  const actualMetadata = stripeSession.metadata || {};
  const commonMetadata = {
    type: 'return_settlement',
    returnRequestId: String(request._id),
    returnNumber: String(request.returnNumber || ''),
    sellerId: String(request.seller || ''),
    buyerId: String(request.buyer || ''),
  };
  if (Object.entries(commonMetadata).some(([key, value]) => (
    typeof actualMetadata[key] !== 'string' || actualMetadata[key] !== value
  ))) {
    throw returnSettlementError(
      'The Stripe return settlement metadata is invalid.',
      'RETURN_SETTLEMENT_METADATA_MISMATCH'
    );
  }

  // A stored Stripe ID is still an authoritative ownership boundary for
  // settlements created before durable setup snapshots existed. Validate the
  // original immutable fields above, then apply the stricter snapshot contract
  // to every newly-created attempt.
  const stripeMode = request.settlement?.stripeMode;
  const hasDurableSnapshot = ['test', 'live'].includes(stripeMode)
    && request.settlement?.setupState !== 'unknown'
    && request.settlement?.stripeExpiresAt;
  if (!hasDurableSnapshot) return true;

  const expectedMetadata = returnSettlementMetadata(request);
  if (Object.entries(expectedMetadata).some(([key, value]) => (
    typeof actualMetadata[key] !== 'string' || actualMetadata[key] !== value
  ))) {
    throw returnSettlementError(
      'The Stripe return settlement snapshot metadata is invalid.',
      'RETURN_SETTLEMENT_METADATA_MISMATCH'
    );
  }
  if (
    typeof stripeSession.livemode !== 'boolean'
    || stripeSession.livemode !== (stripeMode === 'live')
  ) {
    throw returnSettlementError(
      'The Stripe return settlement environment is invalid.',
      'RETURN_SETTLEMENT_ENVIRONMENT_MISMATCH'
    );
  }
  if (
    typeof stripeSession.expires_at !== 'number'
    || !Number.isSafeInteger(stripeSession.expires_at)
    || stripeSession.expires_at !== returnSettlementExpiryUnix(request)
  ) {
    throw returnSettlementError(
      'The Stripe return settlement expiry is invalid.',
      'RETURN_SETTLEMENT_EXPIRY_MISMATCH'
    );
  }
  return true;
};

const attachReturnSettlementReference = async ({ request, stripeSession }) => {
  if (request?.settlement?.stripeSessionId) {
    validateReturnSettlementSession(request, stripeSession);
    return runInTransaction(async (session) => {
      const current = await queryWithSession(ReturnRequest.findById(request._id), session);
      if (!current) {
        throw returnSettlementError('Return request not found.', 'RETURN_REQUEST_NOT_FOUND', 404);
      }
      validateReturnSettlementSession(current, stripeSession);
      const order = await queryWithSession(Order.findById(current.order).lean(), session);
      if (!order) {
        throw returnSettlementError('The return order no longer exists.', 'RETURN_ORDER_MISSING', 409);
      }
      await notifyBuyerReturnStatus(current, order, '', { session });
      return current;
    });
  }
  if (
    request?.status !== 'accepted_pending_payment'
    || request?.settlement?.status !== 'pending_payment'
    || request?.settlement?.setupState !== 'creating'
  ) {
    throw returnSettlementError(
      'This return payment reference cannot be attached in the current state.',
      'RETURN_SETTLEMENT_RECOVERY_REQUIRED',
      503
    );
  }

  const candidate = typeof request.toObject === 'function'
    ? request.toObject({ depopulate: true })
    : { ...request, settlement: { ...(request.settlement || {}) } };
  candidate.settlement = { ...(candidate.settlement || {}), stripeSessionId: stripeSession.id };
  validateReturnSettlementSession(candidate, stripeSession);

  return runInTransaction(async (session) => {
    const attached = await ReturnRequest.findOneAndUpdate(
      {
        _id: request._id,
        status: 'accepted_pending_payment',
        'settlement.status': 'pending_payment',
        'settlement.setupState': 'creating',
        'settlement.attempt': returnSettlementAttempt(request),
        $or: [
          { 'settlement.stripeSessionId': null },
          { 'settlement.stripeSessionId': '' },
          { 'settlement.stripeSessionId': { $exists: false } },
        ],
      },
      {
        $set: {
          'settlement.stripeSessionId': stripeSession.id,
          'settlement.setupState': 'ready',
        },
      },
      { new: true, session }
    );
    if (attached) {
      validateReturnSettlementSession(attached, stripeSession);
      const order = await queryWithSession(Order.findById(attached.order).lean(), session);
      if (!order) {
        throw returnSettlementError('The return order no longer exists.', 'RETURN_ORDER_MISSING', 409);
      }
      await notifyBuyerReturnStatus(attached, order, '', { session });
      return attached;
    }

    const current = await queryWithSession(ReturnRequest.findById(request._id), session);
    if (!current) {
      throw returnSettlementError('Return request not found.', 'RETURN_REQUEST_NOT_FOUND', 404);
    }
    validateReturnSettlementSession(current, stripeSession);
    const order = await queryWithSession(Order.findById(current.order).lean(), session);
    if (!order) {
      throw returnSettlementError('The return order no longer exists.', 'RETURN_ORDER_MISSING', 409);
    }
    await notifyBuyerReturnStatus(current, order, '', { session });
    return current;
  });
};

const markDefinitiveReturnSetupFailure = async (request, error) =>
  ReturnRequest.findOneAndUpdate(
    {
      _id: request._id,
      status: 'accepted_pending_payment',
      'settlement.status': 'pending_payment',
      'settlement.setupState': 'creating',
      'settlement.attempt': returnSettlementAttempt(request),
      $or: [
        { 'settlement.stripeSessionId': null },
        { 'settlement.stripeSessionId': '' },
        { 'settlement.stripeSessionId': { $exists: false } },
      ],
    },
    {
      $set: {
        status: 'under_review',
        'settlement.status': 'failed',
        'settlement.setupState': 'closed',
        'settlement.failureReason': cleanNote(error.message, 500),
      },
      $push: {
        statusHistory: {
          status: 'under_review',
          note: 'Card payment could not be started. Seller can try again.',
          changedBy: request.seller,
          actorRole: 'seller',
          changedAt: new Date(),
        },
      },
    },
    { new: true }
  );

const recoverReturnSettlementSetup = async (request, { newlyClaimed = false } = {}) => {
  let stripeSession;
  try {
    stripeSession = await createReturnSettlementStripeSession(request);
  } catch (error) {
    // A definitive rejection proves that this specific first create did not
    // produce a Stripe object. During replay, however, an earlier ambiguous
    // call may already have succeeded, so every later error must fail closed.
    const authoritativeReplayRejection = !newlyClaimed
      && isAuthoritativeStripeIdempotentReplayRejection(error, {
        createdAt: request.settlement?.stripeSetupStartedAt,
      });
    if (
      (newlyClaimed && isDefinitiveStripeCreationError(error))
      || authoritativeReplayRejection
    ) {
      await markDefinitiveReturnSetupFailure(request, error);
      throw error;
    }
    throw returnSettlementError(
      'Stripe may still be creating this return payment. Retry the same action shortly.',
      'RETURN_SETTLEMENT_RECOVERY_PENDING',
      503,
      error
    );
  }

  try {
    const attached = await attachReturnSettlementReference({ request, stripeSession });
    return { returnRequest: attached, session: stripeSession };
  } catch (error) {
    throw returnSettlementError(
      'The return payment was created but its secure reference is still being recovered. Retry shortly.',
      'RETURN_SETTLEMENT_RECOVERY_PENDING',
      503,
      error
    );
  }
};

const createReturnSettlementCheckout = async ({ returnRequestId, sellerId, platform = 'web' }) => {
  if (!stripe) {
    throw returnSettlementError(
      'Card payments are not configured.',
      'CARD_PAYMENTS_UNAVAILABLE',
      503
    );
  }

  let request = await ReturnRequest.findOne({ _id: returnRequestId, seller: sellerId });
  if (!request) {
    throw returnSettlementError('Return request not found.', 'RETURN_REQUEST_NOT_FOUND', 404);
  }
  await assertReturnRequestFinancialIdentity(request);
  await assertWalletOrderFundingReturnable({ orderId: request.order });

  if (request.status === 'accepted_pending_payment') {
    let existingSession;
    if (request.settlement?.stripeSessionId) {
      existingSession = await stripe.checkout.sessions.retrieve(request.settlement.stripeSessionId);
      validateReturnSettlementSession(request, existingSession);
    } else if (request.settlement?.setupState === 'creating') {
      const recovered = await recoverReturnSettlementSetup(request);
      request = recovered.returnRequest;
      existingSession = recovered.session;
    } else {
      throw returnSettlementError(
        'This legacy return payment has no trustworthy Stripe reference. Contact support before retrying.',
        'RETURN_SETTLEMENT_RECOVERY_REQUIRED',
        503
      );
    }

    const referenceReady = request.settlement?.stripeSessionId
      && ['ready', 'unknown'].includes(request.settlement?.setupState || 'unknown');
    if (
      request.status !== 'accepted_pending_payment'
      || request.settlement?.status !== 'pending_payment'
      || !referenceReady
    ) {
      const completed = request.status === 'returned' && request.settlement?.status === 'completed';
      throw returnSettlementError(
        completed
          ? 'The seller payment completed and the refund is being verified. Refresh shortly.'
          : 'This return payment attempt closed while Stripe setup was being recovered.',
        completed ? 'RETURN_SETTLEMENT_PROCESSING' : 'RETURN_SETTLEMENT_ATTEMPT_CLOSED',
        409
      );
    }
    if (existingSession?.payment_status === 'paid' || existingSession?.status === 'complete') {
      throw returnSettlementError(
        'The seller payment completed and the refund is being verified. Refresh shortly.',
        'RETURN_SETTLEMENT_PROCESSING',
        409
      );
    }
    if (existingSession?.status === 'open' && existingSession.url) {
      return { returnRequest: request, session: existingSession };
    }
    await failReturnCardSettlement(
      existingSession,
      'The previous seller card checkout expired or was not completed.'
    );
    request = await ReturnRequest.findOne({ _id: returnRequestId, seller: sellerId });
  }

  if (request.status !== 'under_review') {
    throw returnSettlementError(
      'The return must be under review before it can be accepted.',
      'RETURN_NOT_UNDER_REVIEW',
      409
    );
  }
  requireReturnSettlementAttemptCounter(request, { allowZero: true });

  const seller = await User.findById(sellerId).select('email').lean();
  const frontendUrl = process.env.FRONTEND_URL || 'https://rozare.com';
  const clientSurface = platform === 'mobile' ? 'mobile' : 'web';
  const isMobile = clientSurface === 'mobile';
  const stripeSetupStartedAt = new Date();
  // Stripe requires at least 30 minutes for a hosted session. Keep a small
  // deterministic replay window without leaving refund funding open for hours.
  const stripeExpiresAt = new Date(stripeSetupStartedAt.getTime() + 35 * 60 * 1000);
  const stripeSuccessUrl = isMobile
    ? `rozare://seller-returns?tab=returns&return_payment=success&returnId=${request._id}`
    : `${frontendUrl}/seller-dashboard/order-management?tab=returns&return_payment=success&returnId=${request._id}`;
  const stripeCancelUrl = isMobile
    ? `rozare://seller-returns?tab=returns&return_payment=cancelled&returnId=${request._id}`
    : `${frontendUrl}/seller-dashboard/order-management?tab=returns&return_payment=cancelled&returnId=${request._id}`;

  request = await runInTransaction(async session => {
    await SellerSettlementLock.findOneAndUpdate(
      { seller: sellerId },
      { $setOnInsert: { seller: sellerId }, $inc: { version: 1 } },
      { upsert: true, new: true, session },
    );
    const candidate = await queryWithSession(
      ReturnRequest.findOne({ _id: request._id, seller: sellerId, status: 'under_review' }),
      session,
    );
    if (!candidate) return null;
    await assertWalletOrderFundingReturnable({ orderId: candidate.order, session });
    const { order, sellerEntitlement } = await assertReturnRequestFinancialIdentity(candidate, { session });
    const shippingAllocation = await buildSettlementShippingAllocation({
      request: candidate,
      order,
      sellerEntitlement,
      session,
    });
    const financialFilter = shippingAllocation
      ? {
        'refund.shippingAmount': shippingAllocation.previousShippingAmount,
        'refund.totalAmount': shippingAllocation.previousTotalAmount,
      }
      : {};
    const updated = await ReturnRequest.findOneAndUpdate(
      {
        _id: candidate._id,
        seller: sellerId,
        status: 'under_review',
        ...financialFilter,
      },
      {
        $set: {
          ...(shippingAllocation?.set || {}),
          status: 'accepted_pending_payment',
          'settlement.fundingSource': 'card',
          'settlement.status': 'pending_payment',
          'settlement.setupState': 'creating',
          'settlement.stripeMode': STRIPE_MODE,
          'settlement.stripeSetupStartedAt': stripeSetupStartedAt,
          'settlement.stripeExpiresAt': stripeExpiresAt,
          'settlement.clientSurface': clientSurface,
          'settlement.stripeCustomerEmail': cleanNote(seller?.email, 320),
          'settlement.stripeSuccessUrl': stripeSuccessUrl,
          'settlement.stripeCancelUrl': stripeCancelUrl,
          'settlement.stripeSessionId': null,
          'settlement.stripePaymentIntentId': null,
          'settlement.failureReason': '',
        },
        $inc: { 'settlement.attempt': 1 },
        $push: {
          statusHistory: {
            status: 'accepted_pending_payment',
            note: 'Seller accepted the return and is funding the wallet refund by card.',
            changedBy: sellerId,
            actorRole: 'seller',
            changedAt: new Date(),
          },
        },
      },
      {
        new: true,
        session,
        runValidators: true,
        overwriteImmutable: Boolean(shippingAllocation),
      },
    );
    if (updated) await assertReturnRequestFinancialIdentity(updated, { session });
    return updated;
  });
  if (!request) {
    throw returnSettlementError(
      'This return was updated by another request. Refresh and try again.',
      'RETURN_SETTLEMENT_CONFLICT',
      409
    );
  }

  const recovered = await recoverReturnSettlementSetup(request, { newlyClaimed: true });
  if (
    recovered.returnRequest.status !== 'accepted_pending_payment'
    || recovered.returnRequest.settlement?.status !== 'pending_payment'
    || recovered.returnRequest.settlement?.setupState !== 'ready'
  ) {
    const completed = recovered.returnRequest.status === 'returned'
      && recovered.returnRequest.settlement?.status === 'completed';
    throw returnSettlementError(
      completed
        ? 'The seller payment completed and the refund is being verified. Refresh shortly.'
        : 'This return payment attempt closed while Stripe setup was being recovered.',
      completed ? 'RETURN_SETTLEMENT_PROCESSING' : 'RETURN_SETTLEMENT_ATTEMPT_CLOSED',
      409
    );
  }
  if (recovered.session?.payment_status === 'paid' || recovered.session?.status === 'complete') {
    throw returnSettlementError(
      'The seller payment completed and the refund is being verified. Refresh shortly.',
      'RETURN_SETTLEMENT_PROCESSING',
      409
    );
  }
  if (recovered.session?.status !== 'open' || !recovered.session?.url) {
    await failReturnCardSettlement(
      recovered.session,
      'The seller card checkout closed before it could be returned.'
    );
    throw returnSettlementError(
      'The seller card checkout closed before it could be returned. Retry to start a new payment.',
      'RETURN_SETTLEMENT_ATTEMPT_CLOSED',
      409
    );
  }
  return recovered;
};

const refundRiskBlockedReturnSettlement = async ({ request, stripeSession, riskError: blockedRisk }) => {
  const paymentIntentId = typeof stripeSession.payment_intent === 'string'
    ? stripeSession.payment_intent
    : stripeSession.payment_intent?.id;
  if (!/^pi_[A-Za-z0-9_]+$/.test(String(paymentIntentId || ''))) {
    throw returnSettlementError(
      'The captured seller payment requires a safety refund, but its Stripe PaymentIntent is invalid.',
      'RETURN_SETTLEMENT_RISK_REFUND_UNAVAILABLE',
      503,
      blockedRisk,
    );
  }

  // Close the Wallet-credit path before the external refund call. The same
  // seller settlement lock used by ordinary completion makes this atomic with
  // the transaction that could otherwise credit the buyer while Stripe is
  // refunding the seller. A crash after this claim is recoverable with the
  // deterministic Stripe idempotency key below.
  request = await runInTransaction(async session => {
    await SellerSettlementLock.findOneAndUpdate(
      { seller: request.seller },
      { $setOnInsert: { seller: request.seller }, $inc: { version: 1 } },
      { upsert: true, new: true, session },
    );
    const claimed = await ReturnRequest.findOneAndUpdate({
      _id: request._id,
      status: 'accepted_pending_payment',
      'settlement.fundingSource': 'card',
      'settlement.status': 'pending_payment',
      'settlement.walletTransaction': null,
      'settlement.stripePaymentIntentId': { $in: [null, paymentIntentId] },
      'settlement.riskRefundId': { $in: [null, request.settlement?.riskRefundId || null] },
    }, {
      $set: {
        'settlement.status': 'failed',
        'settlement.setupState': 'closed',
        'settlement.stripePaymentIntentId': paymentIntentId,
        'settlement.failureReason': 'The original Wallet funding was reversed. The captured seller card payment requires a Stripe safety refund; no buyer Wallet credit was granted.',
      },
    }, { new: true, runValidators: true, context: 'query', session });
    if (claimed) return claimed;

    const current = await queryWithSession(ReturnRequest.findById(request._id), session);
    const resumable = current?.status === 'accepted_pending_payment'
      && current?.settlement?.fundingSource === 'card'
      && current?.settlement?.status === 'failed'
      && current?.settlement?.setupState === 'closed'
      && !current?.settlement?.walletTransaction
      && current?.settlement?.stripePaymentIntentId === paymentIntentId
      && (!current?.settlement?.riskRefundId
        || /^re_[A-Za-z0-9_]+$/.test(current.settlement.riskRefundId));
    if (!resumable) {
      throw returnSettlementError(
        'The return settlement changed before its safety refund could be claimed. No automatic refund or Wallet credit was attempted.',
        'RETURN_SETTLEMENT_RISK_REFUND_CONFLICT',
        409,
        blockedRisk,
      );
    }
    return current;
  });

  const canRetrieve = typeof stripe?.refunds?.retrieve === 'function';
  const canCreate = typeof stripe?.refunds?.create === 'function';
  if ((request.settlement?.riskRefundId && !canRetrieve) || (!request.settlement?.riskRefundId && !canCreate)) {
    throw returnSettlementError(
      'The captured seller payment requires a safety refund, but Stripe is temporarily unavailable.',
      'RETURN_SETTLEMENT_RISK_REFUND_UNAVAILABLE',
      503,
      blockedRisk,
    );
  }
  let refund;
  if (request.settlement?.riskRefundId) {
    refund = await stripe.refunds.retrieve(request.settlement.riskRefundId);
  } else {
    refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      reason: 'requested_by_customer',
      metadata: {
        type: 'return_settlement_safety_refund',
        returnRequestId: String(request._id),
        originalOrderId: String(request.order),
      },
    }, {
      idempotencyKey: `return-settlement-risk-refund:${request._id}:${paymentIntentId}`,
    });
  }
  const refundId = String(refund?.id || '').trim();
  const refundStatus = String(refund?.status || '').trim();
  const refundPaymentIntentId = typeof refund?.payment_intent === 'string'
    ? refund.payment_intent
    : refund?.payment_intent?.id;
  const refundCurrency = typeof refund?.currency === 'string'
    ? refund.currency.trim().toUpperCase()
    : '';
  const refundAmountMinor = refund?.amount;
  const refundCreatedMs = Number.isSafeInteger(refund?.created) && refund.created > 0
    ? refund.created * 1000
    : null;
  const providerCreatedAt = Number.isSafeInteger(refundCreatedMs)
    ? new Date(refundCreatedMs)
    : null;
  const refundMetadata = refund?.metadata;
  const expectedMetadata = {
    type: 'return_settlement_safety_refund',
    returnRequestId: String(request._id),
    originalOrderId: String(request.order),
  };
  const metadataMatches = refundMetadata
    && typeof refundMetadata === 'object'
    && !Array.isArray(refundMetadata)
    && Object.entries(expectedMetadata).every(([key, value]) => (
      typeof refundMetadata[key] === 'string' && refundMetadata[key] === value
    ));
  let expectedAmountMinor;
  try {
    expectedAmountMinor = toMinorUnits(request?.refund?.totalAmount);
  } catch (_error) {
    expectedAmountMinor = null;
  }
  if (
    !/^re_[A-Za-z0-9_]+$/.test(refundId)
    || !['pending', 'requires_action', 'succeeded', 'failed', 'canceled'].includes(refundStatus)
    || refundPaymentIntentId !== paymentIntentId
    || !Number.isSafeInteger(refundAmountMinor)
    || refundAmountMinor <= 0
    || refundAmountMinor !== expectedAmountMinor
    || refundCurrency !== request?.currency
    || !providerCreatedAt
    || !Number.isFinite(providerCreatedAt.getTime())
    || refund?.reason !== 'requested_by_customer'
    || typeof refund?.livemode !== 'boolean'
    || refund.livemode !== (STRIPE_MODE === 'live')
    || !metadataMatches
  ) {
    throw returnSettlementError(
      'Stripe returned safety-refund evidence that does not match the frozen return funding.',
      'RETURN_SETTLEMENT_RISK_REFUND_MISMATCH',
      503,
      blockedRisk,
    );
  }
  const succeeded = refundStatus === 'succeeded';
  if (
    request.settlement?.riskRefundStatus === 'succeeded'
    && !succeeded
  ) {
    throw returnSettlementError(
      'Stripe returned a safety-refund state older than the completed durable snapshot.',
      'RETURN_SETTLEMENT_RISK_REFUND_SNAPSHOT_CONFLICT',
      503,
      blockedRisk,
    );
  }
  const updated = await runInTransaction(async session => {
    const changed = await ReturnRequest.findOneAndUpdate(
      {
        _id: request._id,
        status: 'accepted_pending_payment',
        'settlement.fundingSource': 'card',
        'settlement.status': 'failed',
        'settlement.setupState': 'closed',
        'settlement.walletTransaction': null,
        'settlement.stripePaymentIntentId': paymentIntentId,
        'settlement.riskRefundId': { $in: [null, refundId] },
        'settlement.riskRefundAmountMinor': { $in: [null, refundAmountMinor] },
        'settlement.riskRefundCurrency': { $in: [null, '', refundCurrency] },
      },
      {
        $set: {
          'settlement.status': 'failed',
          'settlement.setupState': 'closed',
          'settlement.stripePaymentIntentId': paymentIntentId,
          'settlement.failureReason': succeeded
            ? 'The seller card payment was refunded because the original Wallet funding had already been reversed.'
            : 'The seller card payment safety refund is processing; no buyer Wallet credit was granted.',
          'settlement.riskRefundId': refundId,
          'settlement.riskRefundStatus': refundStatus,
          'settlement.riskRefundAmountMinor': refundAmountMinor,
          'settlement.riskRefundCurrency': refundCurrency,
          'settlement.riskRefundedAt': succeeded ? providerCreatedAt : null,
        },
      },
      { new: true, runValidators: true, context: 'query', session },
    );
    const current = changed || await queryWithSession(ReturnRequest.findById(request._id), session);
    if (
      current?.status !== 'accepted_pending_payment'
      || current?.settlement?.fundingSource !== 'card'
      || current?.settlement?.status !== 'failed'
      || current?.settlement?.setupState !== 'closed'
      || current?.settlement?.walletTransaction
      || current?.settlement?.stripePaymentIntentId !== paymentIntentId
      || current?.settlement?.riskRefundId !== refundId
      || current?.settlement?.riskRefundStatus !== refundStatus
      || current?.settlement?.riskRefundAmountMinor !== refundAmountMinor
      || current?.settlement?.riskRefundCurrency !== refundCurrency
      || (succeeded && !sameReturnSettlementInstant(current?.settlement?.riskRefundedAt, providerCreatedAt))
      || (!succeeded && current?.settlement?.riskRefundedAt)
    ) {
      throw returnSettlementError(
        'The persisted return safety-refund snapshot conflicts with Stripe.',
        'RETURN_SETTLEMENT_RISK_REFUND_SNAPSHOT_CONFLICT',
        503,
        blockedRisk,
      );
    }
    if (succeeded) {
      await enqueueReturnSafetyRefundSellerNotification(current, { session });
    }
    return current;
  });
  if (!succeeded) {
    if (['failed', 'canceled'].includes(refundStatus)) {
      throw returnSettlementError(
        'Stripe could not complete the seller card safety refund. The return remains closed without a buyer Wallet credit and requires manual review.',
        'RETURN_SETTLEMENT_RISK_REFUND_FAILED',
        503,
        blockedRisk,
      );
    }
    throw returnSettlementError(
      'The seller card payment safety refund is still processing.',
      'RETURN_SETTLEMENT_RISK_REFUND_PENDING',
      503,
      blockedRisk,
    );
  }
  return updated || ReturnRequest.findById(request._id);
};

const completeReturnCardSettlement = async (stripeSession) => {
  const returnRequestId = stripeSession?.metadata?.returnRequestId;
  if (!returnRequestId) return null;
  if (stripeSession.payment_status !== 'paid') {
    throw returnSettlementError(
      'Stripe has not marked this return settlement as paid.',
      'RETURN_SETTLEMENT_NOT_PAID',
      409
    );
  }

  let current = await ReturnRequest.findById(returnRequestId);
  if (!current) {
    throw returnSettlementError(
      `Return request ${returnRequestId} was not found.`,
      'RETURN_REQUEST_NOT_FOUND',
      404
    );
  }
  await assertReturnRequestFinancialIdentity(current);
  current = await attachReturnSettlementReference({ request: current, stripeSession });

  const alreadyCompleted = current.status === 'returned'
    && current.settlement?.status === 'completed';
  if (!alreadyCompleted) {
    try {
      await assertWalletOrderFundingReturnable({ orderId: current.order });
    } catch (error) {
      if (error?.code !== 'RETURN_EXTERNAL_FUNDING_REVERSAL') throw error;
      return refundRiskBlockedReturnSettlement({ request: current, stripeSession, riskError: error });
    }
  }

  return runInTransaction(async (session) => {
    const request = await ReturnRequest.findById(returnRequestId).session(session);
    if (!request) {
      throw returnSettlementError(
        `Return request ${returnRequestId} was not found.`,
        'RETURN_REQUEST_NOT_FOUND',
        404
      );
    }
    await SellerSettlementLock.findOneAndUpdate(
      { seller: request.seller },
      { $setOnInsert: { seller: request.seller }, $inc: { version: 1 } },
      { upsert: true, new: true, session },
    );
    await assertReturnRequestFinancialIdentity(request, { session });
    validateReturnSettlementSession(request, stripeSession);
    if (request.status === 'returned' && request.settlement?.status === 'completed') {
      const order = await Order.findById(request.order)
        .select('_id orderId user shippingInfo')
        .session(session);
      if (!order) {
        throw returnSettlementError(
          'The original order for this completed return no longer exists.',
          'RETURN_ORDER_NOT_FOUND',
          409
        );
      }
      await enqueueReturnSettlementNotifications(request, order, { session });
      return request;
    }
    if (
      request.status !== 'accepted_pending_payment' ||
      request.settlement?.status !== 'pending_payment'
    ) {
      throw returnSettlementError(
        'Return settlement state did not match the Stripe session.',
        'RETURN_SETTLEMENT_STATE_MISMATCH',
        409
      );
    }
    await assertWalletOrderFundingReturnable({ orderId: request.order, session });

    const paymentIntentId = typeof stripeSession.payment_intent === 'string'
      ? stripeSession.payment_intent
      : stripeSession.payment_intent?.id;
    try {
      await claimStripePaymentCompletion({
        paymentIntentId,
        sourceType: 'return_settlement',
        sourceReferenceId: request._id,
        eventId: `checkout-session:${stripeSession.id}`,
        session,
      });
    } catch (error) {
      if (error?.code !== 'STRIPE_PAYMENT_REVERSED_BEFORE_COMPLETION') throw error;
      request.settlement.status = 'failed';
      request.settlement.setupState = 'closed';
      request.settlement.stripePaymentIntentId = paymentIntentId || null;
      request.settlement.failureReason = 'Stripe reversed this card payment before the buyer Wallet credit completed.';
      request.statusHistory.push({
        status: request.status,
        note: 'The seller card payment was reversed before the buyer Wallet was credited.',
        changedBy: null,
        actorRole: 'system',
      });
      await request.save({ session });
      return request;
    }

    const walletTransaction = await creditWalletInSession({
      userId: request.buyer,
      amount: request.refund.totalAmount,
      currency: request.currency,
      type: 'return_refund',
      referenceType: 'return_request',
      referenceId: request._id,
      idempotencyKey: `return-refund:${request._id}`,
      description: `Refund for return ${request.returnNumber}`,
      metadata: { orderId: request.orderId, sellerId: String(request.seller) },
      allowLocked: true,
    }, session);
    await attachReturnedWalletFundingProvenance({
      walletTransaction,
      orderId: request.order,
      sellerId: request.seller,
      returnRequestId: request._id,
      refundAmount: request.refund.totalAmount,
      currency: request.currency,
      session,
    });

    request.status = 'returned';
    request.settlement.status = 'completed';
    request.settlement.setupState = 'complete';
    request.settlement.stripePaymentIntentId = paymentIntentId || null;
    request.settlement.walletTransaction = walletTransaction._id;
    request.settlement.settledAt = new Date();
    request.statusHistory.push({
      status: 'returned',
      note: 'Seller card payment completed and the buyer wallet was credited.',
      changedBy: null,
      actorRole: 'system',
    });
    await request.save({ session });
    const order = await Order.findById(request.order)
      .select('_id orderId user shippingInfo')
      .session(session);
    if (!order) {
      throw returnSettlementError(
        'The original order for this return no longer exists.',
        'RETURN_ORDER_NOT_FOUND',
        409
      );
    }
    await enqueueReturnSettlementNotifications(request, order, { session, walletTransaction });
    await markStripePaymentCompletionDone({
      paymentIntentId,
      sourceType: 'return_settlement',
      sourceReferenceId: request._id,
      session,
    });
    return request;
  });
};

const failReturnCardSettlement = async (stripeSession, reason = 'Card payment expired or failed.') => {
  const returnRequestId = stripeSession?.metadata?.returnRequestId;
  if (!returnRequestId) return null;
  if (stripeSession.payment_status === 'paid') {
    throw returnSettlementError(
      'A paid return settlement cannot be marked as failed.',
      'RETURN_SETTLEMENT_ALREADY_PAID',
      409
    );
  }
  let request = await ReturnRequest.findById(returnRequestId);
  if (!request) {
    throw returnSettlementError(
      `Return request ${returnRequestId} was not found.`,
      'RETURN_REQUEST_NOT_FOUND',
      404
    );
  }
  request = await attachReturnSettlementReference({ request, stripeSession });
  return ReturnRequest.findOneAndUpdate(
    {
      _id: returnRequestId,
      status: 'accepted_pending_payment',
      'settlement.status': 'pending_payment',
      'settlement.stripeSessionId': stripeSession.id,
    },
    {
      $set: {
        status: 'under_review',
        'settlement.status': 'failed',
        'settlement.setupState': 'closed',
        'settlement.failureReason': cleanNote(reason, 500),
      },
      $push: {
        statusHistory: {
          status: 'under_review',
          note: 'Seller card payment expired or failed. A new payment can be started.',
          changedBy: null,
          actorRole: 'system',
          changedAt: new Date(),
        },
      },
    },
    { new: true }
  );
};

module.exports = {
  CLOSED_WITHOUT_CONSUMING_QUANTITY,
  BUYER_CANCELLABLE_STATUSES,
  UNRESOLVED_RETURN_STATUSES,
  REASON_CATEGORIES,
  getItemSellerMap,
  getSellerFulfillment,
  getSellerPolicy,
  buildOrderItemDiscountAllocations,
  buildOrderReturnEligibility,
  selectedReturnMoney,
  createReturnRequest,
  getReturnDetail,
  updateReturnStatus,
  cancelReturnRequest,
  settleFromSellerBalance,
  approveReplacement,
  createReturnSettlementCheckout,
  completeReturnCardSettlement,
  failReturnCardSettlement,
  __private: {
    normalizeReturnRequestKey,
    returnRequestStorageKey,
    normalizeReturnCreationInput,
    assertReturnReplayMatches,
    attachReturnSettlementReference,
    createReturnSettlementStripeSession,
    recoverReturnSettlementSetup,
    validateReturnSettlementSession,
  },
};
