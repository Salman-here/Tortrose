'use strict';

const Order = require('../models/Order');
const WalletTransaction = require('../models/WalletTransaction');
const { stripe } = require('../config/stripe');
const { restoreOrderInventory } = require('./orderInventoryService');
const { validateStripeOrderPaymentIntent } = require('./stripeOrderPaymentService');
const {
  cancelWalletTopUpFromPaymentIntent,
  validateWalletTopUpPaymentIntent,
} = require('./walletService');

const DEFAULT_TTL_MINUTES = 30;
const MIN_TTL_MINUTES = 10;
const MAX_TTL_MINUTES = 24 * 60;

const paymentIntentTtlMinutes = () => {
  const configured = Number(process.env.STRIPE_PAYMENT_INTENT_TTL_MINUTES || DEFAULT_TTL_MINUTES);
  if (!Number.isFinite(configured)) return DEFAULT_TTL_MINUTES;
  return Math.min(MAX_TTL_MINUTES, Math.max(MIN_TTL_MINUTES, Math.round(configured)));
};

const createPaymentExpiry = (now = new Date()) => new Date(
  now.getTime() + paymentIntentTtlMinutes() * 60 * 1000
);

const retrieveAndCancel = async (paymentIntentId) => {
  let intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (intent.status === 'succeeded') return { intent, captured: true };
  if (intent.status === 'canceled') return { intent, cancelled: true };
  try {
    intent = await stripe.paymentIntents.cancel(paymentIntentId, {
      cancellation_reason: 'abandoned',
    });
  } catch (error) {
    // A success/cancel can win the race between retrieve and cancel.
    intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (!['succeeded', 'canceled'].includes(intent.status)) throw error;
  }
  return {
    intent,
    captured: intent.status === 'succeeded',
    cancelled: intent.status === 'canceled',
  };
};

const closeOrderPaymentIntent = async (
  order,
  { status = 'cancelled', reason = 'Payment was cancelled by the buyer.', requireExpired = false, now = new Date() } = {},
) => {
  if (!order || order.paymentFlow !== 'payment_sheet' || !order.stripePaymentIntentId) return null;
  if (order.isPaid || !order.awaitingPayment) return { status: 'already_closed', order };
  if (requireExpired && (!order.paymentExpiresAt || order.paymentExpiresAt > now)) {
    return { status: 'not_expired', order };
  }
  if (order.paymentProcessingStartedAt) return { status: 'fulfillment_in_progress', order };

  const result = await retrieveAndCancel(order.stripePaymentIntentId);
  validateStripeOrderPaymentIntent(order, result.intent);
  if (result.captured) return { status: 'payment_succeeded', order, paymentIntent: result.intent };
  if (!result.cancelled) return { status: 'cancel_pending', order, paymentIntent: result.intent };

  await restoreOrderInventory(order._id);
  const closed = await Order.findOneAndUpdate(
    {
      _id: order._id,
      isPaid: false,
      awaitingPayment: true,
      stripePaymentIntentId: result.intent.id,
    },
    {
      $set: {
        orderStatus: 'cancelled',
        paymentCancelledAt: now,
        paymentProcessingStartedAt: null,
        'paymentResult.failureCode': status === 'expired' ? 'PAYMENT_EXPIRED' : 'PAYMENT_CANCELLED',
        'paymentResult.failureMessage': String(reason).slice(0, 500),
        'paymentResult.failureAt': now,
      },
    },
    { new: true },
  );
  return { status, order: closed || order, paymentIntent: result.intent };
};

const closeWalletTopUpPaymentIntent = async (
  transaction,
  { status = 'cancelled', reason = 'Payment was cancelled by the buyer.', requireExpired = false, now = new Date() } = {},
) => {
  if (!transaction || transaction.paymentFlow !== 'payment_sheet' || !transaction.stripePaymentIntentId) return null;
  if (transaction.status !== 'pending') return { status: 'already_closed', transaction };
  if (requireExpired && (!transaction.paymentExpiresAt || transaction.paymentExpiresAt > now)) {
    return { status: 'not_expired', transaction };
  }
  const result = await retrieveAndCancel(transaction.stripePaymentIntentId);
  validateWalletTopUpPaymentIntent(transaction, result.intent);
  if (result.captured) return { status: 'payment_succeeded', transaction, paymentIntent: result.intent };
  if (!result.cancelled) return { status: 'cancel_pending', transaction, paymentIntent: result.intent };
  const closed = await cancelWalletTopUpFromPaymentIntent(result.intent, { status, reason });
  return { status, transaction: closed || transaction, paymentIntent: result.intent };
};

const cleanupStaleStripePaymentIntents = async ({ now = new Date(), limit = 50 } = {}) => {
  if (!stripe) return { orders: 0, walletTopUps: 0, skipped: true };
  const boundedLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const [orders, walletTopUps] = await Promise.all([
    Order.find({
      paymentMethod: 'stripe',
      isPaid: false,
      awaitingPayment: true,
      orderStatus: { $ne: 'cancelled' },
      paymentExpiresAt: { $lte: now },
      $or: [
        { paymentFlow: 'payment_sheet' },
        {
          paymentFlow: 'checkout_session',
          $or: [
            { stripeSessionId: null },
            { stripeSessionId: '' },
            { stripeSessionId: { $exists: false } },
          ],
        },
      ],
    }).limit(boundedLimit),
    WalletTransaction.find({
      type: 'top_up',
      status: 'pending',
      paymentExpiresAt: { $lte: now },
      $or: [
        { paymentFlow: 'payment_sheet' },
        {
          paymentFlow: 'checkout_session',
          $or: [
            { stripeSessionId: null },
            { stripeSessionId: '' },
            { stripeSessionId: { $exists: false } },
          ],
        },
      ],
    }).limit(boundedLimit),
  ]);

  let expiredOrders = 0;
  let expiredTopUps = 0;
  for (const order of orders) {
    try {
      if (order.paymentFlow !== 'payment_sheet' || !order.stripePaymentIntentId) {
        if (order.inventoryCommitted) await restoreOrderInventory(order._id);
        await Order.deleteOne({ _id: order._id, isPaid: false, awaitingPayment: true });
        expiredOrders += 1;
        continue;
      }
      const result = await closeOrderPaymentIntent(order, {
        status: 'expired',
        reason: 'The secure mobile payment window expired.',
        requireExpired: true,
        now,
      });
      if (result?.status === 'expired') expiredOrders += 1;
    } catch (error) {
      console.error(`[stripe-cleanup] order ${order.orderId}:`, error.message);
    }
  }
  for (const transaction of walletTopUps) {
    try {
      if (transaction.paymentFlow !== 'payment_sheet' || !transaction.stripePaymentIntentId) {
        const updated = await WalletTransaction.updateOne(
          { _id: transaction._id, status: 'pending' },
          {
            $set: {
              status: 'expired',
              failureReason: 'The secure mobile Wallet top-up window expired.',
            },
          },
        );
        if (updated.modifiedCount === 1) expiredTopUps += 1;
        continue;
      }
      const result = await closeWalletTopUpPaymentIntent(transaction, {
        status: 'expired',
        reason: 'The secure mobile Wallet top-up window expired.',
        requireExpired: true,
        now,
      });
      if (result?.status === 'expired') expiredTopUps += 1;
    } catch (error) {
      console.error(`[stripe-cleanup] Wallet top-up ${transaction._id}:`, error.message);
    }
  }
  return { orders: expiredOrders, walletTopUps: expiredTopUps, skipped: false };
};

module.exports = {
  paymentIntentTtlMinutes,
  createPaymentExpiry,
  closeOrderPaymentIntent,
  closeWalletTopUpPaymentIntent,
  cleanupStaleStripePaymentIntents,
};
