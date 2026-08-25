'use strict';

const mongoose = require('mongoose');
const Order = require('../models/Order');

const lookupError = (message, code = 'STRIPE_ORDER_REFERENCE_INVALID', statusCode = 400) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const stringValue = value => (typeof value === 'string' ? value.trim() : '');

const referenceFieldFor = paymentFlow => (
  paymentFlow === 'payment_sheet' ? 'stripePaymentIntentId' : 'stripeSessionId'
);

/**
 * Bind a signed Stripe object to one local order without ever choosing the
 * first row matching the public, non-unique display orderId. New objects carry
 * Mongo's immutable _id. Historical objects may fall back to an already-bound
 * unique Stripe reference or to a public id only when that lookup is provably
 * unique after all available ownership fields are applied.
 */
const resolveStripeOrderForEvent = async ({ stripeObject, paymentFlow }) => {
  if (!stripeObject || !['checkout_session', 'payment_sheet'].includes(paymentFlow)) {
    throw lookupError('Stripe order lookup parameters are invalid.');
  }
  const metadata = stripeObject.metadata || {};
  const base = {
    paymentMethod: 'stripe',
    paymentFlow,
  };
  const mongoOrderId = stringValue(metadata.mongoOrderId);
  if (mongoOrderId) {
    if (!mongoose.isValidObjectId(mongoOrderId)) {
      throw lookupError('Stripe metadata contains an invalid Mongo order reference.');
    }
    const order = await Order.findOne({ _id: mongoOrderId, ...base });
    if (!order) {
      throw lookupError('Stripe references an unknown order.', 'STRIPE_ORDER_NOT_FOUND', 404);
    }
    return order;
  }

  const referenceField = referenceFieldFor(paymentFlow);
  const stripeReference = stringValue(stripeObject.id);
  if (stripeReference) {
    const referenced = await Order.findOne({ ...base, [referenceField]: stripeReference });
    if (referenced) return referenced;
  }

  const publicOrderId = stringValue(metadata.orderId);
  if (!publicOrderId) {
    throw lookupError('Stripe metadata is missing its immutable order reference.');
  }
  const legacyQuery = { ...base, orderId: publicOrderId };
  const userId = stringValue(metadata.userId);
  if (userId) {
    if (!mongoose.isValidObjectId(userId)) {
      throw lookupError('Stripe metadata contains an invalid order owner reference.');
    }
    legacyQuery.user = userId;
  }
  const candidates = await Order.find(legacyQuery).limit(2);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw lookupError(
      'Legacy Stripe metadata matches more than one order.',
      'STRIPE_ORDER_REFERENCE_AMBIGUOUS',
      409,
    );
  }
  throw lookupError('Stripe references an unknown order.', 'STRIPE_ORDER_NOT_FOUND', 404);
};

const resolveStripeOrderForPaymentIntentRoute = async paymentIntent => {
  if (!paymentIntent) throw lookupError('PaymentIntent order lookup parameters are invalid.');
  const metadata = paymentIntent.metadata || {};
  const base = { paymentMethod: 'stripe' };
  const mongoOrderId = stringValue(metadata.mongoOrderId);
  if (mongoOrderId) {
    if (!mongoose.isValidObjectId(mongoOrderId)) {
      throw lookupError('Stripe metadata contains an invalid Mongo order reference.');
    }
    const order = await Order.findOne({ _id: mongoOrderId, ...base });
    if (!order) throw lookupError('Stripe references an unknown order.', 'STRIPE_ORDER_NOT_FOUND', 404);
    return order;
  }

  const paymentIntentId = stringValue(paymentIntent.id);
  if (paymentIntentId) {
    const referenced = await Order.findOne({ ...base, stripePaymentIntentId: paymentIntentId });
    if (referenced) return referenced;
  }

  const publicOrderId = stringValue(metadata.orderId);
  if (!publicOrderId) {
    throw lookupError('Stripe metadata is missing its immutable order reference.');
  }
  const legacyQuery = { ...base, orderId: publicOrderId };
  const userId = stringValue(metadata.userId);
  if (userId) {
    if (!mongoose.isValidObjectId(userId)) {
      throw lookupError('Stripe metadata contains an invalid order owner reference.');
    }
    legacyQuery.user = userId;
  }
  const candidates = await Order.find(legacyQuery).limit(2);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw lookupError(
      'Legacy Stripe metadata matches more than one order.',
      'STRIPE_ORDER_REFERENCE_AMBIGUOUS',
      409,
    );
  }
  throw lookupError('Stripe references an unknown order.', 'STRIPE_ORDER_NOT_FOUND', 404);
};

module.exports = {
  resolveStripeOrderForEvent,
  resolveStripeOrderForPaymentIntentRoute,
};
