'use strict';

const crypto = require('crypto');
const ReturnRequest = require('../models/ReturnRequest');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Store = require('../models/Store');
const User = require('../models/User');
const SellerBalanceTransaction = require('../models/SellerBalanceTransaction');
const SellerSettlementLock = require('../models/SellerSettlementLock');
const { stripe } = require('../config/stripe');
const { normalizeCurrency, convertToUSD } = require('./currencyService');
const {
  normalizeReturnPolicy,
  returnEligibilityDeadline,
  canTransitionReturnStatus,
} = require('./returnPolicyService');
const {
  runInTransaction,
  creditWalletInSession,
  toStripeMinorUnits,
  roundMoney,
} = require('./walletService');
const { buildOrderItemDiscountAllocations } = require('./orderDiscountService');

const CLOSED_WITHOUT_CONSUMING_QUANTITY = ['rejected', 'cancelled_by_buyer'];
const BUYER_CANCELLABLE_STATUSES = ['requested', 'approved', 'pickup_scheduled'];
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
const queryWithSession = (query, session) => (session ? query.session(session) : query);
const cleanNote = (value, max = 1000) => String(value || '').trim().slice(0, max);

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
  const refundedAmountBySeller = new Map();

  for (const request of requests) {
    const sellerId = toId(request.seller);
    if (Number(request.refund?.shippingAmount) > 0) shippingRefundedBySeller.add(sellerId);
    if (request.policySnapshot?.refundType !== 'replacement_only') {
      refundedAmountBySeller.set(
        sellerId,
        roundMoney((refundedAmountBySeller.get(sellerId) || 0) + (Number(request.refund?.totalAmount) || 0))
      );
    }
    for (const item of request.items || []) {
      const key = toId(item.orderItemId);
      consumed.set(key, (consumed.get(key) || 0) + (Number(item.quantity) || 0));
      if (request.status === 'returned') {
        settledQuantities.set(key, (settledQuantities.get(key) || 0) + (Number(item.quantity) || 0));
      }
    }
  }
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
    const purchasedQuantity = Math.max(0, Number(item.quantity) || 0);
    const consumedQuantity = consumed.get(toId(item._id)) || 0;
    groupedItems.get(sellerId).push({
      orderItemId: item._id,
      productId: item.productId,
      name: item.name || 'Product',
      image: item.image || '',
      purchasedQuantity,
      alreadyRequestedQuantity: consumedQuantity,
      remainingReturnableQuantity: Math.max(0, purchasedQuantity - consumedQuantity),
      unitPrice: Number(item.price) || 0,
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
  consumed,
  settledQuantities = consumed,
  shippingAlreadyRefunded,
  sellerRefundedAmount,
}) => {
  const orderSubtotal = Number(order.orderSummary?.subtotal) || (order.orderItems || []).reduce(
    (sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 0),
    0
  );
  const selectedSubtotal = selected.reduce(
    (sum, item) => sum + item.unitPrice * item.quantity,
    0
  );
  const share = orderSubtotal > 0 ? selectedSubtotal / orderSubtotal : 0;
  let taxAmount = roundMoney((Number(order.orderSummary?.tax) || 0) * share);
  const discountAllocations = buildOrderItemDiscountAllocations(order);
  let discountAmount = roundMoney(selected.reduce((sum, item) => {
    const fullItemDiscount = discountAllocations.get(toId(item.orderItemId)) || 0;
    const purchasedQuantity = Math.max(1, Number(item.purchasedQuantity) || 1);
    return sum + fullItemDiscount * item.quantity / purchasedQuantity;
  }, 0));

  const selectedByItem = new Map(selected.map(item => [toId(item.orderItemId), item.quantity]));
  const allSellerQuantityCovered = sellerItems.every(item => {
    const before = settledQuantities.get(toId(item.orderItemId)) || 0;
    const now = selectedByItem.get(toId(item.orderItemId)) || 0;
    return before + now >= item.purchasedQuantity;
  });
  const sellerShipping = Number((order.sellerShipping || []).find(
    item => toId(item.seller) === toId(sellerId)
  )?.shippingMethod?.price) || (
    toId(order.shippingMethod?.seller) === toId(sellerId)
      ? Number(order.shippingMethod?.price) || 0
      : 0
  );
  const shippingAmount = allSellerQuantityCovered && !shippingAlreadyRefunded
    ? roundMoney(sellerShipping)
    : 0;
  const sellerSubtotal = sellerItems.reduce(
    (sum, item) => sum + item.unitPrice * item.purchasedQuantity,
    0
  );
  const sellerShare = orderSubtotal > 0 ? sellerSubtotal / orderSubtotal : 0;
  const sellerTax = roundMoney((Number(order.orderSummary?.tax) || 0) * sellerShare);
  const sellerDiscount = roundMoney(sellerItems.reduce(
    (sum, item) => sum + (discountAllocations.get(toId(item.orderItemId)) || 0),
    0
  ));
  const sellerMaximumRefund = roundMoney(Math.max(0, sellerSubtotal + sellerTax + sellerShipping - sellerDiscount));
  const hasRefundLedger = sellerRefundedAmount !== undefined && sellerRefundedAmount !== null;
  const remainingSellerRefund = hasRefundLedger
    ? roundMoney(Math.max(0, sellerMaximumRefund - (Number(sellerRefundedAmount) || 0)))
    : null;

  const calculatedTotal = roundMoney(Math.max(0, selectedSubtotal + taxAmount + shippingAmount - discountAmount));
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

const createReturnRequest = async ({
  orderId,
  buyerId,
  sellerId,
  items,
  reasonCategory,
  reasonDetails,
  requestKey,
}) => runInTransaction(async (session) => {
  const cleanRequestKey = requestKey
    ? `return:${toId(buyerId)}:${String(requestKey).trim().slice(0, 120)}`
    : undefined;
  if (cleanRequestKey) {
    const existing = await ReturnRequest.findOne({ requestKey: cleanRequestKey, buyer: buyerId }).session(session);
    if (existing) return existing;
  }

  if (!REASON_CATEGORIES.includes(reasonCategory)) {
    const error = new Error('Choose a valid return reason.');
    error.statusCode = 400;
    error.code = 'INVALID_RETURN_REASON';
    throw error;
  }
  const cleanReason = cleanNote(reasonDetails, 1500);
  if (cleanReason.length < 10) {
    const error = new Error('Please explain the return reason in at least 10 characters.');
    error.statusCode = 400;
    error.code = 'RETURN_REASON_TOO_SHORT';
    throw error;
  }
  if (!Array.isArray(items) || items.length === 0) {
    const error = new Error('Select at least one item to return.');
    error.statusCode = 400;
    throw error;
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

  // Serializes concurrent return requests for the same order.
  await Order.updateOne({ _id: order._id }, { $inc: { returnVersion: 1 } }, { session });

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

  const requestedByItem = new Map();
  for (const requested of items) {
    const key = toId(requested.orderItemId);
    const quantity = Math.trunc(Number(requested.quantity) || 0);
    if (!key || quantity < 1 || requestedByItem.has(key)) {
      const error = new Error('Return items must contain unique order item IDs and positive quantities.');
      error.statusCode = 400;
      throw error;
    }
    requestedByItem.set(key, quantity);
  }

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
    selected.push({ ...item, quantity, lineSubtotal: roundMoney(item.unitPrice * quantity) });
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
    order: order._id,
    orderId: order.orderId,
    buyer: buyerId,
    seller: sellerId,
    store: group.store?._id || null,
    storeName: group.store?.storeName || '',
    currency: normalizeCurrency(order.currency || 'USD'),
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

  return returnRequest;
});

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
  const request = await ReturnRequest.findById(returnRequestId);
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
  await request.save();
  return request;
};

const cancelReturnRequest = async ({ returnRequestId, buyerId, note }) => {
  const request = await ReturnRequest.findOne({ _id: returnRequestId, buyer: buyerId });
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
  await request.save();
  return request;
};

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

  const { buildSellerPaymentSummary } = require('../controllers/PaymentController');
  const summary = await buildSellerPaymentSummary(sellerId);
  const amountUSD = roundMoney(await convertToUSD(request.refund.totalAmount, request.currency));
  if (amountUSD <= 0 || amountUSD > Number(summary.revenue.withdrawableBalance || 0)) {
    const error = new Error('Your available seller balance is not enough for this refund. Pay by card instead.');
    error.statusCode = 400;
    error.code = 'INSUFFICIENT_SELLER_BALANCE';
    error.availableBalanceUSD = Number(summary.revenue.withdrawableBalance || 0);
    throw error;
  }

  const [sellerDebit] = await SellerBalanceTransaction.create([{
    seller: sellerId,
    type: 'return_refund',
    direction: 'debit',
    status: 'completed',
    amountUSD,
    sourceAmount: request.refund.totalAmount,
    sourceCurrency: request.currency,
    referenceType: 'return_request',
    referenceId: String(request._id),
    description: `Wallet refund for return ${request.returnNumber}`,
    completedAt: new Date(),
  }], { session });

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

  request.status = 'returned';
  request.settlement.fundingSource = 'seller_balance';
  request.settlement.status = 'completed';
  request.settlement.sellerBalanceTransaction = sellerDebit._id;
  request.settlement.walletTransaction = walletTransaction._id;
  request.settlement.settledAt = new Date();
  request.statusHistory.push({
    status: 'returned',
    note: 'Seller balance funded the buyer wallet refund.',
    changedBy: sellerId,
    actorRole: 'seller',
  });
  await request.save({ session });
  return request;
});

const approveReplacement = async ({ returnRequestId, sellerId }) => {
  const request = await ReturnRequest.findOne({ _id: returnRequestId, seller: sellerId });
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
  request.settlement.settledAt = new Date();
  request.statusHistory.push({
    status: 'replacement_approved',
    note: 'Seller approved the replacement resolution.',
    changedBy: sellerId,
    actorRole: 'seller',
  });
  await request.save();
  return request;
};

const createReturnSettlementCheckout = async ({ returnRequestId, sellerId, platform = 'web' }) => {
  if (!stripe) {
    const error = new Error('Card payments are not configured.');
    error.statusCode = 503;
    throw error;
  }

  let request = await ReturnRequest.findOne({ _id: returnRequestId, seller: sellerId });
  if (!request) {
    const error = new Error('Return request not found.');
    error.statusCode = 404;
    throw error;
  }
  if (request.status === 'accepted_pending_payment' && request.settlement?.stripeSessionId) {
    const existingSession = await stripe.checkout.sessions.retrieve(request.settlement.stripeSessionId);
    if (existingSession?.status === 'open' && existingSession.url) {
      return { returnRequest: request, session: existingSession };
    }
    if (existingSession?.payment_status === 'paid' || existingSession?.status === 'complete') {
      const error = new Error('The seller payment completed and the refund is being verified. Refresh shortly.');
      error.statusCode = 409;
      error.code = 'RETURN_SETTLEMENT_PROCESSING';
      throw error;
    }
    await failReturnCardSettlement(
      existingSession,
      'The previous seller card checkout expired or was not completed.'
    );
    request = await ReturnRequest.findOne({ _id: returnRequestId, seller: sellerId });
  }
  if (request.status !== 'under_review') {
    const error = new Error('The return must be under review before it can be accepted.');
    error.statusCode = 409;
    throw error;
  }

  request = await ReturnRequest.findOneAndUpdate(
    { _id: request._id, seller: sellerId, status: 'under_review' },
    {
      $set: {
        status: 'accepted_pending_payment',
        'settlement.fundingSource': 'card',
        'settlement.status': 'pending_payment',
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
    { new: true }
  );
  if (!request) {
    const error = new Error('This return was updated by another request. Refresh and try again.');
    error.statusCode = 409;
    throw error;
  }

  try {
    const seller = await User.findById(sellerId).select('email').lean();
    const frontendUrl = process.env.FRONTEND_URL || 'https://rozare.com';
    const isMobile = platform === 'mobile';
    const settlementAttempt = Math.max(1, Number(request.settlement?.attempt) || 1);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: seller?.email || undefined,
      client_reference_id: String(request._id),
      line_items: [{
        price_data: {
          currency: request.currency.toLowerCase(),
          product_data: {
            name: `Return refund ${request.returnNumber}`,
            description: `Funds the buyer Rozare Wallet refund for order ${request.orderId}`,
          },
          unit_amount: toStripeMinorUnits(request.refund.totalAmount, request.currency),
        },
        quantity: 1,
      }],
      success_url: isMobile
        ? `rozare://seller-returns?tab=returns&return_payment=success&returnId=${request._id}`
        : `${frontendUrl}/seller-dashboard/order-management?tab=returns&return_payment=success&returnId=${request._id}`,
      cancel_url: isMobile
        ? `rozare://seller-returns?tab=returns&return_payment=cancelled&returnId=${request._id}`
        : `${frontendUrl}/seller-dashboard/order-management?tab=returns&return_payment=cancelled&returnId=${request._id}`,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      metadata: {
        type: 'return_settlement',
        returnRequestId: String(request._id),
        returnNumber: request.returnNumber,
        sellerId: String(sellerId),
        buyerId: String(request.buyer),
      },
    }, {
      idempotencyKey: `return-settlement:${request._id}:attempt:${settlementAttempt}`,
    });

    request.settlement.stripeSessionId = session.id;
    await request.save();
    return { returnRequest: request, session };
  } catch (error) {
    await ReturnRequest.updateOne(
      {
        _id: request._id,
        status: 'accepted_pending_payment',
        'settlement.attempt': request.settlement?.attempt,
        'settlement.stripeSessionId': null,
      },
      {
        $set: {
          status: 'under_review',
          'settlement.status': 'failed',
          'settlement.failureReason': cleanNote(error.message, 500),
        },
        $push: {
          statusHistory: {
            status: 'under_review',
            note: 'Card payment could not be started. Seller can try again.',
            changedBy: sellerId,
            actorRole: 'seller',
            changedAt: new Date(),
          },
        },
      }
    );
    throw error;
  }
};

const completeReturnCardSettlement = async (stripeSession) => {
  const returnRequestId = stripeSession?.metadata?.returnRequestId;
  if (!returnRequestId) return null;
  if (stripeSession.payment_status !== 'paid') {
    const error = new Error('Stripe has not marked this return settlement as paid.');
    error.code = 'RETURN_SETTLEMENT_NOT_PAID';
    throw error;
  }

  return runInTransaction(async (session) => {
    const request = await ReturnRequest.findById(returnRequestId).session(session);
    if (!request) {
      const error = new Error(`Return request ${returnRequestId} was not found.`);
      error.code = 'RETURN_REQUEST_NOT_FOUND';
      throw error;
    }
    if (request.status === 'returned' && request.settlement?.status === 'completed') return request;
    if (
      request.status !== 'accepted_pending_payment' ||
      request.settlement?.status !== 'pending_payment' ||
      request.settlement?.stripeSessionId !== stripeSession.id
    ) {
      const error = new Error('Return settlement state did not match the Stripe session.');
      error.code = 'RETURN_SETTLEMENT_STATE_MISMATCH';
      throw error;
    }

    const expectedMinor = toStripeMinorUnits(request.refund.totalAmount, request.currency);
    if (
      Number(stripeSession.amount_total) !== expectedMinor ||
      String(stripeSession.currency || '').toUpperCase() !== request.currency
    ) {
      const error = new Error('Stripe return settlement amount or currency did not match.');
      error.code = 'RETURN_SETTLEMENT_AMOUNT_MISMATCH';
      throw error;
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

    request.status = 'returned';
    request.settlement.status = 'completed';
    request.settlement.stripePaymentIntentId = stripeSession.payment_intent || null;
    request.settlement.walletTransaction = walletTransaction._id;
    request.settlement.settledAt = new Date();
    request.statusHistory.push({
      status: 'returned',
      note: 'Seller card payment completed and the buyer wallet was credited.',
      changedBy: null,
      actorRole: 'system',
    });
    await request.save({ session });
    return request;
  });
};

const failReturnCardSettlement = async (stripeSession, reason = 'Card payment expired or failed.') => {
  const returnRequestId = stripeSession?.metadata?.returnRequestId;
  if (!returnRequestId) return null;
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
};
