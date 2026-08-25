'use strict';

const Order = require('../models/Order');
const { commitOrderInventoryAndCoupons } = require('./orderInventoryService');
const {
  getExpectedStripeTotalMinor,
  toStripeMinorUnits,
} = require('./stripeOrderPaymentService');
const {
  setAllSellerFulfillmentStatus,
  syncAggregateDeliveryState,
} = require('./orderFulfillmentService');
const {
  enqueueNoChargeOrderBuyerNotifications,
  enqueueNoChargeOrderSellerNotifications,
} = require('./financialNotificationOutboxService');

const ONLINE_PAYMENT_METHODS = new Set(['stripe', 'wallet']);

const noChargeError = (message, code, statusCode = 409) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const hasExactlyZeroOrderTotal = order => (
  getExpectedStripeTotalMinor(order) === 0
  && toStripeMinorUnits(order?.orderSummary?.totalAmount, order?.currency) === 0
);

const isNoChargeOnlineOrder = order => (
  ONLINE_PAYMENT_METHODS.has(String(order?.paymentMethod || ''))
  && hasExactlyZeroOrderTotal(order)
  && !order?.stripePaymentIntentId
  && !order?.stripeSessionId
);

const enqueueNoChargeOrderNotifications = async (order, session) => {
  await enqueueNoChargeOrderBuyerNotifications(order, { session });
  const sellerIds = [...new Set(
    (order?.sellerSettlement || []).map(entry => String(entry?.seller || '')).filter(Boolean)
  )];
  for (const sellerId of sellerIds) {
    await enqueueNoChargeOrderSellerNotifications(order, sellerId, { session });
  }
};

/**
 * Complete a genuinely zero-total online order without creating an external
 * payment object or debiting the Wallet. The caller must own the transaction
 * that inserted the order and reserved its coupons, so inventory, coupon use,
 * and every paid/confirmed lifecycle field commit or roll back together.
 */
const completeNoChargeOrder = async ({ orderId, session, at = new Date() }) => {
  if (!session?.inTransaction?.()) {
    throw noChargeError(
      'No-charge checkout completion requires an active database transaction.',
      'NO_CHARGE_TRANSACTION_REQUIRED',
      500,
    );
  }

  let order = await Order.findById(orderId).session(session);
  if (!order) throw noChargeError('Order not found.', 'ORDER_NOT_FOUND', 404);
  if (!isNoChargeOnlineOrder(order)) {
    throw noChargeError(
      'This order still requires payment.',
      'ORDER_PAYMENT_REQUIRED',
      409,
    );
  }

  if (
    order.isPaid
    && order.awaitingPayment === false
    && order.inventoryCommitted
    && order.paymentSetupState === 'complete'
    && order.paymentFulfilledAt
  ) {
    await enqueueNoChargeOrderNotifications(order, session);
    return { order, alreadyCompleted: true };
  }
  if (order.orderStatus === 'cancelled' || order.confirmation?.declinedAt) {
    throw noChargeError(
      'This order was cancelled and cannot be completed.',
      'ORDER_CANCELLED',
    );
  }
  if (!order.awaitingPayment || order.isPaid) {
    throw noChargeError(
      'This no-charge order is in an inconsistent payment state.',
      'NO_CHARGE_STATE_CONFLICT',
      500,
    );
  }
  if (order.stripePaymentIntentId || order.stripeSessionId) {
    throw noChargeError(
      'A no-charge order cannot have a Stripe payment reference.',
      'NO_CHARGE_EXTERNAL_REFERENCE_CONFLICT',
      500,
    );
  }
  if (!['not_started', 'closed'].includes(order.paymentSetupState)) {
    throw noChargeError(
      'External payment setup already started for this order.',
      'NO_CHARGE_SETUP_CONFLICT',
      500,
    );
  }

  await commitOrderInventoryAndCoupons(order._id, { session });

  // Coupon reservation/consumption and inventory helpers use their own
  // session-bound Order reads. Reload instead of saving the stale controller
  // instance and accidentally overwriting their lifecycle/version fields.
  order = await Order.findById(order._id).session(session);
  if (!order || !isNoChargeOnlineOrder(order)) {
    throw noChargeError(
      'The no-charge order changed while it was being completed.',
      'NO_CHARGE_STATE_CONFLICT',
      500,
    );
  }

  order.awaitingPayment = false;
  order.isPaid = true;
  order.paidAt = order.paidAt || at;
  order.paymentFulfilledAt = order.paymentFulfilledAt || at;
  order.paymentProcessingStartedAt = null;
  order.paymentSetupState = 'complete';
  order.paymentExpiresAt = null;
  order.paymentCancelledAt = null;

  if (order.sellerFulfillment?.length) {
    setAllSellerFulfillmentStatus(order, 'confirmed', at);
    syncAggregateDeliveryState(order);
  } else {
    order.orderStatus = 'confirmed';
  }

  order.confirmation = order.confirmation || {};
  order.confirmation.confirmedAt = order.confirmation.confirmedAt || at;
  order.confirmation.confirmedVia = order.paymentMethod === 'wallet'
    ? 'wallet_payment'
    : 'stripe_payment';

  order.paymentResult = order.paymentResult || {};
  order.paymentResult.emailAddress = order.paymentResult.emailAddress
    || order.shippingInfo?.email
    || null;
  order.paymentResult.failureCode = '';
  order.paymentResult.failureMessage = '';
  order.paymentResult.failureAt = null;

  await order.save({ session });
  await enqueueNoChargeOrderNotifications(order, session);
  return { order, alreadyCompleted: false };
};

module.exports = {
  completeNoChargeOrder,
  hasExactlyZeroOrderTotal,
  isNoChargeOnlineOrder,
};
