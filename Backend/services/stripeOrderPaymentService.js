const Order = require('../models/Order');
const { commitOrderInventory } = require('./orderInventoryService');

const STRIPE_ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

const toStripeMinorUnits = (amount, currency) => {
  const value = Math.max(0, Number(amount) || 0);
  return STRIPE_ZERO_DECIMAL_CURRENCIES.has(String(currency || '').toUpperCase())
    ? Math.round(value)
    : Math.round(value * 100);
};

const getExpectedStripeTotalMinor = (order) => {
  const currency = order?.currency || 'USD';
  const itemTotal = (order?.orderItems || []).reduce(
    (sum, item) => sum + (toStripeMinorUnits(item?.price, currency) * Math.max(1, Number(item?.quantity) || 1)),
    0,
  );
  const shipping = toStripeMinorUnits(order?.orderSummary?.shippingCost, currency);
  const tax = toStripeMinorUnits(order?.orderSummary?.tax, currency);
  const discount = toStripeMinorUnits(order?.orderSummary?.couponDiscount, currency);
  return Math.max(0, itemTotal + shipping + tax - discount);
};

const paymentError = (message, code, statusCode = 400) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const validateStripeOrderSession = (order, stripeSession, { requirePaid = false } = {}) => {
  if (!order || order.paymentMethod !== 'stripe') {
    throw paymentError('This order is not a card-payment order.', 'NOT_STRIPE_ORDER');
  }
  if (!stripeSession?.id || stripeSession.id !== order.stripeSessionId) {
    throw paymentError('The payment session does not belong to this order.', 'PAYMENT_SESSION_MISMATCH');
  }
  if (stripeSession.mode && stripeSession.mode !== 'payment') {
    throw paymentError('The payment session has an invalid mode.', 'PAYMENT_SESSION_MODE_MISMATCH');
  }
  if (String(stripeSession.metadata?.orderId || '') !== String(order.orderId || '')) {
    throw paymentError('The payment session order reference is invalid.', 'PAYMENT_ORDER_MISMATCH');
  }
  if (String(stripeSession.currency || '').toUpperCase() !== String(order.currency || '').toUpperCase()) {
    throw paymentError('The payment session currency is invalid.', 'PAYMENT_CURRENCY_MISMATCH');
  }
  if (Number(stripeSession.amount_total) !== getExpectedStripeTotalMinor(order)) {
    throw paymentError('The payment session total is invalid.', 'PAYMENT_AMOUNT_MISMATCH');
  }
  if (order.stripeMode) {
    if (
      stripeSession.metadata?.type !== 'order_payment'
      || stripeSession.metadata?.paymentFlow !== 'checkout_session'
      || stripeSession.metadata?.stripeMode !== order.stripeMode
      || String(stripeSession.metadata?.mongoOrderId || '') !== String(order._id || '')
      || Number(stripeSession.metadata?.amountMinor) !== getExpectedStripeTotalMinor(order)
      || (typeof stripeSession.livemode === 'boolean'
        && stripeSession.livemode !== (order.stripeMode === 'live'))
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
    stripeSession.metadata?.userId
    && String(stripeSession.metadata.userId) !== String(order.user || '')
  ) {
    throw paymentError('The payment user does not belong to this order.', 'PAYMENT_USER_MISMATCH');
  }
  if (requirePaid && stripeSession.payment_status !== 'paid') {
    throw paymentError('Stripe has not confirmed this payment.', 'PAYMENT_NOT_CONFIRMED', 409);
  }
  return true;
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
    || String(metadata.orderId || '') !== String(order.orderId || '')
    || String(metadata.mongoOrderId || '') !== String(order._id || '')
  ) {
    throw paymentError('The PaymentIntent order reference is invalid.', 'PAYMENT_ORDER_MISMATCH');
  }
  if (String(metadata.userId || '') !== String(order.user || '')) {
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
      || (typeof paymentIntent.livemode === 'boolean'
        && paymentIntent.livemode !== (order.stripeMode === 'live'))
    )
  ) {
    throw paymentError('The PaymentIntent Stripe mode is invalid.', 'PAYMENT_MODE_MISMATCH');
  }
  const expected = getExpectedStripeTotalMinor(order);
  if (
    Number(paymentIntent.amount) !== expected
    || (metadata.amountMinor && Number(metadata.amountMinor) !== expected)
  ) {
    throw paymentError('The PaymentIntent total is invalid.', 'PAYMENT_AMOUNT_MISMATCH');
  }
  if (String(paymentIntent.currency || '').toUpperCase() !== String(order.currency || '').toUpperCase()) {
    throw paymentError('The PaymentIntent currency is invalid.', 'PAYMENT_CURRENCY_MISMATCH');
  }
  if (requireSucceeded) {
    if (paymentIntent.status !== 'succeeded' || Number(paymentIntent.amount_received) !== expected) {
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

/**
 * Claims and fulfills one Stripe checkout exactly once. The short lease lets a
 * later webhook retry recover if a process stops before the order is saved.
 */
const fulfillClaimedStripeOrder = async ({ order, eventId, paymentIntentId, emailAddress }) => {
  if (isPaymentFulfilled(order)) {
    return { order, newlyFulfilled: false };
  }

  const now = new Date();
  const staleBefore = new Date(now.getTime() - 5 * 60 * 1000);
  const claimed = await Order.findOneAndUpdate(
    {
      _id: order._id,
      isPaid: false,
      awaitingPayment: true,
      orderStatus: { $ne: 'cancelled' },
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
    await commitOrderInventory(claimed._id);

    claimed.inventoryCommitted = true;
    claimed.isPaid = true;
    claimed.paidAt = claimed.paidAt || now;
    claimed.awaitingPayment = false;
    claimed.orderStatus = 'confirmed';
    claimed.paymentFulfilledAt = now;
    claimed.paymentProcessingStartedAt = null;
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

    return { order: claimed, newlyFulfilled: true };
  } catch (error) {
    await Order.updateOne(
      { _id: claimed._id, isPaid: false, paymentProcessingStartedAt: now },
      { $set: { paymentProcessingStartedAt: null } },
    ).catch(() => {});
    if (error?.code === 'ORDER_STOCK_CHANGED') error.statusCode = 500;
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
  validateStripeOrderSession,
  validateStripeOrderPaymentIntent,
  isPaymentFulfilled,
  fulfillStripeOrder,
  fulfillStripeOrderPaymentIntent,
  recordStripeOrderPaymentFailure,
  paymentError,
};
