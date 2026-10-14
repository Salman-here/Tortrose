'use strict';
const crypto = require('node:crypto');
const Request = require('../models/ReturnRequest');
const Order = require('../models/Order');
const Product = require('../models/Product');
const { runInTransaction } = require('./walletService');
const { aggregateOrderInventoryLines } = require('./orderInventoryService');
const { assertWalletOrderFundingReturnable } = require('./walletOrderFundingRiskService');
const { notifyBuyerReturnStatus } = require('./returnNotificationService');
const id = value => String(value?._id || value || '');
const fail = (message, code = 'REPLACEMENT_INVALID', statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const objectId = value => typeof value === 'string' && /^[a-f\d]{24}$/iu.test(value);
function dispatchInput(input) {
  if (!['courier', 'hand_delivery'].includes(input.shippingMethod) || typeof input.operationKey !== 'string'
      || input.operationKey !== input.operationKey.trim() || input.operationKey.length < 16 || input.operationKey.length > 128) throw fail('Choose the shipping method and retain the same dispatch key.', 'REPLACEMENT_INPUT_INVALID', 400);
  const carrier = String(input.carrier || '').trim(), trackingNumber = String(input.trackingNumber || '').trim();
  if (carrier.length > 100 || trackingNumber.length > 160 || input.shippingMethod === 'courier' && (carrier.length < 2 || trackingNumber.length < 3)) throw fail('Courier dispatch requires a carrier and tracking number.', 'REPLACEMENT_TRACKING_REQUIRED', 400);
  return { shippingMethod: input.shippingMethod, carrier, trackingNumber };
}
async function dispatchReplacement({ requestId, sellerId, expectedUpdatedAt, ...input }) {
  if (!objectId(requestId) || !objectId(sellerId)) throw fail('A valid owned replacement is required.', 'REPLACEMENT_INPUT_INVALID', 400);
  const details = dispatchInput(input), fingerprint = hash({ requestId, sellerId, ...details });
  return runInTransaction(async session => {
    const request = await Request.findOne({ _id: requestId, seller: sellerId }).select('+replacement.dispatchKey +replacement.dispatchFingerprint').session(session);
    if (!request) throw fail('This replacement does not belong to the seller.', 'REPLACEMENT_NOT_FOUND', 404);
    const dispatchKey = hash(input.operationKey);
    if (request.replacement?.dispatchKey === dispatchKey) {
      if (request.replacement.dispatchFingerprint !== fingerprint) throw fail('This dispatch key belongs to different shipment details.', 'IDEMPOTENCY_CONFLICT');
      return request;
    }
    if (request.status !== 'replacement_approved' || request.policySnapshot.refundType !== 'replacement_only'
        || request.kind === 'warranty' && request.resolution !== 'replacement'
        || request.replacement?.inventoryCommitted) throw fail('This replacement is not ready for dispatch.', 'REPLACEMENT_STATE_INVALID');
    if (expectedUpdatedAt && new Date(request.updatedAt).toISOString() !== expectedUpdatedAt) throw fail('The replacement changed. Review the latest details.', 'REPLACEMENT_STALE');
    const order = await Order.findOne({ _id: request.order, user: request.buyer }).session(session);
    if (!order) throw fail('The original buyer order cannot be verified.');
    await Order.updateOne({ _id: order._id }, { $inc: { returnVersion: 1 } }, { session });
    await assertWalletOrderFundingReturnable({ orderId: order._id, session });
    for (const item of request.items) {
      const product = await Product.findOne({ _id: item.productId, seller: sellerId, isBlocked: { $ne: true }, moderationStatus: { $ne: 'blocked' } }).session(session);
      if (!product) throw fail('The original replacement product is unavailable. Resolve the claim with the buyer before changing the product.', 'REPLACEMENT_PRODUCT_UNAVAILABLE');
      if (!Number.isSafeInteger(product.stock) || product.stock < 0) throw fail('Replacement inventory could not be verified. Correct the stock record before dispatching.', 'REPLACEMENT_STOCK_INVALID');
      const options = item.selectedOptions instanceof Map ? Object.fromEntries(item.selectedOptions) : item.selectedOptions || {};
      for (const group of product.optionGroups || []) if (!group.values.includes(options[group.name] || (group.name.toLowerCase() === 'color' ? item.selectedColor : ''))) throw fail('The purchased replacement option is no longer available. Resolve the variant with the buyer.', 'REPLACEMENT_VARIANT_UNAVAILABLE');
      if (!product.optionGroups?.length && item.selectedColor && product.colors?.length && !product.colors.includes(item.selectedColor)) throw fail('The purchased replacement colour is no longer available.', 'REPLACEMENT_VARIANT_UNAVAILABLE');
    }
    for (const line of aggregateOrderInventoryLines(request.items)) {
      const changed = await Product.updateOne({ _id: line.productId, seller: sellerId, stock: { $gte: line.quantity }, isBlocked: { $ne: true } }, { $inc: { stock: -line.quantity } }, { session });
      if (changed.modifiedCount !== 1) throw fail('There is not enough replacement stock. Restock before dispatching.', 'REPLACEMENT_STOCK_UNAVAILABLE');
    }
    request.set('replacement', { ...details, inventoryCommitted: true, shippedAt: new Date(),
      dispatchKey, dispatchFingerprint: fingerprint });
    request.status = 'replacement_shipped'; request.statusHistory.push({ status: request.status,
      note: details.shippingMethod === 'courier' ? `Replacement sent with ${details.carrier}. Tracking: ${details.trackingNumber}` : 'Replacement dispatched for hand delivery.', changedBy: sellerId, actorRole: 'seller' });
    await request.save({ session }); await notifyBuyerReturnStatus(request, order, '', { session }); return request;
  });
}
async function confirmReplacementReceived({ requestId, buyerId }) {
  if (!objectId(requestId) || !objectId(buyerId)) throw fail('A valid owned replacement is required.', 'REPLACEMENT_INPUT_INVALID', 400);
  return runInTransaction(async session => {
    const request = await Request.findOne({ _id: requestId, buyer: buyerId }).session(session);
    if (!request) throw fail('Replacement not found in this buyer account.', 'REPLACEMENT_NOT_FOUND', 404);
    if (request.status === 'replacement_delivered' && id(request.replacement?.deliveredBy) === id(buyerId)) return request;
    if (request.status !== 'replacement_shipped' || request.replacement?.inventoryCommitted !== true) throw fail('Only a dispatched replacement can be confirmed received.', 'REPLACEMENT_STATE_INVALID');
    await Order.updateOne({ _id: request.order }, { $inc: { returnVersion: 1 } }, { session });
    request.status = 'replacement_delivered'; request.replacement.deliveredAt = new Date(); request.replacement.deliveredBy = buyerId;
    request.statusHistory.push({ status: request.status, note: 'Buyer confirmed receipt of the replacement.', changedBy: buyerId, actorRole: 'buyer' });
    await request.save({ session }); await notifyBuyerReturnStatus(request, await Order.findById(request.order).session(session), '', { session }); return request;
  });
}
module.exports = { dispatchReplacement, confirmReplacementReceived };
