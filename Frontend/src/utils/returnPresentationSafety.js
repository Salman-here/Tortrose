import {
  exactCurrencyCode,
  isExactNonNegativeJsonMoney,
  parseExactMoneyInput,
} from './sellerMoneySafety.js';
import {
  getOrderCurrency,
  getOrderItemLineSubtotal,
  getOrderItemQuantity,
  getOrderTotal,
} from './orderItems.js';

const RETURN_STATUSES = new Set([
  'requested', 'approved', 'pickup_scheduled', 'picked_up',
  'in_transit_to_seller', 'received_by_seller', 'under_review',
  'accepted_pending_payment', 'returned', 'replacement_approved',
  'rejected', 'cancelled_by_buyer',
]);
const REFUND_TYPES = new Set(['full_refund', 'replacement_only', 'store_credit']);
const ELIGIBILITY_REFUND_TYPES = new Set(['none', ...REFUND_TYPES]);
const FULFILLMENT_STATUSES = new Set([
  'pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled',
]);
const RETURN_ACTOR_ROLES = new Set(['buyer', 'seller', 'admin', 'system']);
const NON_CONSUMING_RETURN_STATUSES = new Set(['rejected', 'cancelled_by_buyer']);
const RETURN_REASON_CATEGORIES = new Set([
  'damaged', 'defective', 'wrong_item', 'not_as_described',
  'size_or_fit', 'changed_mind', 'other',
]);

const objectIdString = value => typeof value === 'string' && /^[a-f\d]{24}$/iu.test(value);
const positiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;
const finiteNonNegativeNumber = (value) => (
  typeof value === 'number'
  && Number.isFinite(value)
  && value >= 0
  && value <= Number.MAX_SAFE_INTEGER
);
const nonNegativeSafeInteger = value => Number.isSafeInteger(value) && value >= 0;
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value, key) => plainObject(value)
  && Object.prototype.hasOwnProperty.call(value, key);
const canonicalObjectId = value => (
  typeof value === 'string' && /^[a-f\d]{24}$/u.test(value) ? value : null
);
const referencedObjectId = (value, { nullable = false } = {}) => {
  if (nullable && value === null) return null;
  if (typeof value === 'string') return canonicalObjectId(value);
  return plainObject(value) ? canonicalObjectId(value._id) : null;
};
const canonicalText = (value, { min = 0, max = 500 } = {}) => (
  typeof value === 'string'
  && value === value.trim()
  && value.length >= min
  && value.length <= max
    ? value
    : null
);
const canonicalDate = (value) => {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) return null;
  return value;
};
const minorUnits = value => BigInt(parseExactMoneyInput(value).minorUnits);

const inspectEligibilityPolicy = (policy, path, errors) => {
  if (!plainObject(policy)) {
    errors.push(path);
    return null;
  }
  const returnsEnabled = policy.returnsEnabled;
  const returnDuration = policy.returnDuration;
  const refundType = policy.refundType;
  if (typeof returnsEnabled !== 'boolean') errors.push(`${path}.returnsEnabled`);
  if (!nonNegativeSafeInteger(returnDuration) || returnDuration > 365) {
    errors.push(`${path}.returnDuration`);
  }
  if (!ELIGIBILITY_REFUND_TYPES.has(refundType)) errors.push(`${path}.refundType`);
  if (returnsEnabled === false && (returnDuration !== 0 || refundType !== 'none')) {
    errors.push(`${path}.disabledCoherence`);
  }
  if (
    returnsEnabled === true
    && (!positiveSafeInteger(returnDuration) || refundType === 'none')
  ) errors.push(`${path}.enabledCoherence`);
  return {
    returnsEnabled,
    returnDuration,
    refundType,
  };
};

export const inspectBuyerReturnOrderContext = (order) => {
  const errors = [];
  const value = plainObject(order) ? order : {};
  const orderId = canonicalObjectId(value._id);
  const orderNumber = canonicalText(value.orderId, { min: 1, max: 200 });
  let currency = null;
  let totalAmount = null;
  try {
    const hasStoredCurrency = ['currency', 'displayCurrency', 'orderCurrency']
      .some(key => hasOwn(value, key) && value[key] !== null && value[key] !== undefined);
    const summary = plainObject(value.orderSummary) ? value.orderSummary : {};
    const hasStoredTotal = ['totalAmount', 'total']
      .some(key => hasOwn(summary, key) && summary[key] !== null && summary[key] !== undefined)
      || ['totalAmount', 'total']
        .some(key => hasOwn(value, key) && value[key] !== null && value[key] !== undefined);
    if (!hasStoredCurrency || !hasStoredTotal) throw new Error('missing');
    currency = exactCurrencyCode(getOrderCurrency(value));
    totalAmount = getOrderTotal(value);
    if (!currency || !isExactNonNegativeJsonMoney(totalAmount)) throw new Error('invalid');
  } catch (_) {
    errors.push('money');
  }
  if (!orderId) errors.push('orderId');
  if (!orderNumber) errors.push('orderNumber');

  const rawItems = Array.isArray(value.orderItems) ? value.orderItems : [];
  if (!rawItems.length) errors.push('items');
  const seen = new Set();
  const items = rawItems.map((item, index) => {
    const id = referencedObjectId(item?._id);
    const productId = referencedObjectId(item?.productId);
    const sellerId = item?.seller === null || item?.seller === undefined
      ? null
      : referencedObjectId(item.seller);
    const name = canonicalText(item?.name, { min: 1, max: 300 });
    let quantity = null;
    let lineSubtotal = null;
    try {
      quantity = getOrderItemQuantity(item);
      lineSubtotal = getOrderItemLineSubtotal(item);
      if (!positiveSafeInteger(quantity) || !isExactNonNegativeJsonMoney(lineSubtotal)) {
        throw new Error('invalid');
      }
    } catch (_) {
      errors.push(`items.${index}.moneyOrQuantity`);
    }
    if (!id || seen.has(id)) errors.push(`items.${index}.identity`);
    if (id) seen.add(id);
    if (!productId) errors.push(`items.${index}.productId`);
    if (item?.seller !== null && item?.seller !== undefined && !sellerId) {
      errors.push(`items.${index}.sellerId`);
    }
    if (!name) errors.push(`items.${index}.name`);
    return { id, productId, sellerId, name, quantity, lineSubtotal };
  });

  const valid = errors.length === 0;
  const validItems = valid ? items : [];
  return {
    valid,
    errors,
    orderId: valid ? orderId : null,
    orderNumber: valid ? orderNumber : null,
    currency: valid ? currency : null,
    totalAmount: valid ? totalAmount : null,
    items: validItems,
    itemById: new Map(validItems.map(item => [item.id, item])),
  };
};

export const inspectReturnPresentationSnapshot = (request) => {
  const errors = [];
  const value = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
  const currency = exactCurrencyCode(value.currency);
  if (!currency) errors.push('currency');
  if (!objectIdString(value._id)) errors.push('identity');
  if (!RETURN_STATUSES.has(value.status)) errors.push('status');

  const policy = value.policySnapshot;
  if (
    !policy
    || policy.returnsEnabled !== true
    || !positiveSafeInteger(policy.returnDuration)
    || policy.returnDuration > 365
    || !REFUND_TYPES.has(policy.refundType)
  ) errors.push('policy');
  if (
    (policy?.refundType === 'replacement_only'
      && ['accepted_pending_payment', 'returned'].includes(value.status))
    || (policy?.refundType !== 'replacement_only' && value.status === 'replacement_approved')
  ) errors.push('statusResolution');

  const items = Array.isArray(value.items) ? value.items : [];
  if (!items.length) errors.push('items');
  const seenOrderItems = new Set();
  let itemCount = 0;
  let itemCountValid = true;
  let lineSumMinor = 0n;
  let allLinesValid = items.length > 0;
  const itemPresentations = items.map((item, index) => {
    const quantityValid = positiveSafeInteger(item?.quantity);
    const purchasedQuantityValid = positiveSafeInteger(item?.purchasedQuantity);
    const quantityWithinPurchase = quantityValid
      && purchasedQuantityValid
      && item.quantity <= item.purchasedQuantity;
    const orderItemId = objectIdString(item?.orderItemId) ? item.orderItemId.toLowerCase() : null;
    const uniqueOrderItem = Boolean(orderItemId) && !seenOrderItems.has(orderItemId);
    if (orderItemId) seenOrderItems.add(orderItemId);
    const unitPriceValid = finiteNonNegativeNumber(item?.unitPrice);
    const line = isExactNonNegativeJsonMoney(item?.lineSubtotal)
      ? parseExactMoneyInput(item.lineSubtotal)
      : null;

    if (!quantityWithinPurchase) {
      errors.push(`items.${index}.quantity`);
      itemCountValid = false;
    } else if (itemCountValid) {
      const nextCount = itemCount + item.quantity;
      if (!Number.isSafeInteger(nextCount)) {
        errors.push('itemCount');
        itemCountValid = false;
      } else {
        itemCount = nextCount;
      }
    }
    if (!uniqueOrderItem) errors.push(`items.${index}.identity`);
    if (!unitPriceValid) errors.push(`items.${index}.unitPrice`);
    if (!line) {
      errors.push(`items.${index}.lineSubtotal`);
      allLinesValid = false;
    } else {
      lineSumMinor += BigInt(line.minorUnits);
    }

    return {
      quantity: quantityWithinPurchase ? item.quantity : null,
      lineSubtotal: line?.amount ?? null,
    };
  });

  const refundFields = ['itemSubtotal', 'taxAmount', 'shippingAmount', 'discountAmount', 'totalAmount'];
  const refund = {};
  const refundMinor = {};
  refundFields.forEach((field) => {
    const fieldValue = value.refund?.[field];
    const parsed = isExactNonNegativeJsonMoney(fieldValue)
      ? parseExactMoneyInput(fieldValue)
      : null;
    if (!parsed) {
      errors.push(`refund.${field}`);
      refund[field] = null;
      refundMinor[field] = null;
      return;
    }
    refund[field] = parsed.amount;
    refundMinor[field] = BigInt(parsed.minorUnits);
  });

  if (
    allLinesValid
    && refundMinor.itemSubtotal !== null
    && lineSumMinor !== refundMinor.itemSubtotal
  ) errors.push('refund.itemSubtotalReconciliation');

  if (refundFields.every(field => refundMinor[field] !== null)) {
    const grossMinor = refundMinor.itemSubtotal + refundMinor.taxAmount + refundMinor.shippingAmount;
    if (refundMinor.discountAmount > grossMinor) {
      errors.push('refund.discountAmountReconciliation');
    } else if (grossMinor - refundMinor.discountAmount !== refundMinor.totalAmount) {
      errors.push('refund.totalAmountReconciliation');
    }
    if (policy?.refundType !== 'replacement_only' && refundMinor.totalAmount === 0n) {
      errors.push('refund.totalAmountPositive');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    currency,
    itemCount: itemCountValid && items.length > 0 ? itemCount : null,
    items: itemPresentations,
    refund,
  };
};

export const inspectBuyerReturnEligibilityResponse = (payload, orderContext) => {
  const errors = [];
  const value = plainObject(payload) ? payload : {};
  if (!orderContext?.valid) errors.push('orderContext');
  if (value.success !== true) errors.push('success');
  if (value.orderId !== orderContext?.orderNumber) errors.push('orderId');
  const rawGroups = Array.isArray(value.groups) ? value.groups : null;
  if (!rawGroups) errors.push('groups');
  if (
    rawGroups
    && orderContext?.valid
    && rawGroups.length > orderContext.items.length
  ) {
    errors.push('groupCount');
  }

  const seenSellers = new Set();
  const seenOrderItems = new Set();
  const groups = (rawGroups || []).map((group, groupIndex) => {
    const prefix = `groups.${groupIndex}`;
    const sellerId = referencedObjectId(group?.seller);
    const sellerName = plainObject(group?.seller)
      ? canonicalText(group.seller.username, { max: 120 })
      : null;
    if (!sellerId || seenSellers.has(sellerId)) errors.push(`${prefix}.seller`);
    if (sellerId) seenSellers.add(sellerId);
    if (sellerName === null) errors.push(`${prefix}.sellerName`);

    const storeId = plainObject(group?.store)
      ? referencedObjectId(group.store._id, { nullable: true })
      : undefined;
    const storeName = plainObject(group?.store)
      ? canonicalText(group.store.storeName, { max: 120 })
      : null;
    if (storeId === undefined || (group?.store?._id !== null && !storeId)) {
      errors.push(`${prefix}.store`);
    }
    if (storeName === null) errors.push(`${prefix}.storeName`);

    const policy = inspectEligibilityPolicy(group?.policy, `${prefix}.policy`, errors);
    if (!['order_snapshot', 'current_store_policy'].includes(group?.policySource)) {
      errors.push(`${prefix}.policySource`);
    }
    const fulfillmentStatus = group?.fulfillment?.status;
    const deliveredAt = group?.fulfillment?.deliveredAt === null
      ? null
      : canonicalDate(group?.fulfillment?.deliveredAt);
    if (!plainObject(group?.fulfillment) || !FULFILLMENT_STATUSES.has(fulfillmentStatus)) {
      errors.push(`${prefix}.fulfillment`);
    }
    if (group?.fulfillment?.deliveredAt !== null && !deliveredAt) {
      errors.push(`${prefix}.fulfillment.deliveredAt`);
    }
    const groupDeadline = group?.eligibilityDeadline === null
      ? null
      : canonicalDate(group?.eligibilityDeadline);
    if (group?.eligibilityDeadline !== null && !groupDeadline) {
      errors.push(`${prefix}.eligibilityDeadline`);
    }
    if (typeof group?.eligible !== 'boolean') errors.push(`${prefix}.eligible`);
    const groupReason = canonicalText(group?.reason, { max: 500 });
    if (groupReason === null) errors.push(`${prefix}.reason`);

    const rawItems = Array.isArray(group?.items) ? group.items : [];
    if (!rawItems.length) errors.push(`${prefix}.items`);
    const items = rawItems.map((item, itemIndex) => {
      const itemPrefix = `${prefix}.items.${itemIndex}`;
      const orderItemId = referencedObjectId(item?.orderItemId);
      const productId = referencedObjectId(item?.productId);
      const expected = orderContext?.itemById?.get(orderItemId);
      const name = canonicalText(item?.name, { min: 1, max: 300 });
      const image = canonicalText(item?.image, { max: 5000 });
      const purchasedQuantity = item?.purchasedQuantity;
      const alreadyRequestedQuantity = item?.alreadyRequestedQuantity;
      const remainingReturnableQuantity = item?.remainingReturnableQuantity;
      const unitPrice = item?.unitPrice;
      const lineSubtotal = item?.lineSubtotal;
      const itemPolicy = inspectEligibilityPolicy(
        item?.returnPolicy,
        `${itemPrefix}.returnPolicy`,
        errors,
      );
      const itemDeadline = item?.eligibilityDeadline === null
        ? null
        : canonicalDate(item?.eligibilityDeadline);
      const itemReason = canonicalText(item?.reason, { max: 500 });

      if (!orderItemId || seenOrderItems.has(orderItemId) || !expected) {
        errors.push(`${itemPrefix}.orderItemId`);
      }
      if (orderItemId) seenOrderItems.add(orderItemId);
      if (!productId || productId !== expected?.productId) errors.push(`${itemPrefix}.productId`);
      if (!name || name !== expected?.name) errors.push(`${itemPrefix}.name`);
      if (image === null) errors.push(`${itemPrefix}.image`);
      if (!positiveSafeInteger(purchasedQuantity) || purchasedQuantity !== expected?.quantity) {
        errors.push(`${itemPrefix}.purchasedQuantity`);
      }
      if (
        !nonNegativeSafeInteger(alreadyRequestedQuantity)
        || alreadyRequestedQuantity > purchasedQuantity
      ) errors.push(`${itemPrefix}.alreadyRequestedQuantity`);
      if (
        !nonNegativeSafeInteger(remainingReturnableQuantity)
        || remainingReturnableQuantity !== purchasedQuantity - alreadyRequestedQuantity
      ) errors.push(`${itemPrefix}.remainingReturnableQuantity`);
      if (
        !finiteNonNegativeNumber(unitPrice)
        || !expected
        || unitPrice !== expected.lineSubtotal / expected.quantity
      ) errors.push(`${itemPrefix}.unitPrice`);
      if (
        !isExactNonNegativeJsonMoney(lineSubtotal)
        || lineSubtotal !== expected?.lineSubtotal
      ) errors.push(`${itemPrefix}.lineSubtotal`);
      if (expected?.sellerId && expected.sellerId !== sellerId) errors.push(`${itemPrefix}.seller`);
      if (item?.eligibilityDeadline !== null && !itemDeadline) {
        errors.push(`${itemPrefix}.eligibilityDeadline`);
      }
      if (itemReason === null) errors.push(`${itemPrefix}.reason`);
      if (typeof item?.eligible !== 'boolean') errors.push(`${itemPrefix}.eligible`);

      const expectedDeadline = deliveredAt && positiveSafeInteger(itemPolicy?.returnDuration)
        ? new Date(new Date(deliveredAt).getTime() + itemPolicy.returnDuration * 86400000).toISOString()
        : null;
      if (itemDeadline !== expectedDeadline) errors.push(`${itemPrefix}.deadlineCoherence`);
      const structurallyEligible = itemPolicy?.returnsEnabled === true
        && itemPolicy.refundType !== 'none'
        && fulfillmentStatus === 'delivered'
        && Boolean(deliveredAt)
        && Boolean(itemDeadline)
        && remainingReturnableQuantity > 0;
      if (item?.eligible && (!structurallyEligible || itemReason !== '')) {
        errors.push(`${itemPrefix}.eligibleCoherence`);
      }
      if (item?.eligible === false && !itemReason) errors.push(`${itemPrefix}.reasonCoherence`);

      return {
        orderItemId,
        productId,
        name,
        image,
        purchasedQuantity,
        alreadyRequestedQuantity,
        remainingReturnableQuantity,
        unitPrice,
        lineSubtotal,
        returnPolicy: itemPolicy,
        eligibilityDeadline: itemDeadline,
        eligible: item?.eligible,
        reason: itemReason,
      };
    });

    const eligibleItems = items.filter(item => item.eligible === true);
    const expectedGroupDeadline = eligibleItems.length
      ? eligibleItems.reduce((latest, item) => (
        !latest || item.eligibilityDeadline > latest ? item.eligibilityDeadline : latest
      ), null)
      : null;
    if (group?.eligible !== (eligibleItems.length > 0)) errors.push(`${prefix}.eligibleCoherence`);
    if (group?.eligible === true && groupReason !== '') errors.push(`${prefix}.reasonCoherence`);
    if (group?.eligible === false && !groupReason) errors.push(`${prefix}.reasonCoherence`);
    if (groupDeadline !== expectedGroupDeadline) errors.push(`${prefix}.deadlineCoherence`);
    const variants = [...new Set(items.map(item => item.returnPolicy?.refundType))];
    if (
      !Array.isArray(group?.policyVariants)
      || group.policyVariants.length !== variants.length
      || group.policyVariants.some((variant, index) => variant !== variants[index])
    ) errors.push(`${prefix}.policyVariants`);

    return {
      seller: { _id: sellerId, username: sellerName },
      store: { _id: storeId, storeName },
      policy,
      policyVariants: variants,
      policySource: group?.policySource,
      fulfillment: { status: fulfillmentStatus, deliveredAt },
      eligibilityDeadline: groupDeadline,
      eligible: group?.eligible,
      reason: groupReason,
      items,
    };
  });

  if (orderContext?.valid && seenOrderItems.size !== orderContext.items.length) {
    errors.push('itemCoverage');
  }

  const valid = errors.length === 0;
  return { valid, errors, groups: valid ? groups : [] };
};

export const inspectBuyerReturnRequest = (request, orderContext) => {
  const errors = [];
  const value = plainObject(request) ? request : {};
  const financial = inspectReturnPresentationSnapshot(value);
  if (!financial.valid) errors.push(...financial.errors.map(error => `financial.${error}`));
  if (!orderContext?.valid) errors.push('orderContext');

  const id = canonicalObjectId(value._id);
  const orderId = referencedObjectId(value.order);
  const buyerId = referencedObjectId(value.buyer);
  const sellerId = referencedObjectId(value.seller);
  const sellerName = plainObject(value.seller)
    ? canonicalText(value.seller.username, { max: 120 })
    : '';
  const storeId = value.store === null ? null : referencedObjectId(value.store);
  const storeName = canonicalText(value.storeName, { max: 120 });
  const returnNumber = canonicalText(value.returnNumber, { min: 1, max: 128 });
  const reasonCategory = RETURN_REASON_CATEGORIES.has(value.reasonCategory)
    ? value.reasonCategory
    : null;
  const reasonDetails = canonicalText(value.reasonDetails, { min: 10, max: 1500 });
  const requestedAt = canonicalDate(value.requestedAt);
  const eligibilityDeadline = canonicalDate(value.eligibilityDeadline);
  const createdAt = canonicalDate(value.createdAt);
  const updatedAt = canonicalDate(value.updatedAt);

  if (!id) errors.push('identity');
  if (!orderId || orderId !== orderContext?.orderId) errors.push('order');
  if (value.orderId !== orderContext?.orderNumber) errors.push('orderNumber');
  if (value.currency !== orderContext?.currency) errors.push('currency');
  if (!buyerId) errors.push('buyer');
  if (!sellerId) errors.push('seller');
  if (sellerName === null) errors.push('sellerName');
  if (value.store !== null && !storeId) errors.push('store');
  if (storeName === null) errors.push('storeName');
  if (!returnNumber) errors.push('returnNumber');
  if (!reasonCategory) errors.push('reasonCategory');
  if (!reasonDetails) errors.push('reasonDetails');
  if (!requestedAt || !eligibilityDeadline || !createdAt || !updatedAt) errors.push('dates');
  if (requestedAt && eligibilityDeadline && requestedAt > eligibilityDeadline) {
    errors.push('eligibilityDeadline');
  }
  if (createdAt && updatedAt && createdAt > updatedAt) errors.push('updatedAt');

  const items = (Array.isArray(value.items) ? value.items : []).map((item, index) => {
    const prefix = `items.${index}`;
    const orderItemId = canonicalObjectId(item?.orderItemId);
    const productId = canonicalObjectId(item?.productId);
    const expected = orderContext?.itemById?.get(orderItemId);
    const name = canonicalText(item?.name, { min: 1, max: 300 });
    const image = canonicalText(item?.image, { max: 5000 });
    if (!orderItemId || !expected) errors.push(`${prefix}.orderItemId`);
    if (!productId || productId !== expected?.productId) errors.push(`${prefix}.productId`);
    if (!name || name !== expected?.name) errors.push(`${prefix}.name`);
    if (image === null) errors.push(`${prefix}.image`);
    if (item?.purchasedQuantity !== expected?.quantity) errors.push(`${prefix}.purchasedQuantity`);
    if (expected?.sellerId && expected.sellerId !== sellerId) errors.push(`${prefix}.seller`);
    if (
      !expected
      || item?.unitPrice !== expected.lineSubtotal / expected.quantity
    ) errors.push(`${prefix}.unitPrice`);
    if (
      !isExactNonNegativeJsonMoney(item?.lineSubtotal)
      || !expected
      || minorUnits(item.lineSubtotal) > minorUnits(expected.lineSubtotal)
    ) errors.push(`${prefix}.lineSubtotal`);
    return {
      orderItemId,
      productId,
      name,
      image,
      quantity: financial.items[index]?.quantity ?? null,
      purchasedQuantity: item?.purchasedQuantity,
      unitPrice: item?.unitPrice,
      lineSubtotal: financial.items[index]?.lineSubtotal ?? null,
    };
  });

  const rawHistory = Array.isArray(value.statusHistory) ? value.statusHistory : [];
  if (!rawHistory.length || rawHistory.length > 1000) errors.push('statusHistory');
  let previousChangedAt = null;
  const statusHistory = rawHistory.map((entry, index) => {
    const changedAt = canonicalDate(entry?.changedAt);
    const changedBy = entry?.changedBy === null ? null : referencedObjectId(entry?.changedBy);
    const note = canonicalText(entry?.note, { max: 1000 });
    if (!RETURN_STATUSES.has(entry?.status)) errors.push(`statusHistory.${index}.status`);
    if (!RETURN_ACTOR_ROLES.has(entry?.actorRole)) errors.push(`statusHistory.${index}.actorRole`);
    if (entry?.changedBy !== null && !changedBy) errors.push(`statusHistory.${index}.changedBy`);
    if (note === null) errors.push(`statusHistory.${index}.note`);
    if (!changedAt || (previousChangedAt && changedAt < previousChangedAt)) {
      errors.push(`statusHistory.${index}.changedAt`);
    }
    if (changedAt) previousChangedAt = changedAt;
    return { status: entry?.status, note, changedBy, actorRole: entry?.actorRole, changedAt };
  });
  if (statusHistory[0]?.status !== 'requested') errors.push('statusHistory.firstStatus');
  if (statusHistory[statusHistory.length - 1]?.status !== value.status) {
    errors.push('statusHistory.currentStatus');
  }
  if (previousChangedAt && updatedAt && previousChangedAt > updatedAt) {
    errors.push('statusHistory.updatedAt');
  }

  const valid = errors.length === 0;
  return {
    valid,
    errors,
    request: valid ? {
      _id: id,
      returnNumber,
      order: orderId,
      orderId: orderContext.orderNumber,
      buyer: buyerId,
      seller: { _id: sellerId, username: sellerName },
      store: storeId,
      storeName,
      currency: orderContext.currency,
      items,
      reasonCategory,
      reasonDetails,
      status: value.status,
      statusHistory,
      requestedAt,
      eligibilityDeadline,
      createdAt,
      updatedAt,
      policySnapshot: {
        returnsEnabled: value.policySnapshot.returnsEnabled,
        returnDuration: value.policySnapshot.returnDuration,
        refundType: value.policySnapshot.refundType,
      },
      refund: financial.refund,
    } : null,
  };
};

const MAX_COMPLETE_BUYER_RETURN_PAGES = 100;
const BUYER_RETURN_PAGE_LIMIT = 100;

const inspectBuyerReturnPage = (payload, expectedPage, expected = null) => {
  if (!plainObject(payload) || payload.success !== true || !Array.isArray(payload.returns)) return null;
  const page = payload.pagination;
  if (!plainObject(page)) return null;
  const validScalars = Number.isSafeInteger(page.page) && page.page === expectedPage
    && Number.isSafeInteger(page.limit) && page.limit === BUYER_RETURN_PAGE_LIMIT
    && Number.isSafeInteger(page.totalReturns) && page.totalReturns >= 0
    && Number.isSafeInteger(page.totalPages) && page.totalPages >= 1
    && page.totalPages <= MAX_COMPLETE_BUYER_RETURN_PAGES
    && typeof page.hasMore === 'boolean';
  if (!validScalars) return null;
  if (
    page.totalPages !== Math.max(1, Math.ceil(page.totalReturns / page.limit))
    || page.hasMore !== (page.page < page.totalPages)
    || page.page > page.totalPages
  ) return null;
  const expectedCount = page.page < page.totalPages
    ? page.limit
    : page.totalReturns - ((page.page - 1) * page.limit);
  if (payload.returns.length !== expectedCount) return null;
  if (expected && (
    page.limit !== expected.limit
    || page.totalReturns !== expected.totalReturns
    || page.totalPages !== expected.totalPages
  )) return null;
  return page;
};

export const fetchCompleteBuyerReturns = async (fetchPage) => {
  if (typeof fetchPage !== 'function') throw new Error('Return page loader is unavailable.');
  const first = await fetchPage(1, BUYER_RETURN_PAGE_LIMIT);
  const firstPage = inspectBuyerReturnPage(first, 1);
  if (!firstPage) throw new Error('Return pagination response is invalid.');
  const payloads = [first];
  for (let page = 2; page <= firstPage.totalPages; page += 5) {
    const lastPage = Math.min(firstPage.totalPages, page + 4);
    payloads.push(...await Promise.all(
      Array.from({ length: lastPage - page + 1 }, (_, index) => (
        fetchPage(page + index, BUYER_RETURN_PAGE_LIMIT)
      )),
    ));
  }
  const returns = payloads.flatMap((payload, index) => {
    if (!inspectBuyerReturnPage(payload, index + 1, firstPage)) {
      throw new Error('Return pagination response changed while it was loading.');
    }
    return payload.returns;
  });
  if (returns.length !== firstPage.totalReturns) {
    throw new Error('Return history response is incomplete.');
  }
  return { success: true, complete: true, totalReturns: firstPage.totalReturns, returns };
};

export const inspectBuyerReturnsResponse = (payload, orderContext, eligibilityInspection = null) => {
  const errors = [];
  const value = plainObject(payload) ? payload : {};
  if (value.success !== true) errors.push('success');
  const rawRequests = Array.isArray(value.returns) ? value.returns : null;
  if (
    !rawRequests
    || value.complete !== true
    || !Number.isSafeInteger(value.totalReturns)
    || value.totalReturns !== rawRequests.length
    || value.totalReturns > MAX_COMPLETE_BUYER_RETURN_PAGES * BUYER_RETURN_PAGE_LIMIT
  ) errors.push('returns');
  const inspections = (rawRequests || []).map((request, index) => {
    const inspection = inspectBuyerReturnRequest(request, orderContext);
    if (!inspection.valid) {
      errors.push(...inspection.errors.map(error => `returns.${index}.${error}`));
    }
    return inspection;
  });
  const requests = inspections.map(inspection => inspection.request).filter(Boolean);
  const seenIds = new Set();
  const seenNumbers = new Set();
  const consumed = new Map();
  let consumedRefundMinor = 0n;
  requests.forEach((request, index) => {
    if (seenIds.has(request._id)) errors.push(`returns.${index}.duplicateId`);
    if (seenNumbers.has(request.returnNumber)) errors.push(`returns.${index}.duplicateNumber`);
    seenIds.add(request._id);
    seenNumbers.add(request.returnNumber);
    if (index > 0 && request.createdAt > requests[index - 1].createdAt) {
      errors.push(`returns.${index}.sortOrder`);
    }
    if (NON_CONSUMING_RETURN_STATUSES.has(request.status)) return;
    request.items.forEach((item) => {
      const prior = consumed.get(item.orderItemId) || { quantity: 0, lineMinor: 0n };
      const quantity = prior.quantity + item.quantity;
      const lineMinor = prior.lineMinor + minorUnits(item.lineSubtotal);
      const expected = orderContext?.itemById?.get(item.orderItemId);
      if (
        !Number.isSafeInteger(quantity)
        || !expected
        || quantity > expected.quantity
        || lineMinor > minorUnits(expected.lineSubtotal)
      ) errors.push(`returns.${index}.aggregateItemConservation`);
      consumed.set(item.orderItemId, { quantity, lineMinor });
    });
    if (request.policySnapshot.refundType !== 'replacement_only') {
      consumedRefundMinor += minorUnits(request.refund.totalAmount);
    }
  });
  if (
    orderContext?.valid
    && consumedRefundMinor > minorUnits(orderContext.totalAmount)
  ) errors.push('refundConservation');
  if (!eligibilityInspection?.valid) {
    errors.push('eligibility');
  } else {
    const groupBySeller = new Map(
      eligibilityInspection.groups.map(group => [group.seller._id, group]),
    );
    requests.forEach((request, requestIndex) => {
      const group = groupBySeller.get(request.seller._id);
      const groupItems = new Set((group?.items || []).map(item => item.orderItemId));
      if (!group || request.items.some(item => !groupItems.has(item.orderItemId))) {
        errors.push(`returns.${requestIndex}.eligibilityIdentity`);
      }
    });
    eligibilityInspection.groups.forEach((group, groupIndex) => {
      group.items.forEach((item, itemIndex) => {
        const consumedQuantity = consumed.has(item.orderItemId)
          ? consumed.get(item.orderItemId).quantity
          : 0;
        if (item.alreadyRequestedQuantity !== consumedQuantity) {
          errors.push(`eligibility.groups.${groupIndex}.items.${itemIndex}.consumedQuantity`);
        }
      });
    });
  }
  const valid = errors.length === 0;
  return { valid, errors, requests: valid ? requests : [] };
};

export const inspectBuyerReturnMutationResponse = (
  payload,
  orderContext,
  {
    mode,
    expectedRequestId = null,
    expectedSellerId = null,
    expectedItems = null,
    expectedReasonCategory = null,
    expectedReasonDetails = null,
    expectedStatus = null,
  } = {},
) => {
  const errors = [];
  const value = plainObject(payload) ? payload : {};
  if (value.success !== true) errors.push('success');
  if (mode === 'create' && typeof value.replayed !== 'boolean') errors.push('replayed');
  if (!['create', 'cancel'].includes(mode)) errors.push('mode');
  const inspection = inspectBuyerReturnRequest(value.returnRequest, orderContext);
  if (!inspection.valid) errors.push(...inspection.errors.map(error => `returnRequest.${error}`));
  const request = inspection.request;
  if (expectedRequestId && request?._id !== expectedRequestId) errors.push('requestId');
  if (expectedSellerId && request?.seller?._id !== expectedSellerId) errors.push('sellerId');
  if (expectedStatus && request?.status !== expectedStatus) errors.push('status');
  if (expectedReasonCategory && request?.reasonCategory !== expectedReasonCategory) {
    errors.push('reasonCategory');
  }
  if (expectedReasonDetails && request?.reasonDetails !== expectedReasonDetails) {
    errors.push('reasonDetails');
  }
  if (expectedItems) {
    const actual = request?.items
      ?.map(item => `${item.orderItemId}:${item.quantity}`)
      .sort() || [];
    const expected = expectedItems
      .map(item => `${item.orderItemId}:${item.quantity}`)
      .sort();
    if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
      errors.push('items');
    }
  }
  const valid = errors.length === 0;
  return { valid, errors, request: valid ? request : null };
};
