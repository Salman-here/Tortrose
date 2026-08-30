'use strict';

const mongoose = require('mongoose');
const Order = require('../models/Order');
const { stripe } = require('../config/stripe');
const {
  commitOrderInventory,
  restoreOrderInventory,
} = require('./orderInventoryService');
const {
  COUPON_USAGE_VERSION,
  consumeOrderCoupons,
  reactivateReleasedOrderCouponsInSession,
  releaseOrderCouponsInSession,
} = require('./couponUsageService');
const {
  getBuyerCancellationBlock,
  setAllSellerFulfillmentStatus,
  syncAggregateDeliveryState,
} = require('./orderFulfillmentService');
const {
  validateStripeOrderPaymentIntent,
  validateStripeOrderSession,
} = require('./stripeOrderPaymentService');
const {
  enqueueCodOrderDecisionSellerNotifications,
  enqueueOrderLifecycleBuyerNotifications,
  enqueueOrderStockRefundBuyerNotifications,
} = require('./financialNotificationOutboxService');

const notificationSellerIds = order => [...new Set([
  ...(order?.sellerSettlement || []).map(entry => String(entry?.seller || '')),
  ...(order?.sellerFulfillment || []).map(entry => String(entry?.seller || '')),
  ...(order?.orderItems || []).map(entry => String(entry?.seller || '')),
].filter(Boolean))];

const CANCELLATION_CHANNELS = new Set([
  'email',
  'whatsapp',
  'dashboard',
  'admin',
  'manual',
  'system',
]);

const inferCancellationChannel = (confirmationFields, actorRole) => {
  const requested = confirmationFields?.cancelledVia
    || confirmationFields?.decidedVia
    || confirmationFields?.confirmedVia;
  if (CANCELLATION_CHANNELS.has(requested)) return requested;
  if (actorRole === 'admin') return 'admin';
  if (actorRole === 'seller') return 'manual';
  if (actorRole === 'buyer') return 'dashboard';
  return 'system';
};

const cancellationError = (message, code, statusCode = 409) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const runInTransaction = async (work, existingSession = null) => {
  if (existingSession) return work(existingSession);
  let result;
  await mongoose.connection.transaction(async session => {
    result = await work(session);
  }, {
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
  });
  return result;
};

const assertCancellationAllowed = order => {
  if (order?.isPaid) {
    throw cancellationError(
      'Paid orders require a verified refund before cancellation.',
      'PAID_ORDER_REQUIRES_REFUND',
    );
  }
  const block = getBuyerCancellationBlock(order);
  if (block) throw cancellationError(block.message, block.code);
};

const applyConfirmationFields = (order, fields = {}, { preserveExisting = false } = {}) => {
  if (!fields || typeof fields !== 'object') return;
  order.confirmation = order.confirmation || {};
  for (const [field, value] of Object.entries(fields)) {
    if (!field || field.includes('.')) continue;
    const currentValue = order.confirmation?.[field];
    if (
      preserveExisting
      && currentValue !== undefined
      && currentValue !== null
      && currentValue !== ''
    ) continue;
    order.set(`confirmation.${field}`, value);
  }
};

const assertConfirmationTokenValid = (order, token, at) => {
  if (!token) return;
  if (order.confirmation?.token !== token) {
    throw cancellationError(
      'Order confirmation token is no longer valid.',
      'ORDER_CONFIRMATION_TOKEN_INVALID',
      404,
    );
  }
  const expiresAt = order.confirmation?.tokenExpiresAt
    ? new Date(order.confirmation.tokenExpiresAt).getTime()
    : null;
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= at.getTime())) {
    throw cancellationError(
      'Confirmation link expired.',
      'ORDER_CONFIRMATION_EXPIRED',
      410,
    );
  }
};

/**
 * Apply the local half of an unpaid-order cancellation exactly once.
 *
 * Stripe callers must first obtain an authoritative cancelled/expired result
 * from Stripe and pass `externalPaymentClosed`. No network operation runs in
 * this transaction. COD coupons are already consumed at placement, so only
 * still-reserved redemptions are released.
 */
const cancelUnpaidOrderLocally = async ({
  orderId,
  token = null,
  reason = 'Order cancelled before payment or fulfillment.',
  confirmationFields = {},
  paymentFailure = null,
  allowedExistingDecisionChannels = null,
  externalPaymentClosed = false,
  cancellationActorRole = 'system',
  at = new Date(),
  session = null,
}) => runInTransaction(async transactionSession => {
  if (!['buyer', 'seller', 'admin', 'system'].includes(cancellationActorRole)) {
    throw cancellationError(
      'Cancellation actor role is invalid.',
      'ORDER_CANCELLATION_ACTOR_INVALID',
      400,
    );
  }
  const order = await Order.findById(orderId).session(transactionSession);
  if (!order) throw cancellationError('Order not found.', 'ORDER_NOT_FOUND', 404);
  assertConfirmationTokenValid(order, token, at);
  assertCancellationAllowed(order);
  const existingDecisionChannel = order.confirmation?.decidedVia
    || order.confirmation?.confirmedVia;
  if (Array.isArray(allowedExistingDecisionChannels)) {
    // `decidedVia` was added after `confirmedVia`. Legacy orders may only
    // have the older field, so ignoring it would let another channel override
    // an already durable buyer decision during a retry race.
    if (
      existingDecisionChannel
      && !allowedExistingDecisionChannels.includes(existingDecisionChannel)
    ) {
      throw cancellationError(
        'This order confirmation was already decided through another channel.',
        'ORDER_DECISION_ALREADY_MADE',
      );
    }
  }
  const previousOrderStatus = order.orderStatus;
  const wasAlreadyCancelled = previousOrderStatus === 'cancelled';

  const hasExternalStripeReference = order.paymentMethod === 'stripe'
    && Boolean(order.stripePaymentIntentId || order.stripeSessionId);
  if (hasExternalStripeReference && !externalPaymentClosed) {
    throw cancellationError(
      'The Stripe payment attempt must be closed before this order can be cancelled.',
      'STRIPE_PAYMENT_STILL_OPEN',
    );
  }
  if (
    order.paymentMethod === 'stripe'
    && !hasExternalStripeReference
    && !['not_started', 'closed'].includes(order.paymentSetupState)
  ) {
    throw cancellationError(
      'This Stripe payment setup has an unknown result and must be recovered before cancellation.',
      'PAYMENT_SETUP_RECOVERY_REQUIRED',
      503,
    );
  }
  if (order.paymentProcessingStartedAt) {
    throw cancellationError(
      'This payment is already being finalized and cannot be cancelled.',
      'PAYMENT_FULFILLMENT_IN_PROGRESS',
    );
  }

  if (order.inventoryCommitted) {
    await restoreOrderInventory(order._id, { session: transactionSession });
    order.inventoryCommitted = false;
  }

  const releasedCoupons = await releaseOrderCouponsInSession(
    order,
    transactionSession,
    reason,
    at,
    { includeConsumed: true },
  );

  order.orderStatus = 'cancelled';
  setAllSellerFulfillmentStatus(order, 'cancelled', at);
  if (order.sellerFulfillment?.length) syncAggregateDeliveryState(order);
  order.orderStatus = 'cancelled';
  if (order.paymentMethod === 'stripe') {
    order.paymentCancelledAt = order.paymentCancelledAt || at;
    order.paymentSetupState = 'closed';
  }
  if (paymentFailure && !order.paymentResult?.failureAt) {
    order.paymentResult = order.paymentResult || {};
    order.paymentResult.failureCode = String(paymentFailure.code || 'PAYMENT_CANCELLED').slice(0, 120);
    order.paymentResult.failureMessage = String(paymentFailure.message || reason).slice(0, 500);
    order.paymentResult.failureAt = paymentFailure.at || at;
  }
  const incomingDecisionChannel = confirmationFields?.decidedVia
    || confirmationFields?.confirmedVia;
  const explicitlyReplacesExistingDecision = Boolean(
    wasAlreadyCancelled
    && existingDecisionChannel
    && incomingDecisionChannel
    && incomingDecisionChannel !== existingDecisionChannel
    && Array.isArray(allowedExistingDecisionChannels)
    && allowedExistingDecisionChannels.includes(existingDecisionChannel)
  );
  // A retry that observes the already-cancelled row may still finish missing
  // legacy metadata, but it must not replace the original durable decision or
  // its timestamp with values generated by the replay. The one exception is
  // an explicit cross-channel buyer override authorized above.
  const effectiveConfirmationFields = (
    !wasAlreadyCancelled || explicitlyReplacesExistingDecision
  ) ? {
      ...confirmationFields,
      cancelledAt: at,
      cancelledByRole: cancellationActorRole,
      cancelledVia: inferCancellationChannel(confirmationFields, cancellationActorRole),
    } : confirmationFields;
  applyConfirmationFields(order, effectiveConfirmationFields, {
    preserveExisting: wasAlreadyCancelled && !explicitlyReplacesExistingDecision,
  });
  await order.save({ session: transactionSession });
  if (!wasAlreadyCancelled) {
    if (
      order.paymentMethod === 'stripe'
      && order.paymentResult?.stockRefundStatus === 'succeeded'
    ) {
      // This event combines the cancellation status with the exact
      // provider-confirmed refund. A generic cancellation message would be
      // incomplete and could wrongly imply that no refund was recorded.
      await enqueueOrderStockRefundBuyerNotifications(order, {
        session: transactionSession,
      });
    } else {
      await enqueueOrderLifecycleBuyerNotifications(order, {
        status: 'cancelled',
        previousStatus: previousOrderStatus,
        transitionAt: at,
        actorRole: cancellationActorRole,
        session: transactionSession,
      });
    }
  }
  if (!wasAlreadyCancelled && order.paymentMethod === 'cash_on_delivery') {
    for (const sellerId of notificationSellerIds(order)) {
      await enqueueCodOrderDecisionSellerNotifications(order, sellerId, {
        decision: 'cancelled',
        actorRole: cancellationActorRole,
        transitionAt: order.confirmation?.cancelledAt
          || order.confirmation?.cancelledFromDashboardAt
          || order.confirmation?.declinedAt
          || order.confirmation?.decidedAt
          || at,
        session: transactionSession,
      });
    }
  }

  return {
    order,
    releasedCoupons,
    // Coupon/inventory repair on a legacy inconsistent row is useful cleanup,
    // but the buyer-visible cancellation transition already happened. Keep
    // replays notification-idempotent regardless of cleanup work performed.
    alreadyCancelled: wasAlreadyCancelled,
  };
}, session);

const retrieveAndCancelPaymentIntent = async order => {
  let intent = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
  validateStripeOrderPaymentIntent(order, intent);
  if (intent.status === 'succeeded') return { paid: true, object: intent };
  if (intent.status === 'canceled') return { closed: true, object: intent };
  try {
    intent = await stripe.paymentIntents.cancel(intent.id, { cancellation_reason: 'abandoned' });
  } catch (error) {
    intent = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
    if (!['succeeded', 'canceled'].includes(intent.status)) throw error;
  }
  validateStripeOrderPaymentIntent(order, intent);
  return {
    paid: intent.status === 'succeeded',
    closed: intent.status === 'canceled',
    object: intent,
  };
};

const retrieveAndExpireCheckoutSession = async order => {
  let checkoutSession = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
  validateStripeOrderSession(order, checkoutSession);
  if (checkoutSession.payment_status === 'paid') return { paid: true, object: checkoutSession };
  if (checkoutSession.status === 'expired') return { closed: true, object: checkoutSession };
  if (checkoutSession.status === 'open') {
    try {
      checkoutSession = await stripe.checkout.sessions.expire(checkoutSession.id);
    } catch (error) {
      checkoutSession = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
      if (
        checkoutSession.payment_status !== 'paid'
        && !['expired', 'complete'].includes(checkoutSession.status)
      ) throw error;
    }
    validateStripeOrderSession(order, checkoutSession);
  }
  return {
    paid: checkoutSession.payment_status === 'paid',
    // Hosted order checkout is explicitly card-only. A complete/unpaid card
    // session cannot later settle asynchronously.
    closed: checkoutSession.status === 'expired'
      || (checkoutSession.status === 'complete' && checkoutSession.payment_status !== 'paid'),
    object: checkoutSession,
  };
};

/** Cancel an order through the correct payment boundary, then transition DB state. */
const cancelOrderSafely = async ({
  orderId,
  token = null,
  reason,
  confirmationFields = {},
  allowedExistingDecisionChannels = null,
  cancellationActorRole = 'system',
  at = new Date(),
}) => {
  if (!['buyer', 'seller', 'admin', 'system'].includes(cancellationActorRole)) {
    throw cancellationError(
      'Cancellation actor role is invalid.',
      'ORDER_CANCELLATION_ACTOR_INVALID',
      400,
    );
  }
  const order = await Order.findById(orderId);
  if (!order) throw cancellationError('Order not found.', 'ORDER_NOT_FOUND', 404);
  assertConfirmationTokenValid(order, token, at);
  assertCancellationAllowed(order);

  let externalPaymentClosed = false;
  if (
    order.paymentMethod === 'stripe'
    && !order.stripePaymentIntentId
    && !order.stripeSessionId
    && !['not_started', 'closed'].includes(order.paymentSetupState)
  ) {
    throw cancellationError(
      'This Stripe payment setup has an unknown result and must be recovered before cancellation.',
      'PAYMENT_SETUP_RECOVERY_REQUIRED',
      503,
    );
  }
  if (order.paymentMethod === 'stripe' && (order.stripePaymentIntentId || order.stripeSessionId)) {
    if (!stripe) {
      throw cancellationError(
        'Stripe is temporarily unavailable, so this payment cannot be cancelled safely.',
        'STRIPE_UNAVAILABLE',
        503,
      );
    }
    if (order.paymentProcessingStartedAt) {
      throw cancellationError(
        'This payment is already being finalized and cannot be cancelled.',
        'PAYMENT_FULFILLMENT_IN_PROGRESS',
      );
    }
    const result = order.paymentFlow === 'payment_sheet'
      ? await retrieveAndCancelPaymentIntent(order)
      : await retrieveAndExpireCheckoutSession(order);
    if (result.paid) {
      return { status: 'payment_succeeded', order, stripeObject: result.object };
    }
    if (!result.closed) {
      throw cancellationError(
        'Stripe has not closed this payment attempt yet.',
        'STRIPE_CANCELLATION_PENDING',
        503,
      );
    }
    externalPaymentClosed = true;
  }

  const localResult = await cancelUnpaidOrderLocally({
    orderId: order._id,
    token,
    reason,
    confirmationFields,
    allowedExistingDecisionChannels,
    externalPaymentClosed,
    cancellationActorRole,
    at,
  });
  return { status: 'cancelled', ...localResult };
};

/** Re-open a cancelled COD order only if every item can be reserved again. */
const reconfirmCancelledCodOrder = async ({
  orderId,
  token = null,
  confirmationFields = {},
  at = new Date(),
  session = null,
}) => runInTransaction(async transactionSession => {
  const order = await Order.findOne({
    _id: orderId,
    ...(token ? { 'confirmation.token': token } : {}),
  }).session(transactionSession);
  if (!order) throw cancellationError('Order not found.', 'ORDER_NOT_FOUND', 404);
  const tokenExpiresAt = token && order.confirmation?.tokenExpiresAt
    ? new Date(order.confirmation.tokenExpiresAt).getTime()
    : null;
  if (
    tokenExpiresAt !== null
    && (!Number.isFinite(tokenExpiresAt) || tokenExpiresAt <= at.getTime())
  ) {
    throw cancellationError(
      'Confirmation link expired.',
      'ORDER_CONFIRMATION_EXPIRED',
      410,
    );
  }
  if (order.paymentMethod !== 'cash_on_delivery') {
    throw cancellationError(
      'Only cash-on-delivery orders can be reconfirmed this way.',
      'ORDER_RECONFIRM_NOT_ALLOWED',
    );
  }
  if (order.awaitingPayment === true) {
    throw cancellationError(
      'An order awaiting payment cannot be reconfirmed through the COD workflow.',
      'ORDER_PAYMENT_NOT_CONFIRMED',
    );
  }
  if (order.isPaid) {
    throw cancellationError('Paid orders cannot be reconfirmed.', 'ORDER_RECONFIRM_NOT_ALLOWED');
  }
  if (order.orderStatus !== 'cancelled') {
    return { order, alreadyConfirmed: true };
  }

  if (!order.inventoryCommitted) {
    await commitOrderInventory(order._id, {
      session: transactionSession,
      allowCancelled: true,
    });
    order.inventoryCommitted = true;
  }

  // Cancellation returns limited coupon capacity to the pool. Re-acquire and
  // validate that capacity inside this transaction before consuming it again;
  // if the coupon changed or another buyer used the final slot, inventory and
  // every order mutation roll back together.
  await reactivateReleasedOrderCouponsInSession(order, transactionSession, at);
  const couponResult = await consumeOrderCoupons({
    orderId: order._id,
    session: transactionSession,
    at,
  });
  if ((order.appliedCoupons || []).length && couponResult?.legacy) {
    order.couponUsageVersion = COUPON_USAGE_VERSION;
  }
  order.orderStatus = 'confirmed';
  setAllSellerFulfillmentStatus(order, 'confirmed', at);
  if (order.sellerFulfillment?.length) syncAggregateDeliveryState(order);
  order.orderStatus = 'confirmed';
  applyConfirmationFields(order, confirmationFields);
  await order.save({ session: transactionSession });
  for (const sellerId of notificationSellerIds(order)) {
    await enqueueCodOrderDecisionSellerNotifications(order, sellerId, {
      decision: 'reconfirmed',
      transitionAt: order.confirmation?.confirmedAt || at,
      session: transactionSession,
    });
  }
  return { order, alreadyConfirmed: false };
}, session);

module.exports = {
  cancellationError,
  cancelOrderSafely,
  cancelUnpaidOrderLocally,
  reconfirmCancelledCodOrder,
};
