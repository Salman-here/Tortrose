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
  if (requirePaid && stripeSession.payment_status !== 'paid') {
    throw paymentError('Stripe has not confirmed this payment.', 'PAYMENT_NOT_CONFIRMED', 409);
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
const fulfillStripeOrder = async ({ order, stripeSession, eventId }) => {
  validateStripeOrderSession(order, stripeSession, { requirePaid: true });
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
    claimed.paymentResult.paymentIntentId = stripeSession.payment_intent || null;
    claimed.paymentResult.emailAddress = stripeSession.customer_details?.email || claimed.shippingInfo?.email || null;

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

module.exports = {
  toStripeMinorUnits,
  getExpectedStripeTotalMinor,
  validateStripeOrderSession,
  isPaymentFulfilled,
  fulfillStripeOrder,
};
