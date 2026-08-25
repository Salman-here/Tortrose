'use strict';

const Order = require('../models/Order');
const ReturnRequest = require('../models/ReturnRequest');
const WalletTransaction = require('../models/WalletTransaction');
const {
  resolveStripeOrderForPaymentIntentRoute,
} = require('./stripeOrderLookupService');

/** Hosted Checkout owns its lifecycle through checkout.session.* events. Its
 * underlying PaymentIntent carries copied ownership metadata for reversals,
 * but payment_intent lifecycle events must never enter PaymentSheet handlers. */
const isHostedCheckoutPaymentIntent = paymentIntent => {
  const metadata = paymentIntent?.metadata || {};
  const type = String(metadata.type || '').trim();
  if (metadata.paymentFlow === 'checkout_session') {
    return ['wallet_top_up', 'order_payment'].includes(type);
  }
  // Return settlement card funding is hosted-only and predates paymentFlow in
  // its immutable metadata contract.
  return type === 'return_settlement';
};

const routedPaymentIntent = (paymentIntent, paymentFlow) => ({
  ...paymentIntent,
  metadata: {
    ...(paymentIntent?.metadata || {}),
    paymentFlow,
  },
});

const routeFromLocalFlow = ({ paymentIntent, sourceType, local }) => {
  const paymentFlow = String(local?.paymentFlow || '');
  if (!['checkout_session', 'payment_sheet'].includes(paymentFlow)) {
    return {
      route: 'ambiguous',
      sourceType,
      reason: 'The authoritative local payment record has no valid payment flow.',
    };
  }
  return {
    route: paymentFlow === 'checkout_session' ? 'hosted_checkout' : 'payment_sheet',
    sourceType,
    paymentIntent: routedPaymentIntent(paymentIntent, paymentFlow),
    inferredFromLocalRecord: true,
  };
};

const safeFind = async work => {
  try {
    return await work();
  } catch (error) {
    if (error?.name === 'CastError') return null;
    throw error;
  }
};

/**
 * Resolve legacy PaymentIntents whose immutable metadata predates
 * `paymentFlow`. Known commerce ownership must bind to an authoritative local
 * record; ambiguity returns a retryable route and never enters either
 * lifecycle handler. Explicit modern metadata stays fast and deterministic.
 */
const resolvePaymentIntentLifecycleRoute = async paymentIntent => {
  const metadata = paymentIntent?.metadata || {};
  const sourceType = String(metadata.type || '').trim();
  const explicitFlow = String(metadata.paymentFlow || '').trim();
  if (isHostedCheckoutPaymentIntent(paymentIntent)) {
    return { route: 'hosted_checkout', sourceType, paymentIntent };
  }
  if (explicitFlow === 'payment_sheet' && ['wallet_top_up', 'order_payment'].includes(sourceType)) {
    return { route: 'payment_sheet', sourceType, paymentIntent };
  }
  if (explicitFlow) {
    return {
      route: 'ambiguous',
      sourceType,
      reason: 'Stripe commerce metadata contains an unsupported payment flow.',
    };
  }

  if (sourceType === 'wallet_top_up') {
    const local = await safeFind(async () => {
      if (metadata.walletTransactionId) {
        return WalletTransaction.findOne({
          _id: metadata.walletTransactionId,
          type: 'top_up',
        }).select('paymentFlow').lean();
      }
      return WalletTransaction.findOne({
        type: 'top_up',
        stripePaymentIntentId: paymentIntent?.id,
      }).select('paymentFlow').lean();
    });
    return local
      ? routeFromLocalFlow({ paymentIntent, sourceType, local })
      : {
        route: 'ambiguous',
        sourceType,
        reason: 'Legacy Wallet top-up metadata could not bind to its local transaction.',
      };
  }

  if (sourceType === 'order_payment') {
    let local = null;
    let lookupReason = '';
    try {
      local = await resolveStripeOrderForPaymentIntentRoute(paymentIntent);
    } catch (error) {
      if (!String(error?.code || '').startsWith('STRIPE_ORDER_')) throw error;
      lookupReason = error.message;
    }
    return local
      ? routeFromLocalFlow({ paymentIntent, sourceType, local })
      : {
        route: 'ambiguous',
        sourceType,
        reason: lookupReason || 'Legacy order-payment metadata could not bind to its local order.',
      };
  }

  if (sourceType === 'return_settlement') {
    return { route: 'hosted_checkout', sourceType, paymentIntent };
  }
  if (sourceType) return { route: 'unrelated', sourceType, paymentIntent };

  // Truly metadata-free historical objects can be classified only when one
  // and exactly one durable local reference already exists.
  const [wallet, order, returnRequest] = await Promise.all([
    WalletTransaction.findOne({
      type: 'top_up',
      stripePaymentIntentId: paymentIntent?.id,
    }).select('paymentFlow').lean(),
    Order.findOne({
      paymentMethod: 'stripe',
      $or: [
        { stripePaymentIntentId: paymentIntent?.id },
        { 'paymentResult.paymentIntentId': paymentIntent?.id },
      ],
    }).select('paymentFlow').lean(),
    ReturnRequest.findOne({
      'settlement.stripePaymentIntentId': paymentIntent?.id,
    }).select('_id').lean(),
  ]);
  const matches = [
    ...(wallet ? [{ sourceType: 'wallet_top_up', local: wallet }] : []),
    ...(order ? [{ sourceType: 'order_payment', local: order }] : []),
    ...(returnRequest ? [{ sourceType: 'return_settlement', local: { paymentFlow: 'checkout_session' } }] : []),
  ];
  if (matches.length === 1) return routeFromLocalFlow({ paymentIntent, ...matches[0] });
  if (matches.length > 1) {
    return {
      route: 'ambiguous',
      sourceType: '',
      reason: 'The PaymentIntent is referenced by multiple local commerce records.',
    };
  }
  return { route: 'unrelated', sourceType: '', paymentIntent };
};

module.exports = {
  isHostedCheckoutPaymentIntent,
  resolvePaymentIntentLifecycleRoute,
};
