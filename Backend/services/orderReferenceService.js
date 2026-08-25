'use strict';

const mongoose = require('mongoose');
const Order = require('../models/Order');

const orderReferenceError = (
  message,
  code = 'ORDER_REFERENCE_INVALID',
  statusCode = 400
) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const combineScope = (scope, identity) => (
  scope && Object.keys(scope).length
    ? { $and: [scope, identity] }
    : identity
);

/**
 * Resolve route/user input without ever letting a public display id compete
 * with Mongo's immutable _id. A syntactically valid Mongo id is authoritative
 * even when it is unknown. Historical display ids are accepted only when the
 * caller's explicit scope produces exactly one row.
 */
async function resolveOrderReference({
  reference,
  scope = {},
  session = null,
  select = null,
  lean = false,
} = {}) {
  const normalized = typeof reference === 'string' ? reference.trim() : '';
  if (!normalized) throw orderReferenceError('An order reference is required.');

  if (mongoose.isValidObjectId(normalized)) {
    let query = Order.findOne(combineScope(scope, { _id: normalized }));
    if (session) query = query.session(session);
    if (select) query = query.select(select);
    if (lean) query = query.lean();
    return query;
  }

  let query = Order.find(combineScope(scope, { orderId: normalized }))
    .sort({ _id: 1 })
    .limit(2);
  if (session) query = query.session(session);
  if (select) query = query.select(select);
  if (lean) query = query.lean();
  const candidates = await query;
  if (candidates.length > 1) {
    throw orderReferenceError(
      'This historical order id matches more than one order. Use the immutable order reference or contact support.',
      'ORDER_REFERENCE_AMBIGUOUS',
      409
    );
  }
  return candidates[0] || null;
}

module.exports = {
  orderReferenceError,
  resolveOrderReference,
};
