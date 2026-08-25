'use strict';

const Order = require('../models/Order');
const WalletTransaction = require('../models/WalletTransaction');
const { stripe } = require('../config/stripe');
const {
  attachStripeOrderReference,
  fulfillStripeOrder,
  fulfillStripeOrderPaymentIntent,
  validateStripeOrderPaymentIntent,
  validateStripeOrderSession,
} = require('./stripeOrderPaymentService');
const {
  createHostedOrderCheckoutSession,
  createNativeOrderPaymentIntent,
} = require('./stripeOrderSetupService');
const {
  isAuthoritativeStripeIdempotentReplayRejection,
  isStripeIdempotentReplayWithinAuthorityWindow,
} = require('./stripePaymentIntentFactory');
const {
  deleteUnpaidOrderAndReleaseCoupons,
} = require('./couponUsageService');
const { cancelUnpaidOrderLocally } = require('./orderCancellationService');
const {
  cancelWalletTopUpFromPaymentIntent,
  closeWalletTopUpWithoutStripeReference,
  completeWalletTopUp,
  completeWalletTopUpFromPaymentIntent,
  failWalletTopUp,
  recoverWalletTopUpStripeSetup,
  validateWalletTopUpCheckoutSession,
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

  const local = await cancelUnpaidOrderLocally({
    orderId: order._id,
    reason,
    externalPaymentClosed: true,
    at: now,
    confirmationFields: {},
    cancellationActorRole: 'system',
    paymentFailure: {
      code: status === 'expired' ? 'PAYMENT_EXPIRED' : 'PAYMENT_CANCELLED',
      message: reason,
      at: now,
    },
  });
  return { status, order: local.order, paymentIntent: result.intent };
};

const closeWalletTopUpPaymentIntent = async (
  transaction,
  { status = 'cancelled', reason = 'Payment was cancelled by the buyer.', requireExpired = false, now = new Date() } = {},
) => {
  if (!transaction || transaction.paymentFlow !== 'payment_sheet') return null;
  let current = transaction;
  if (current.status !== 'pending') return { status: 'already_closed', transaction: current };
  if (requireExpired && (!current.paymentExpiresAt || current.paymentExpiresAt > now)) {
    return { status: 'not_expired', transaction: current };
  }
  if (!current.stripePaymentIntentId) {
    const local = await closeWalletTopUpWithoutStripeReference(current, {
      status,
      reason,
      requireExpired,
      now,
    });
    if (local?.status !== 'reference_attached') return local;
    current = local.transaction;
  }
  const result = await retrieveAndCancel(current.stripePaymentIntentId);
  validateWalletTopUpPaymentIntent(current, result.intent);
  if (result.captured) return { status: 'payment_succeeded', transaction: current, paymentIntent: result.intent };
  if (!result.cancelled) return { status: 'cancel_pending', transaction: current, paymentIntent: result.intent };
  const closed = await cancelWalletTopUpFromPaymentIntent(result.intent, { status, reason });
  return { status, transaction: closed || current, paymentIntent: result.intent };
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
    }).sort({ paymentExpiresAt: 1 }).limit(boundedLimit),
    WalletTransaction.find({
      type: 'top_up',
      status: 'pending',
      paymentExpiresAt: { $lte: now },
    }).limit(boundedLimit),
  ]);

  let expiredOrders = 0;
  let expiredTopUps = 0;
  for (const pendingOrder of orders) {
    let order = pendingOrder;
    try {
      if (
        !order.stripePaymentIntentId
        && !order.stripeSessionId
        && order.paymentSetupState === 'creating'
        && ['payment_sheet', 'checkout_session'].includes(order.paymentFlow)
      ) {
        try {
          if (!isStripeIdempotentReplayWithinAuthorityWindow({
            createdAt: order.paymentSetupStartedAt,
            now,
          })) {
            const recoveryError = new Error(
              'The Stripe setup is too old for safe automatic replay and requires provider reconciliation.',
            );
            recoveryError.code = 'PAYMENT_SETUP_RECOVERY_REQUIRED';
            throw recoveryError;
          }
          const stripeObject = order.paymentFlow === 'payment_sheet'
            ? await createNativeOrderPaymentIntent(order)
            : await createHostedOrderCheckoutSession(order);
          order = await attachStripeOrderReference({
            order,
            stripeObject,
            paymentFlow: order.paymentFlow,
          });
        } catch (creationError) {
          if (!isAuthoritativeStripeIdempotentReplayRejection(creationError, {
            createdAt: order.paymentSetupStartedAt,
            now,
          })) throw creationError;
          // Within Stripe's guaranteed idempotency-result retention window, an
          // InvalidRequest response to the exact same request proves there is
          // no cached earlier execution. Every other error stays fail-closed.
          const deletion = await deleteUnpaidOrderAndReleaseCoupons({
            orderId: order._id,
            requireAwaitingPayment: true,
            reason: 'Stripe definitively rejected recovery of the payment setup.',
            match: {
              orderStatus: { $ne: 'cancelled' },
              paymentSetupState: 'creating',
              stripePaymentIntentId: null,
              stripeSessionId: null,
            },
          });
          if (deletion.deleted) expiredOrders += 1;
          continue;
        }
      }

      if (order.paymentFlow === 'checkout_session' && order.stripeSessionId) {
        let checkoutSession = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
        validateStripeOrderSession(order, checkoutSession);

        if (checkoutSession.payment_status === 'paid') {
          await fulfillStripeOrder({
            order,
            stripeSession: checkoutSession,
            eventId: `scheduled-recovery:${checkoutSession.id}`,
          });
          continue;
        }

        if (checkoutSession.status === 'open') {
          try {
            checkoutSession = await stripe.checkout.sessions.expire(checkoutSession.id);
          } catch (expireError) {
            // Payment completion can win the race with expiration. Re-read the
            // authoritative state before deciding whether local reservations
            // may be released.
            checkoutSession = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
            if (
              checkoutSession.payment_status !== 'paid'
              && checkoutSession.status !== 'expired'
              && !(checkoutSession.status === 'complete' && checkoutSession.payment_status !== 'paid')
            ) throw expireError;
          }
          validateStripeOrderSession(order, checkoutSession);
        }

        if (checkoutSession.payment_status === 'paid') {
          await fulfillStripeOrder({
            order,
            stripeSession: checkoutSession,
            eventId: `scheduled-recovery:${checkoutSession.id}`,
          });
          continue;
        }
        if (
          checkoutSession.status !== 'expired'
          && !(checkoutSession.status === 'complete' && checkoutSession.payment_status !== 'paid')
        ) {
          throw new Error(`Hosted checkout ${checkoutSession.id} is not safely closed.`);
        }

        const deletion = await deleteUnpaidOrderAndReleaseCoupons({
          orderId: order._id,
          requireAwaitingPayment: true,
          reason: 'The secure card-payment window expired.',
        });
        if (deletion.deleted) expiredOrders += 1;
        continue;
      }

      if (!order.stripePaymentIntentId && !order.stripeSessionId) {
        // `creating` means Stripe may already have accepted the deterministic
        // request while the ID failed to persist. Deleting locally here could
        // orphan a live Stripe object, so only a setup that durably never
        // started (or was already closed) may be removed without recovery.
        if (!['not_started', 'closed'].includes(order.paymentSetupState)) {
          console.error(
            `Skipping unsafe cleanup for Stripe order ${order.orderId}: payment setup state is ${order.paymentSetupState || 'unknown'}.`,
          );
          continue;
        }
        const deletion = await deleteUnpaidOrderAndReleaseCoupons({
          orderId: order._id,
          requireAwaitingPayment: true,
          reason: 'The secure card-payment window expired.',
        });
        if (deletion.deleted) expiredOrders += 1;
        continue;
      }
      if (order.paymentFlow !== 'payment_sheet' || !order.stripePaymentIntentId) {
        console.error(
          `Skipping unsafe cleanup for Stripe order ${order.orderId}: external payment reference does not match its flow.`,
        );
        continue;
      }
      const result = await closeOrderPaymentIntent(order, {
        status: 'expired',
        reason: 'The secure mobile payment window expired.',
        requireExpired: true,
        now,
      });
      if (result?.status === 'payment_succeeded') {
        await fulfillStripeOrderPaymentIntent({
          order,
          paymentIntent: result.paymentIntent,
          eventId: `scheduled-recovery:${result.paymentIntent.id}`,
        });
      } else if (result?.status === 'expired') {
        expiredOrders += 1;
      }
    } catch (error) {
      console.error(`[stripe-cleanup] order ${order.orderId}:`, error.message);
    }
  }
  for (const pendingTransaction of walletTopUps) {
    let transaction = pendingTransaction;
    try {
      if (
        !transaction.stripePaymentIntentId
        && !transaction.stripeSessionId
        && transaction.paymentSetupState === 'creating'
      ) {
        try {
          const recovered = await recoverWalletTopUpStripeSetup(transaction);
          transaction = recovered.transaction;
        } catch (creationError) {
          if (!creationError.walletSetupDefinitivelyRejected) throw creationError;
          // The wallet setup service atomically closes a definitively rejected
          // deterministic request. No external object exists in this case.
          expiredTopUps += 1;
          continue;
        }
      }

      if (!transaction.stripePaymentIntentId && !transaction.stripeSessionId) {
        const local = await closeWalletTopUpWithoutStripeReference(transaction, {
          status: 'expired',
          reason: 'The secure Wallet top-up window expired.',
          requireExpired: true,
          now,
        });
        if (local?.status === 'expired') expiredTopUps += 1;
        if (['setup_recovery_pending', 'unsafe_without_reference'].includes(local?.status)) {
          console.error(
            `[stripe-cleanup] Wallet top-up ${transaction._id}: unsafe no-reference setup state ${transaction.paymentSetupState || 'unknown'}.`,
          );
        }
        continue;
      }

      if (transaction.paymentFlow === 'checkout_session' && transaction.stripeSessionId) {
        let checkoutSession = await stripe.checkout.sessions.retrieve(transaction.stripeSessionId);
        validateWalletTopUpCheckoutSession(transaction, checkoutSession);
        if (checkoutSession.payment_status === 'paid') {
          await completeWalletTopUp(checkoutSession, `scheduled-recovery:${checkoutSession.id}`);
          continue;
        }
        if (checkoutSession.status === 'open') {
          try {
            checkoutSession = await stripe.checkout.sessions.expire(checkoutSession.id);
          } catch (expireError) {
            checkoutSession = await stripe.checkout.sessions.retrieve(transaction.stripeSessionId);
            if (
              checkoutSession.payment_status !== 'paid'
              && checkoutSession.status !== 'expired'
              && !(checkoutSession.status === 'complete' && checkoutSession.payment_status !== 'paid')
            ) throw expireError;
          }
          validateWalletTopUpCheckoutSession(transaction, checkoutSession);
        }
        if (checkoutSession.payment_status === 'paid') {
          await completeWalletTopUp(checkoutSession, `scheduled-recovery:${checkoutSession.id}`);
          continue;
        }
        if (
          checkoutSession.status !== 'expired'
          && !(checkoutSession.status === 'complete' && checkoutSession.payment_status !== 'paid')
        ) {
          throw new Error(`Hosted Wallet checkout ${checkoutSession.id} is not safely closed.`);
        }
        const closed = await failWalletTopUp(
          checkoutSession,
          'The secure hosted Wallet top-up window expired.',
          `scheduled-recovery:${checkoutSession.id}`,
        );
        if (closed) expiredTopUps += 1;
        continue;
      }

      if (transaction.paymentFlow !== 'payment_sheet' || !transaction.stripePaymentIntentId) {
        console.error(
          `[stripe-cleanup] Wallet top-up ${transaction._id}: external payment reference does not match its flow.`,
        );
        continue;
      }
      const result = await closeWalletTopUpPaymentIntent(transaction, {
        status: 'expired',
        reason: 'The secure mobile Wallet top-up window expired.',
        requireExpired: true,
        now,
      });
      if (result?.status === 'payment_succeeded') {
        await completeWalletTopUpFromPaymentIntent(
          result.paymentIntent,
          `scheduled-recovery:${result.paymentIntent.id}`,
        );
      } else if (result?.status === 'expired') {
        expiredTopUps += 1;
      }
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
