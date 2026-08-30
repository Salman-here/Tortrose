'use strict';

const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const {
  sellerFulfillmentFor,
  setAllSellerFulfillmentStatus,
  setSellerFulfillmentStatus,
  syncAggregateDeliveryState,
} = require('./orderFulfillmentService');
const { commitOrderInventory } = require('./orderInventoryService');
const { reconfirmCancelledCodOrder } = require('./orderCancellationService');
const {
  COUPON_USAGE_VERSION,
  consumeOrderCoupons,
} = require('./couponUsageService');
const {
  enqueueCodOrderDecisionSellerNotifications,
  enqueueOrderLifecycleBuyerNotifications,
  enqueueOrderSellerFulfillmentBuyerNotifications,
} = require('./financialNotificationOutboxService');

const STATUS_RANK = Object.freeze({
  pending: 0,
  confirmed: 1,
  processing: 2,
  shipped: 3,
  delivered: 4,
});

const toId = value => value?._id?.toString?.() || value?.toString?.() || '';

const transitionError = (message, code, currentStatus, statusCode = 409) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.currentStatus = currentStatus;
  return error;
};

const confirmationFields = (channel, at) => ({
  confirmedAt: at,
  confirmedVia: channel,
  declinedAt: null,
  decidedAt: at,
  decidedVia: channel,
  cancelledFromDashboardAt: null,
  cancelledFromDashboardNote: '',
});

const applyConfirmationFields = (order, fields) => {
  order.confirmation = order.confirmation || {};
  for (const [field, value] of Object.entries(fields)) {
    order.set(`confirmation.${field}`, value);
  }
};

const currentConfirmationOutcome = order => {
  if (order.orderStatus === 'cancelled' && order.confirmation?.declinedAt) {
    return 'already_declined';
  }
  if (order.confirmation?.confirmedAt) return 'already_confirmed';
  if (order.confirmation?.declinedAt) return 'already_declined';
  return null;
};

const ensureSellerFulfillmentEntries = (order, sellerIds, at) => {
  order.sellerFulfillment = order.sellerFulfillment || [];
  for (const sellerId of [...new Set((sellerIds || []).map(toId).filter(Boolean))]) {
    if (sellerFulfillmentFor(order, sellerId)) continue;
    order.sellerFulfillment.push({
      seller: sellerId,
      status: order.orderStatus || 'pending',
      deliveredAt: order.orderStatus === 'delivered'
        ? (order.deliveredAt || order.updatedAt || at)
        : null,
      updatedAt: at,
    });
  }
};

const resolveOrderSellerIds = async (order, session) => {
  const sellerIds = new Set();
  const missingProductIds = [];

  for (const item of order.orderItems || []) {
    const sellerId = toId(item.seller);
    if (sellerId) sellerIds.add(sellerId);
    else if (item.productId) missingProductIds.push(item.productId);
  }

  if (missingProductIds.length) {
    const products = await Product.find({ _id: { $in: missingProductIds } })
      .select('seller')
      .session(session)
      .lean();
    for (const product of products) {
      const sellerId = toId(product.seller);
      if (sellerId) sellerIds.add(sellerId);
    }
  }

  // Seller-fulfillment rows are derived state, not ownership evidence. Use
  // them only as a last-resort legacy fallback when neither an item snapshot
  // nor a still-existing product can identify any seller.
  if (!sellerIds.size) {
    for (const fulfillment of order.sellerFulfillment || []) {
      const sellerId = toId(fulfillment.seller);
      if (sellerId) sellerIds.add(sellerId);
    }
  }

  return [...sellerIds];
};

/**
 * Move fulfillment forward in one MongoDB transaction.
 *
 * Cancellation deliberately is not supported here: it owns inventory, coupon
 * and external-payment boundaries and must go through orderCancellationService.
 * Transaction retry re-reads current state, so a concurrent cancellation or a
 * later fulfillment update cannot be overwritten by a stale document save.
 */
const transitionOrderFulfillment = async ({
  orderId,
  actorRole,
  actorId = null,
  newStatus,
  at = new Date(),
}) => {
  if (!['seller', 'admin'].includes(actorRole)) {
    throw transitionError('Only sellers and admins can update order status.', 'ORDER_STATUS_FORBIDDEN', null, 403);
  }
  if (!Object.prototype.hasOwnProperty.call(STATUS_RANK, newStatus)) {
    throw transitionError(
      newStatus === 'cancelled'
        ? 'Cancellation must use the safe cancellation workflow.'
        : 'Choose a valid forward order status.',
      newStatus === 'cancelled' ? 'ORDER_CANCELLATION_REQUIRES_SAFE_PATH' : 'ORDER_STATUS_INVALID',
      null,
      400,
    );
  }

  let transitionedOrder;
  let transition;
  await mongoose.connection.transaction(async session => {
    const order = await Order.findById(orderId).session(session);
    if (!order) {
      throw transitionError('Order not found.', 'ORDER_NOT_FOUND', null, 404);
    }

    // Seller ownership is resolved from the immutable order snapshot (with a
    // live-product fallback only for legacy rows). Do not trust caller hints
    // as authorization for a financial/fulfillment state transition.
    const authoritativeSellerIds = await resolveOrderSellerIds(order, session);
    ensureSellerFulfillmentEntries(order, authoritativeSellerIds, at);
    const previousSellerStatuses = new Map(
      order.sellerFulfillment.map(entry => [toId(entry.seller), entry.status]),
    );
    const sellerFulfillment = actorRole === 'seller'
      ? sellerFulfillmentFor(order, actorId)
      : null;
    if (
      actorRole === 'seller'
      && (
        !authoritativeSellerIds.includes(toId(actorId))
        || !sellerFulfillment
      )
    ) {
      throw transitionError(
        'Seller fulfillment record was not found for this order.',
        'SELLER_FULFILLMENT_NOT_FOUND',
        order.orderStatus,
        403,
      );
    }

    const actorCurrentStatus = actorRole === 'seller'
      ? sellerFulfillment.status
      : order.orderStatus;
    const previousAggregateStatus = order.orderStatus;
    const currentStatuses = actorRole === 'seller'
      ? [order.orderStatus, sellerFulfillment.status]
      : order.sellerFulfillment.length
        ? [order.orderStatus, ...order.sellerFulfillment.map(entry => entry.status)]
        : [order.orderStatus];
    const invalidCurrentStatus = order.orderStatus === 'cancelled'
      ? 'cancelled'
      : currentStatuses.find(status => (
        status === 'cancelled'
        || !Object.prototype.hasOwnProperty.call(STATUS_RANK, status)
        || STATUS_RANK[newStatus] < STATUS_RANK[status]
      ));
    if (invalidCurrentStatus) {
      throw transitionError(
        `Order status cannot move from ${invalidCurrentStatus} to ${newStatus}.`,
        'ORDER_STATUS_TRANSITION_INVALID',
        actorCurrentStatus,
      );
    }
    if (
      order.awaitingPayment === true
      || (order.paymentMethod !== 'cash_on_delivery' && order.isPaid !== true)
    ) {
      throw transitionError(
        'Payment must be confirmed before this order can enter fulfillment.',
        'ORDER_PAYMENT_NOT_CONFIRMED',
        actorCurrentStatus,
      );
    }
    if (order.inventoryCommitted !== true) {
      throw transitionError(
        'Inventory must be reserved before this order can enter fulfillment.',
        'ORDER_INVENTORY_NOT_COMMITTED',
        actorCurrentStatus,
      );
    }

    if (actorRole === 'seller') {
      setSellerFulfillmentStatus(order, actorId, newStatus, at);
    } else if (order.sellerFulfillment.length) {
      setAllSellerFulfillmentStatus(order, newStatus, at);
    }

    const buyerAlreadyDecided = !!(
      order.confirmation?.confirmedAt
      || order.confirmation?.declinedAt
    );
    const updatesWholeOrderDecision = actorRole === 'admin'
      || authoritativeSellerIds.length <= 1;
    if (updatesWholeOrderDecision && newStatus === 'confirmed' && !buyerAlreadyDecided) {
      order.confirmation = order.confirmation || {};
      order.confirmation.confirmedAt = at;
      order.confirmation.confirmedVia = actorRole === 'admin' ? 'admin' : 'manual';
      order.confirmation.decidedAt = at;
      order.confirmation.decidedVia = actorRole === 'admin' ? 'admin' : 'manual';
    }

    if (actorRole === 'admin' && !order.sellerFulfillment.length) {
      order.orderStatus = newStatus;
      order.isDelivered = newStatus === 'delivered';
      if (newStatus === 'delivered' && !order.deliveredAt) order.deliveredAt = at;
    } else {
      syncAggregateDeliveryState(order);
    }

    // Delivery recognizes payment only for COD. Stripe and Wallet orders are
    // required to be paid before fulfillment and can never manufacture a paid
    // state through a status update.
    if (order.orderStatus === 'delivered' && order.paymentMethod === 'cash_on_delivery') {
      order.isPaid = true;
      order.paidAt = order.paidAt || order.deliveredAt || at;
    }

    await order.save({ session });
    transitionedOrder = order;
    const persistedActorStatus = actorRole === 'seller'
      ? sellerFulfillmentFor(order, actorId)?.status
      : order.orderStatus;
    const sellerTransitions = order.sellerFulfillment
      .map(entry => ({
        sellerId: toId(entry.seller),
        previousStatus: previousSellerStatuses.get(toId(entry.seller)),
        status: entry.status,
      }))
      .filter(entry => entry.previousStatus && entry.previousStatus !== entry.status);
    transition = {
      actorStatusChanged: persistedActorStatus !== actorCurrentStatus || sellerTransitions.length > 0,
      aggregateStatusChanged: order.orderStatus !== previousAggregateStatus,
      previousActorStatus: actorCurrentStatus,
      currentActorStatus: persistedActorStatus,
      previousAggregateStatus,
      currentAggregateStatus: order.orderStatus,
      sellerTransitions,
    };
    if (sellerTransitions.length) {
      for (const sellerTransition of sellerTransitions) {
        await enqueueOrderSellerFulfillmentBuyerNotifications(order, {
          ...sellerTransition,
          transitionAt: at,
          actorRole,
          session,
        });
      }
    } else if (transition.aggregateStatusChanged) {
      await enqueueOrderLifecycleBuyerNotifications(order, {
        status: transition.currentAggregateStatus,
        previousStatus: transition.previousAggregateStatus,
        transitionAt: at,
        actorRole,
        session,
      });
    }
  }, {
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
  });

  return { order: transitionedOrder, transition };
};

/**
 * Persist the buyer's first COD confirmation together with fulfillment state.
 *
 * Email and WhatsApp used to update confirmation/orderStatus first and then
 * save seller fulfillment from a stale document. A concurrent cancellation
 * could restore stock and then be overwritten by that second save. Keeping the
 * decision, stock reservation, and fulfillment mutation in one transaction
 * means every retry re-reads the cancellation winner before doing anything.
 *
 * Manual/admin decisions may be explicitly overridden by WhatsApp to preserve
 * the existing buyer-precedence rule. If that earlier decision cancelled the
 * order, reopening is delegated to the dedicated COD reconfirmation path so
 * inventory is reserved again before the order becomes active.
 */
const confirmCodOrderByBuyer = async ({
  orderId,
  token = null,
  channel,
  allowedExistingDecisionChannels = [],
  at = new Date(),
}) => {
  if (!['email', 'whatsapp'].includes(channel)) {
    throw transitionError(
      'Choose a valid buyer confirmation channel.',
      'ORDER_CONFIRMATION_CHANNEL_INVALID',
      null,
      400,
    );
  }

  const allowedChannels = new Set(allowedExistingDecisionChannels || []);
  let result;
  await mongoose.connection.transaction(async session => {
    const query = { _id: orderId };
    if (token) query['confirmation.token'] = token;
    const order = await Order.findOne(query).session(session);
    if (!order) {
      throw transitionError('Order not found.', 'ORDER_NOT_FOUND', null, 404);
    }
    if (order.paymentMethod !== 'cash_on_delivery') {
      throw transitionError(
        'Only cash-on-delivery orders require buyer confirmation.',
        'ORDER_CONFIRMATION_NOT_REQUIRED',
        order.orderStatus,
      );
    }
    if (order.awaitingPayment === true) {
      throw transitionError(
        'Payment must be completed before this order can be confirmed.',
        'ORDER_PAYMENT_NOT_CONFIRMED',
        order.orderStatus,
      );
    }
    const tokenExpiresAt = token && order.confirmation?.tokenExpiresAt
      ? new Date(order.confirmation.tokenExpiresAt).getTime()
      : null;
    if (
      tokenExpiresAt !== null
      && (!Number.isFinite(tokenExpiresAt) || tokenExpiresAt <= at.getTime())
    ) {
      throw transitionError(
        'Confirmation link expired.',
        'ORDER_CONFIRMATION_EXPIRED',
        order.orderStatus,
        410,
      );
    }

    const decidedVia = order.confirmation?.decidedVia
      || order.confirmation?.confirmedVia
      || null;
    const existingOutcome = currentConfirmationOutcome(order);
    const canOverrideExistingDecision = Boolean(
      decidedVia && allowedChannels.has(decidedVia),
    );
    if (existingOutcome && !canOverrideExistingDecision) {
      result = {
        status: existingOutcome,
        order,
        newlyConfirmed: false,
      };
      return;
    }
    if (order.confirmation?.decidedAt && !canOverrideExistingDecision) {
      result = {
        status: 'already_decided',
        order,
        newlyConfirmed: false,
      };
      return;
    }

    const authoritativeSellerIds = await resolveOrderSellerIds(order, session);
    const fields = confirmationFields(channel, at);
    if (order.orderStatus === 'cancelled') {
      // A dashboard/buyer cancellation is terminal here. Only the explicitly
      // allowed legacy manual/admin decision may be overridden by this first
      // WhatsApp confirmation.
      if (!canOverrideExistingDecision) {
        result = {
          status: existingOutcome || 'order_cancelled',
          order,
          newlyConfirmed: false,
        };
        return;
      }
      const reconfirmed = await reconfirmCancelledCodOrder({
        orderId: order._id,
        confirmationFields: fields,
        at,
        session,
      });
      const reopenedOrder = reconfirmed.order;
      ensureSellerFulfillmentEntries(reopenedOrder, authoritativeSellerIds, at);
      if (reopenedOrder.sellerFulfillment.length) {
        setAllSellerFulfillmentStatus(reopenedOrder, 'confirmed', at);
        syncAggregateDeliveryState(reopenedOrder);
      }
      reopenedOrder.orderStatus = 'confirmed';
      await reopenedOrder.save({ session });
      result = {
        status: 'confirmed',
        order: reopenedOrder,
        newlyConfirmed: !reconfirmed.alreadyConfirmed,
        reconfirmed: true,
      };
      return;
    }

    ensureSellerFulfillmentEntries(order, authoritativeSellerIds, at);
    const statuses = [
      order.orderStatus,
      ...(order.sellerFulfillment || []).map(entry => entry.status),
    ];
    const cancelledStatus = statuses.find(status => status === 'cancelled');
    if (cancelledStatus) {
      result = {
        status: 'order_cancelled',
        order,
        newlyConfirmed: false,
      };
      return;
    }
    const fulfillmentStarted = statuses.find(status => (
      Object.prototype.hasOwnProperty.call(STATUS_RANK, status)
      && STATUS_RANK[status] > STATUS_RANK.confirmed
    ));
    if (fulfillmentStarted) {
      result = {
        status: 'fulfillment_started',
        order,
        newlyConfirmed: false,
      };
      return;
    }
    const invalidStatus = statuses.find(status => (
      !Object.prototype.hasOwnProperty.call(STATUS_RANK, status)
    ));
    if (invalidStatus) {
      throw transitionError(
        `Order status ${invalidStatus} cannot be buyer-confirmed.`,
        'ORDER_STATUS_TRANSITION_INVALID',
        order.orderStatus,
      );
    }

    // COD inventory is normally committed atomically at placement. This guard
    // also repairs a legacy/uncommitted row safely, or fails if stock changed,
    // instead of activating an order with no inventory reservation.
    if (!order.inventoryCommitted) {
      await commitOrderInventory(order._id, { session });
      order.inventoryCommitted = true;
    }
    const couponResult = await consumeOrderCoupons({
      orderId: order._id,
      session,
      at,
    });
    if ((order.appliedCoupons || []).length && couponResult?.legacy) {
      order.couponUsageVersion = COUPON_USAGE_VERSION;
    }

    for (const fulfillment of order.sellerFulfillment || []) {
      if (fulfillment.status === 'pending') {
        fulfillment.status = 'confirmed';
        fulfillment.updatedAt = at;
      }
    }
    if (order.sellerFulfillment.length) {
      syncAggregateDeliveryState(order);
    } else if (order.orderStatus === 'pending') {
      order.orderStatus = 'confirmed';
    }
    applyConfirmationFields(order, fields);
    await order.save({ session });
    for (const sellerId of authoritativeSellerIds) {
      await enqueueCodOrderDecisionSellerNotifications(order, sellerId, {
        decision: 'confirmed',
        transitionAt: order.confirmation?.confirmedAt || at,
        session,
      });
    }
    result = {
      status: 'confirmed',
      order,
      newlyConfirmed: true,
      reconfirmed: false,
    };
  }, {
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
  });

  return result;
};

module.exports = {
  STATUS_RANK,
  confirmCodOrderByBuyer,
  transitionError,
  transitionOrderFulfillment,
};
