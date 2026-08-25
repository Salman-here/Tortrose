const Order = require('../models/Order');
const { stripe } = require('../config/stripe');
const { commitOrderInventory } = require('./orderInventoryService');
const { multiplyMoney, roundMoney, toMinorUnits } = require('./moneyMath');
const { isSupportedCurrency, normalizeCurrency } = require('./currencyService');
const { consumeOrderCoupons } = require('./couponUsageService');
const { parseStrictFiniteNumber } = require('./numericInputService');
const {
  claimStripePaymentCompletion,
  markStripePaymentCompletionDone,
} = require('./stripePaymentRiskMarkerService');
const { STRIPE_MAX_CHARGE_AMOUNT_MINOR } = require('./stripePaymentIntentFactory');

const STRIPE_ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

const toStripeMinorUnits = (amount, currency) => {
  const value = parseStrictFiniteNumber(amount);
  if (value === null || value < 0) {
    const error = new RangeError('Stripe money must be a finite non-negative decimal amount.');
    error.code = 'STRIPE_MONEY_INVALID';
    throw error;
  }
  return toMinorUnits(
    value,
    STRIPE_ZERO_DECIMAL_CURRENCIES.has(String(currency || '').toUpperCase()) ? 0 : 2,
  );
};

const requireStoredMoneyMinor = (value, currency, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw paymentError(
      `The stored ${label} is not a valid money amount.`,
      'ORDER_MONEY_INVALID',
      409,
    );
  }
  let minor;
  try {
    minor = toStripeMinorUnits(value, currency);
  } catch (_) {
    throw paymentError(
      `The stored ${label} is outside the supported money range.`,
      'ORDER_MONEY_INVALID',
      409,
    );
  }
  if (roundMoney(value) !== value) {
    throw paymentError(
      `The stored ${label} is not an exact cent amount.`,
      'ORDER_MONEY_INVALID',
      409,
    );
  }
  return minor;
};

const requireOrderLineMinor = (item, currency, index) => {
  const quantity = item?.quantity;
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1) {
    throw paymentError(
      `Stored order line ${index + 1} has an invalid quantity.`,
      'ORDER_MONEY_INVALID',
      409,
    );
  }
  if (item?.lineSubtotal !== null && item?.lineSubtotal !== undefined && item?.lineSubtotal !== '') {
    return requireStoredMoneyMinor(item.lineSubtotal, currency, `order line ${index + 1} subtotal`);
  }
  requireStoredMoneyMinor(item?.price, currency, `legacy order line ${index + 1} unit price`);
  let legacySubtotal;
  try {
    legacySubtotal = multiplyMoney(item.price, quantity);
  } catch (_) {
    throw paymentError(
      `Stored legacy order line ${index + 1} is outside the supported money range.`,
      'ORDER_MONEY_INVALID',
      409,
    );
  }
  return requireStoredMoneyMinor(legacySubtotal, currency, `legacy order line ${index + 1} subtotal`);
};

const storedId = value => value?._id?.toString?.() || value?.toString?.() || '';

// Coupon version 1 is written only after the exact applied amounts and scopes
// have been atomically reserved. Those snapshots determine which seller/order
// lines fund the discount, so a valid grand total is not enough: corrupted
// coupon allocations could charge the buyer correctly while debiting the
// wrong seller. Legacy version-0 orders retain their historical fallback.
const requireReservedCouponReconciliation = (order, currency, discountMinor) => {
  const usageVersion = order?.couponUsageVersion;
  if (usageVersion === null || usageVersion === undefined || usageVersion === 0) return;
  if (typeof usageVersion !== 'number' || usageVersion !== 1) {
    throw paymentError('The stored coupon allocation version is invalid.', 'ORDER_COUPON_ALLOCATION_INVALID', 409);
  }

  const coupons = order?.appliedCoupons;
  if (!Array.isArray(coupons)) {
    throw paymentError('The stored coupon allocation is invalid.', 'ORDER_COUPON_ALLOCATION_INVALID', 409);
  }

  const orderProductIds = new Set((order?.orderItems || []).map(item => storedId(item?.productId)).filter(Boolean));
  const sellersByProduct = new Map();
  (order?.orderItems || []).forEach(item => {
    const productId = storedId(item?.productId);
    if (!productId) return;
    if (!sellersByProduct.has(productId)) sellersByProduct.set(productId, new Set());
    const sellerId = storedId(item?.seller);
    if (sellerId) sellersByProduct.get(productId).add(sellerId);
  });
  const seenCouponIds = new Set();
  const claimedProductIds = new Set();
  let appliedMinor = 0;

  coupons.forEach((coupon, index) => {
    const couponId = storedId(coupon?.couponId);
    const couponSeller = storedId(coupon?.seller);
    const appliedCurrency = coupon?.currency;
    const applicableProductIds = Array.isArray(coupon?.applicableProductIds)
      ? coupon.applicableProductIds.map(storedId).filter(Boolean)
      : [];
    if (
      !couponId
      || !couponSeller
      || seenCouponIds.has(couponId)
      || !['percentage', 'fixed'].includes(coupon?.discountType)
      || typeof appliedCurrency !== 'string'
      || appliedCurrency !== appliedCurrency.trim()
      || appliedCurrency !== appliedCurrency.toUpperCase()
      || !isSupportedCurrency(appliedCurrency)
      || appliedCurrency !== currency
      || applicableProductIds.length === 0
      || new Set(applicableProductIds).size !== applicableProductIds.length
      || applicableProductIds.some(productId => {
        const productSellers = sellersByProduct.get(productId);
        return !orderProductIds.has(productId)
          || claimedProductIds.has(productId)
          || !productSellers
          || productSellers.size !== 1
          || !productSellers.has(couponSeller);
      })
    ) {
      throw paymentError('The stored coupon allocation is invalid.', 'ORDER_COUPON_ALLOCATION_INVALID', 409);
    }
    const couponMinor = requireStoredMoneyMinor(
      coupon?.appliedDiscountAmount,
      currency,
      `coupon ${index + 1} applied discount`,
    );
    if (couponMinor <= 0) {
      throw paymentError('The stored coupon allocation is invalid.', 'ORDER_COUPON_ALLOCATION_INVALID', 409);
    }
    appliedMinor += couponMinor;
    if (!Number.isSafeInteger(appliedMinor)) {
      throw paymentError('The stored coupon allocation is outside the supported money range.', 'ORDER_MONEY_INVALID', 409);
    }
    seenCouponIds.add(couponId);
    applicableProductIds.forEach(productId => claimedProductIds.add(productId));
  });

  if (appliedMinor !== discountMinor || (discountMinor > 0 && coupons.length === 0)) {
    throw paymentError('The stored coupon allocation does not reconcile with the order discount.', 'ORDER_TOTAL_MISMATCH', 409);
  }
};

const getExpectedStripeTotalMinor = (order) => {
  const currency = order?.currency ?? 'USD';
  if (
    !isSupportedCurrency(currency)
    || typeof currency !== 'string'
    || currency !== currency.trim()
    || currency !== normalizeCurrency(currency)
  ) {
    throw paymentError(
      'The stored order currency is not supported for payment reconciliation.',
      'ORDER_CURRENCY_INVALID',
      409,
    );
  }
  const orderItems = order?.orderItems;
  if (!Array.isArray(orderItems) || orderItems.length === 0) {
    throw paymentError('A payable order must contain at least one stored item.', 'ORDER_MONEY_INVALID', 409);
  }
  const itemTotal = orderItems.reduce((sum, item, index) => {
    const next = sum + requireOrderLineMinor(item, currency, index);
    if (!Number.isSafeInteger(next)) {
      throw paymentError('The stored order subtotal is outside the supported money range.', 'ORDER_MONEY_INVALID', 409);
    }
    return next;
  }, 0);
  const shipping = requireStoredMoneyMinor(order?.orderSummary?.shippingCost, currency, 'shipping total');
  const tax = requireStoredMoneyMinor(order?.orderSummary?.tax, currency, 'tax total');
  const discount = requireStoredMoneyMinor(order?.orderSummary?.couponDiscount, currency, 'coupon discount');
  const grossTotal = itemTotal + shipping + tax;
  if (!Number.isSafeInteger(grossTotal) || discount > itemTotal) {
    throw paymentError('The stored order discount exceeds the product subtotal.', 'ORDER_TOTAL_MISMATCH', 409);
  }
  const calculatedTotal = grossTotal - discount;
  const storedSubtotal = requireStoredMoneyMinor(order?.orderSummary?.subtotal, currency, 'order subtotal');
  const storedTotal = requireStoredMoneyMinor(order?.orderSummary?.totalAmount, currency, 'order total');
  if (storedSubtotal !== itemTotal || storedTotal !== calculatedTotal) {
    const error = new Error('The stored order total does not reconcile with its monetary components.');
    error.code = 'ORDER_TOTAL_MISMATCH';
    error.statusCode = 409;
    throw error;
  }
  requireReservedCouponReconciliation(order, currency, discount);
  return calculatedTotal;
};

const getStripeOrderChargeAmountMinor = (order, { allowZero = false } = {}) => {
  const amountMinor = getExpectedStripeTotalMinor(order);
  if (amountMinor === 0 && allowZero) return 0;
  if (amountMinor <= 0) {
    throw paymentError(
      'A zero-total order must use the no-charge completion path.',
      'PAYMENT_SETUP_INVALID',
      400,
    );
  }
  if (amountMinor > STRIPE_MAX_CHARGE_AMOUNT_MINOR) {
    throw paymentError(
      'This card order total exceeds Stripe\'s maximum supported amount. Reduce the order total and try again.',
      'PAYMENT_AMOUNT_TOO_LARGE',
      400,
    );
  }
  return amountMinor;
};

const paymentError = (message, code, statusCode = 400) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const stripeIntegerMatches = (value, expected) => (
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && value >= 0
  && value === expected
);

const stripeMetadataMinorMatches = (value, expected) => (
  typeof value === 'string'
  && value === String(expected)
);

const validateStripeOrderSession = (order, stripeSession, { requirePaid = false } = {}) => {
  if (!order || order.paymentMethod !== 'stripe' || order.paymentFlow !== 'checkout_session') {
    throw paymentError('This order is not a card-payment order.', 'NOT_STRIPE_ORDER');
  }
  if (!stripeSession?.id || stripeSession.id !== order.stripeSessionId) {
    throw paymentError('The payment session does not belong to this order.', 'PAYMENT_SESSION_MISMATCH');
  }
  if (stripeSession.mode !== 'payment') {
    throw paymentError('The payment session has an invalid mode.', 'PAYMENT_SESSION_MODE_MISMATCH');
  }
  if (
    typeof stripeSession.metadata?.orderId !== 'string'
    || stripeSession.metadata.orderId !== String(order.orderId || '')
  ) {
    throw paymentError('The payment session order reference is invalid.', 'PAYMENT_ORDER_MISMATCH');
  }
  const expected = getExpectedStripeTotalMinor(order);
  if (stripeSession.currency !== order.currency.toLowerCase()) {
    throw paymentError('The payment session currency is invalid.', 'PAYMENT_CURRENCY_MISMATCH');
  }
  if (!stripeIntegerMatches(stripeSession.amount_total, expected)) {
    throw paymentError('The payment session total is invalid.', 'PAYMENT_AMOUNT_MISMATCH');
  }
  if (order.stripeMode) {
    if (
      stripeSession.metadata?.type !== 'order_payment'
      || stripeSession.metadata?.paymentFlow !== 'checkout_session'
      || stripeSession.metadata?.stripeMode !== order.stripeMode
      || typeof stripeSession.metadata?.mongoOrderId !== 'string'
      || stripeSession.metadata.mongoOrderId !== String(order._id || '')
      || !stripeMetadataMinorMatches(stripeSession.metadata?.amountMinor, expected)
      || typeof stripeSession.metadata?.userId !== 'string'
      || stripeSession.metadata.userId !== String(order.user || '')
      || typeof stripeSession.livemode !== 'boolean'
      || stripeSession.livemode !== (order.stripeMode === 'live')
    ) {
      throw paymentError('The payment session metadata is invalid.', 'PAYMENT_MODE_MISMATCH');
    }
  }
  if (order.stripeCustomerId) {
    const sessionCustomer = typeof stripeSession.customer === 'string'
      ? stripeSession.customer
      : stripeSession.customer?.id;
    if (sessionCustomer !== order.stripeCustomerId) {
      throw paymentError('The payment customer does not belong to this order.', 'PAYMENT_CUSTOMER_MISMATCH');
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(stripeSession.metadata || {}, 'userId')
    && (
      typeof stripeSession.metadata.userId !== 'string'
      || stripeSession.metadata.userId !== String(order.user || '')
    )
  ) {
    throw paymentError('The payment user does not belong to this order.', 'PAYMENT_USER_MISMATCH');
  }
  if (requirePaid && stripeSession.payment_status !== 'paid') {
    throw paymentError('Stripe has not confirmed this payment.', 'PAYMENT_NOT_CONFIRMED', 409);
  }
  if (requirePaid) {
    const paymentIntentId = typeof stripeSession.payment_intent === 'string'
      ? stripeSession.payment_intent
      : stripeSession.payment_intent?.id;
    if (!paymentIntentId) {
      throw paymentError(
        'The paid payment session is missing its PaymentIntent reference.',
        'PAYMENT_INTENT_MISMATCH',
        409,
      );
    }
  }
  return true;
};

/**
 * Attach a Stripe reference recovered from a direct create response or a
 * signature-verified webhook.
 *
 * `creating` is the only state where the deterministic create call may have
 * succeeded while the following Mongo save failed. Validate every immutable
 * order/customer/amount field against a temporary candidate before persisting
 * the external ID. No Stripe network call or Mongo transaction is involved.
 */
const attachStripeOrderReference = async ({ order, stripeObject, paymentFlow }) => {
  if (!order || !stripeObject?.id) {
    throw paymentError('Stripe payment recovery is missing its order or reference.', 'PAYMENT_REFERENCE_MISSING');
  }
  const isNative = paymentFlow === 'payment_sheet';
  const referenceField = isNative ? 'stripePaymentIntentId' : 'stripeSessionId';
  const validate = isNative ? validateStripeOrderPaymentIntent : validateStripeOrderSession;

  if (order[referenceField]) {
    validate(order, stripeObject);
    return order;
  }
  if (order.paymentSetupState !== 'creating' || order.paymentFlow !== paymentFlow) {
    throw paymentError(
      'This Stripe payment reference cannot be attached in the current setup state.',
      'PAYMENT_SETUP_RECOVERY_REQUIRED',
      503,
    );
  }

  const candidate = typeof order.toObject === 'function'
    ? order.toObject({ depopulate: true })
    : { ...order };
  candidate[referenceField] = stripeObject.id;
  validate(candidate, stripeObject);

  const recovered = await Order.findOneAndUpdate(
    {
      _id: order._id,
      isPaid: false,
      awaitingPayment: true,
      paymentSetupState: 'creating',
      paymentFlow,
      $or: [
        { [referenceField]: null },
        { [referenceField]: '' },
        { [referenceField]: { $exists: false } },
      ],
    },
    {
      $set: {
        [referenceField]: stripeObject.id,
        paymentSetupState: 'ready',
        paymentSetupCompletedAt: new Date(),
      },
    },
    { new: true },
  );
  if (recovered) return recovered;

  // Another webhook/replay may have won the attach race. Accept only the
  // exact same validated reference; every other state fails closed.
  const current = await Order.findById(order._id);
  if (!current) throw paymentError('Order not found.', 'ORDER_NOT_FOUND', 404);
  validate(current, stripeObject);
  return current;
};

const validateStripeOrderPaymentIntent = (order, paymentIntent, { requireSucceeded = false } = {}) => {
  if (!order || order.paymentMethod !== 'stripe' || order.paymentFlow !== 'payment_sheet') {
    throw paymentError('This order is not a native card-payment order.', 'NOT_PAYMENT_SHEET_ORDER');
  }
  if (!paymentIntent?.id || paymentIntent.id !== order.stripePaymentIntentId) {
    throw paymentError('The PaymentIntent does not belong to this order.', 'PAYMENT_INTENT_MISMATCH');
  }
  const metadata = paymentIntent.metadata || {};
  if (
    metadata.type !== 'order_payment'
    || metadata.paymentFlow !== 'payment_sheet'
    || typeof metadata.orderId !== 'string'
    || metadata.orderId !== String(order.orderId || '')
    || typeof metadata.mongoOrderId !== 'string'
    || metadata.mongoOrderId !== String(order._id || '')
  ) {
    throw paymentError('The PaymentIntent order reference is invalid.', 'PAYMENT_ORDER_MISMATCH');
  }
  if (typeof metadata.userId !== 'string' || metadata.userId !== String(order.user || '')) {
    throw paymentError('The PaymentIntent user is invalid.', 'PAYMENT_USER_MISMATCH');
  }
  const customerId = typeof paymentIntent.customer === 'string'
    ? paymentIntent.customer
    : paymentIntent.customer?.id;
  if (!order.stripeCustomerId || customerId !== order.stripeCustomerId) {
    throw paymentError('The PaymentIntent customer is invalid.', 'PAYMENT_CUSTOMER_MISMATCH');
  }
  if (
    order.stripeMode
    && (
      metadata.stripeMode !== order.stripeMode
      || typeof paymentIntent.livemode !== 'boolean'
      || paymentIntent.livemode !== (order.stripeMode === 'live')
    )
  ) {
    throw paymentError('The PaymentIntent Stripe mode is invalid.', 'PAYMENT_MODE_MISMATCH');
  }
  const expected = getExpectedStripeTotalMinor(order);
  if (
    !stripeIntegerMatches(paymentIntent.amount, expected)
    || !stripeMetadataMinorMatches(metadata.amountMinor, expected)
  ) {
    throw paymentError('The PaymentIntent total is invalid.', 'PAYMENT_AMOUNT_MISMATCH');
  }
  if (paymentIntent.currency !== order.currency.toLowerCase()) {
    throw paymentError('The PaymentIntent currency is invalid.', 'PAYMENT_CURRENCY_MISMATCH');
  }
  if (requireSucceeded) {
    if (
      paymentIntent.status !== 'succeeded'
      || !stripeIntegerMatches(paymentIntent.amount_received, expected)
    ) {
      throw paymentError('Stripe has not confirmed the complete payment.', 'PAYMENT_NOT_CONFIRMED', 409);
    }
  }
  return true;
};

const isPaymentFulfilled = (order) => Boolean(
  order?.isPaid
  && order?.awaitingPayment === false
  && order?.inventoryCommitted
  && order?.paymentFulfilledAt,
);

const capturedStockRefundIdempotencyKey = order => (
  `rozare-order-stock-refund:${order?.stripeMode || 'unknown'}:${order?._id}`
);

const STOCK_REFUND_STATUSES = new Set([
  'pending',
  'requires_action',
  'succeeded',
  'failed',
  'canceled',
]);

const stripeObjectId = value => (
  typeof value === 'string'
    ? value
    : typeof value?.id === 'string'
      ? value.id
      : ''
);

const validateCapturedStockRefund = (order, refund, paymentIntentId) => {
  const id = String(refund?.id || '').trim();
  const status = String(refund?.status || '').trim();
  const amountMinor = refund?.amount;
  const currency = String(refund?.currency || '').trim().toLowerCase();
  const refundPaymentIntentId = stripeObjectId(refund?.payment_intent);
  const expectedAmountMinor = getExpectedStripeTotalMinor(order);
  const expectedCurrency = String(order?.currency || '').toLowerCase();

  if (!/^re_[A-Za-z0-9_]+$/.test(id)) {
    throw paymentError(
      'Stripe did not return a valid stock-loss refund reference.',
      'CAPTURED_PAYMENT_REFUND_REFERENCE_INVALID',
      503,
    );
  }
  if (!STOCK_REFUND_STATUSES.has(status)) {
    throw paymentError(
      'Stripe returned an invalid stock-loss refund status.',
      'CAPTURED_PAYMENT_REFUND_STATUS_INVALID',
      503,
    );
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 || amountMinor !== expectedAmountMinor) {
    throw paymentError(
      'Stripe stock-loss refund amount does not match the captured order total.',
      'CAPTURED_PAYMENT_REFUND_AMOUNT_MISMATCH',
      503,
    );
  }
  if (!currency || currency !== expectedCurrency) {
    throw paymentError(
      'Stripe stock-loss refund currency does not match the captured order currency.',
      'CAPTURED_PAYMENT_REFUND_CURRENCY_MISMATCH',
      503,
    );
  }
  if (!refundPaymentIntentId || refundPaymentIntentId !== paymentIntentId) {
    throw paymentError(
      'Stripe stock-loss refund does not belong to this order payment.',
      'CAPTURED_PAYMENT_REFUND_PAYMENT_MISMATCH',
      503,
    );
  }
  if (
    order?.paymentResult?.stockRefundStatus === 'succeeded'
    && status !== 'succeeded'
  ) {
    throw paymentError(
      'A completed Stripe stock-loss refund cannot regress to another status.',
      'CAPTURED_PAYMENT_REFUND_STATUS_REGRESSION',
      503,
    );
  }
  return {
    id,
    status,
    amountMinor,
    currency: currency.toUpperCase(),
  };
};

const persistCapturedStockRefund = async (
  order,
  refundSnapshot,
  paymentIntentId,
  observedAt = new Date(),
) => {
  if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
    throw paymentError(
      'The Stripe stock-loss refund observation time is invalid.',
      'CAPTURED_PAYMENT_REFUND_TIME_INVALID',
      503,
    );
  }
  const update = await Order.updateOne({
    _id: order._id,
    isPaid: false,
    'paymentResult.stockRefundId': { $in: [null, refundSnapshot.id] },
    'paymentResult.stockRefundAmountMinor': { $in: [null, refundSnapshot.amountMinor] },
    'paymentResult.stockRefundCurrency': { $in: [null, '', refundSnapshot.currency] },
  }, {
    $set: {
      paymentSetupState: refundSnapshot.status === 'succeeded' ? 'closed' : 'refunding',
      'paymentResult.paymentIntentId': paymentIntentId,
      'paymentResult.stockRefundId': refundSnapshot.id,
      'paymentResult.stockRefundStatus': refundSnapshot.status,
      'paymentResult.stockRefundAmountMinor': refundSnapshot.amountMinor,
      'paymentResult.stockRefundCurrency': refundSnapshot.currency,
      'paymentResult.failureCode': 'ORDER_STOCK_CHANGED_AFTER_CAPTURE',
      'paymentResult.failureMessage': 'The card payment was refunded because inventory was no longer available.',
      'paymentResult.failureAt': order.paymentResult?.failureAt || observedAt,
    },
  }, { runValidators: true });
  if ((update.matchedCount ?? update.n ?? 0) !== 1) {
    throw paymentError(
      'The persisted Stripe stock-loss refund snapshot conflicts with this provider response.',
      'CAPTURED_PAYMENT_REFUND_SNAPSHOT_CONFLICT',
      503,
    );
  }
  if (refundSnapshot.status === 'succeeded') {
    await Order.updateOne({
      _id: order._id,
      isPaid: false,
      'paymentResult.stockRefundId': refundSnapshot.id,
      'paymentResult.stockRefundAt': null,
    }, {
      $set: { 'paymentResult.stockRefundAt': observedAt },
    }, { runValidators: true });
  }
  return Order.findById(order._id);
};

/**
 * Production fallback for legacy/unreserved Stripe objects. New checkouts
 * reserve stock before Stripe object creation; an older still-payable object
 * can nevertheless capture after deployment. If its stock commit fails, move
 * the order into a durable refund-only state and recover one idempotent full
 * refund until Stripe reports success. The order is never eligible for a
 * later fulfillment retry after `refunding` is persisted.
 */
const refundCapturedOrderAfterStockFailure = async ({ order, paymentIntentId }) => {
  if (!stripe?.refunds || !paymentIntentId) {
    throw paymentError(
      'The captured card payment requires an automatic refund, but Stripe is temporarily unavailable.',
      'CAPTURED_PAYMENT_REFUND_UNAVAILABLE',
      503,
    );
  }

  let current = await Order.findById(order._id);
  if (!current) throw paymentError('Order not found.', 'ORDER_NOT_FOUND', 404);
  let refund;
  const existingRefundId = current.paymentResult?.stockRefundId;
  if (existingRefundId) {
    refund = await stripe.refunds.retrieve(existingRefundId);
  } else {
    refund = await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        reason: 'requested_by_customer',
        metadata: {
          type: 'order_inventory_refund',
          orderId: String(current.orderId || ''),
          mongoOrderId: String(current._id),
        },
      },
      { idempotencyKey: capturedStockRefundIdempotencyKey(current) },
    );
  }
  const refundSnapshot = validateCapturedStockRefund(current, refund, paymentIntentId);
  current = await persistCapturedStockRefund(current, refundSnapshot, paymentIntentId);
  if (refundSnapshot.status !== 'succeeded') {
    throw paymentError(
      refundSnapshot.status === 'failed' || refundSnapshot.status === 'canceled'
        ? 'The automatic refund failed and requires immediate payment support review.'
        : 'The automatic refund is still processing.',
      refundSnapshot.status === 'failed' || refundSnapshot.status === 'canceled'
        ? 'CAPTURED_PAYMENT_REFUND_FAILED'
        : 'CAPTURED_PAYMENT_REFUND_PENDING',
      503,
    );
  }

  // Dynamic import avoids the intentional cancellation-service validation
  // dependency on this module.
  if (current.orderStatus !== 'cancelled') {
    const { cancelUnpaidOrderLocally } = require('./orderCancellationService');
    await cancelUnpaidOrderLocally({
      orderId: current._id,
      reason: 'Inventory was unavailable after a legacy card payment capture; Stripe refunded the buyer.',
      externalPaymentClosed: true,
      paymentFailure: {
        code: 'ORDER_STOCK_CHANGED_AFTER_CAPTURE',
        message: 'The card payment was refunded because inventory was no longer available.',
        at: new Date(),
      },
      confirmationFields: {},
      cancellationActorRole: 'system',
    });
  }
  // Cancellation sets the setup state to closed. Re-assert the immutable
  // external refund evidence in case a legacy schema instance omitted it.
  current = await persistCapturedStockRefund(current, refundSnapshot, paymentIntentId);
  const {
    enqueueOrderStockRefundBuyerNotifications,
  } = require('./financialNotificationOutboxService');
  // Compatibility repair for a refund/cancellation committed by an older
  // process before the receipt event existed. Current transactions already
  // insert the same event; this replay resolves to those rows by event key.
  await enqueueOrderStockRefundBuyerNotifications(current);
  return { order: current, newlyFulfilled: false, paymentRefunded: true };
};

/**
 * Claims and fulfills one Stripe checkout exactly once. The short lease lets a
 * later webhook retry recover if a process stops before the order is saved.
 */
const fulfillClaimedStripeOrder = async ({ order, eventId, paymentIntentId, emailAddress }) => {
  if (isPaymentFulfilled(order)) {
    if (order.appliedCoupons?.length) {
      await consumeOrderCoupons({ orderId: order._id });
    }
    await claimStripePaymentCompletion({
      paymentIntentId,
      sourceType: 'order_payment',
      sourceReferenceId: order._id,
      eventId,
    });
    await markStripePaymentCompletionDone({
      paymentIntentId,
      sourceType: 'order_payment',
      sourceReferenceId: order._id,
    });
    return { order, newlyFulfilled: false };
  }

  try {
    await claimStripePaymentCompletion({
      paymentIntentId,
      sourceType: 'order_payment',
      sourceReferenceId: order._id,
      eventId,
    });
  } catch (error) {
    if (error?.code !== 'STRIPE_PAYMENT_REVERSED_BEFORE_COMPLETION') throw error;
    const { cancelUnpaidOrderLocally } = require('./orderCancellationService');
    await cancelUnpaidOrderLocally({
      orderId: order._id,
      reason: 'Stripe reversed this card payment before local order fulfillment.',
      externalPaymentClosed: true,
      paymentFailure: {
        code: 'STRIPE_PAYMENT_REVERSED_BEFORE_COMPLETION',
        message: 'The card payment was reversed before order fulfillment.',
        at: new Date(),
      },
      confirmationFields: {},
      cancellationActorRole: 'system',
    });
    return {
      order: await Order.findById(order._id),
      newlyFulfilled: false,
      paymentReversed: true,
    };
  }

  if (
    order?.paymentSetupState === 'refunding'
    || order?.paymentResult?.stockRefundId
    || order?.paymentResult?.stockRefundStatus === 'succeeded'
  ) {
    return refundCapturedOrderAfterStockFailure({ order, paymentIntentId });
  }

  const now = new Date();
  const staleBefore = new Date(now.getTime() - 5 * 60 * 1000);
  const claimed = await Order.findOneAndUpdate(
    {
      _id: order._id,
      isPaid: false,
      awaitingPayment: true,
      orderStatus: { $ne: 'cancelled' },
      paymentSetupState: { $ne: 'refunding' },
      $or: [
        { paymentProcessingStartedAt: null },
        { paymentProcessingStartedAt: { $lt: staleBefore } },
      ],
    },
    {
      $set: {
        paymentProcessingStartedAt: now,
        stripeWebhookEventId: eventId || null,
      },
    },
    { new: true },
  );

  if (!claimed) {
    const current = await Order.findById(order._id);
    if (isPaymentFulfilled(current)) return { order: current, newlyFulfilled: false };
    throw paymentError(
      'This payment is already being finalized. Stripe should retry shortly.',
      'PAYMENT_FULFILLMENT_IN_PROGRESS',
      503,
    );
  }

  try {
    try {
      await commitOrderInventory(claimed._id);
    } catch (inventoryError) {
      if (inventoryError?.code !== 'ORDER_STOCK_CHANGED') throw inventoryError;
      const refunding = await Order.findOneAndUpdate(
        {
          _id: claimed._id,
          isPaid: false,
          paymentProcessingStartedAt: now,
        },
        {
          $set: {
            paymentProcessingStartedAt: null,
            paymentSetupState: 'refunding',
            'paymentResult.paymentIntentId': paymentIntentId,
            'paymentResult.failureCode': 'ORDER_STOCK_CHANGED_AFTER_CAPTURE',
            'paymentResult.failureMessage': 'The card payment is being refunded because inventory is unavailable.',
            'paymentResult.failureAt': now,
          },
        },
        { new: true },
      );
      if (!refunding) {
        const current = await Order.findById(claimed._id);
        if (isPaymentFulfilled(current)) return { order: current, newlyFulfilled: false };
        if (current?.paymentSetupState !== 'refunding') throw inventoryError;
        return refundCapturedOrderAfterStockFailure({ order: current, paymentIntentId });
      }
      return refundCapturedOrderAfterStockFailure({ order: refunding, paymentIntentId });
    }

    claimed.inventoryCommitted = true;
    claimed.isPaid = true;
    claimed.paidAt = claimed.paidAt || now;
    claimed.awaitingPayment = false;
    claimed.orderStatus = 'confirmed';
    claimed.paymentFulfilledAt = now;
    claimed.paymentProcessingStartedAt = null;
    claimed.paymentSetupState = 'complete';
    claimed.paymentResult = claimed.paymentResult || {};
    claimed.paymentResult.paymentIntentId = paymentIntentId || null;
    claimed.paymentResult.emailAddress = emailAddress || claimed.shippingInfo?.email || null;
    claimed.paymentResult.failureCode = '';
    claimed.paymentResult.failureMessage = '';
    claimed.paymentResult.failureAt = null;

    for (const fulfillment of claimed.sellerFulfillment || []) {
      if (fulfillment.status === 'pending') {
        fulfillment.status = 'confirmed';
        fulfillment.updatedAt = now;
      }
    }
    claimed.confirmation = claimed.confirmation || {};
    claimed.confirmation.confirmedAt = claimed.confirmation.confirmedAt || now;
    claimed.confirmation.confirmedVia = 'stripe_payment';
    await claimed.save();

    if (claimed.appliedCoupons?.length) {
      try {
        await consumeOrderCoupons({ orderId: claimed._id });
      } catch (couponError) {
        // Stripe has already captured the payment. Returning a retryable error
        // lets the signed webhook finish the idempotent consumption rather
        // than acknowledging a partially finalized lifecycle.
        couponError.statusCode = 500;
        throw couponError;
      }
    }

    await markStripePaymentCompletionDone({
      paymentIntentId,
      sourceType: 'order_payment',
      sourceReferenceId: claimed._id,
    });

    return { order: claimed, newlyFulfilled: true };
  } catch (error) {
    await Order.updateOne(
      { _id: claimed._id, isPaid: false, paymentProcessingStartedAt: now },
      { $set: { paymentProcessingStartedAt: null } },
    ).catch(() => {});
    throw error;
  }
};

const fulfillStripeOrder = async ({ order, stripeSession, eventId }) => {
  validateStripeOrderSession(order, stripeSession, { requirePaid: true });
  return fulfillClaimedStripeOrder({
    order,
    eventId,
    paymentIntentId: typeof stripeSession.payment_intent === 'string'
      ? stripeSession.payment_intent
      : stripeSession.payment_intent?.id,
    emailAddress: stripeSession.customer_details?.email,
  });
};

const fulfillStripeOrderPaymentIntent = async ({ order, paymentIntent, eventId }) => {
  validateStripeOrderPaymentIntent(order, paymentIntent, { requireSucceeded: true });
  return fulfillClaimedStripeOrder({
    order,
    eventId,
    paymentIntentId: paymentIntent.id,
    emailAddress: paymentIntent.receipt_email,
  });
};

const recordStripeOrderPaymentFailure = async ({ order, paymentIntent }) => {
  validateStripeOrderPaymentIntent(order, paymentIntent);
  if (!order.awaitingPayment || order.isPaid || order.orderStatus === 'cancelled') return order;
  order.paymentResult = order.paymentResult || {};
  order.paymentResult.failureCode = String(paymentIntent.last_payment_error?.code || 'card_declined').slice(0, 120);
  order.paymentResult.failureMessage = String(
    paymentIntent.last_payment_error?.message || 'The card payment failed. Try another payment method.'
  ).slice(0, 500);
  order.paymentResult.failureAt = new Date();
  await order.save();
  return order;
};

module.exports = {
  toStripeMinorUnits,
  getExpectedStripeTotalMinor,
  getStripeOrderChargeAmountMinor,
  validateStripeOrderSession,
  validateStripeOrderPaymentIntent,
  isPaymentFulfilled,
  fulfillStripeOrder,
  fulfillStripeOrderPaymentIntent,
  recordStripeOrderPaymentFailure,
  attachStripeOrderReference,
  refundCapturedOrderAfterStockFailure,
  paymentError,
};
