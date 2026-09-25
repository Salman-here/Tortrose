'use strict';

const Order = require('../models/Order');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const SellerPaymentRiskHold = require('../models/SellerPaymentRiskHold');
const SellerSettlementLock = require('../models/SellerSettlementLock');
const { fromMinorUnits } = require('./moneyMath');
const { assertSafepayOrderBinding } = require('./safepayPaymentFacts');
// This existing pure validator reconciles immutable lines, coupons, shipping
// and tax in exact minor units. It does not call or create a Stripe payment.
const { getExpectedStripeTotalMinor: getExpectedOrderTotalMinor } = require('./stripeOrderPaymentService');
const { commitOrderInventoryAndCoupons } = require('./orderInventoryService');
const { setAllSellerFulfillmentStatus, syncAggregateDeliveryState } = require('./orderFulfillmentService');
const { removeFulfilledOrderItemsFromCart } = require('./cartFulfillmentService');
const { cancelUnpaidOrderLocally } = require('./orderCancellationService');
const { creditWalletInSession } = require('./walletService');
const { enqueuePaidOrderBuyerNotifications, enqueuePaidOrderSellerNotifications, enqueueWalletTransactionNotification } = require('./financialNotificationOutboxService');
const id = value => String(value?._id || value || '');
const fail = (message, code) => Object.assign(new Error(message), { code, statusCode: 409 });

async function settleOrder(payment, session) {
  let order = await Order.findById(payment.order).session(session);
  assertSafepayOrderBinding(order, payment, getExpectedOrderTotalMinor(order));
  if (order.isPaid && order.paymentFulfilledAt && !order.awaitingPayment
      && order.inventoryCommitted && order.paymentSetupState === 'complete') return;
  if (!order.awaitingPayment || order.isPaid || order.orderStatus === 'cancelled'
    || order.confirmation?.declinedAt) {
    throw fail('This captured order requires review before fulfillment.', 'SAFEPAY_ORDER_SETTLEMENT_CONFLICT');
  }
  if (payment.terms?.settlementPolicy === 'revalidate-on-payment-v1') {
    await require('./safepayOrderAvailabilityService').assertOrderAvailable(payment, session, { reserveCoupons: true });
  } else if (!order.inventoryCommitted) {
    throw fail('This older payment has no valid inventory reservation.', 'SAFEPAY_ORDER_SETTLEMENT_CONFLICT');
  }
  await commitOrderInventoryAndCoupons(order._id, { session });
  order = await Order.findById(payment.order).session(session);
  const at = new Date();
  order.isPaid = true;
  order.awaitingPayment = false;
  order.paidAt = at;
  order.paymentFulfilledAt = at;
  order.paymentSetupState = 'complete';
  order.paymentSetupCompletedAt = at;
  order.paymentProcessingStartedAt = null;
  order.paymentExpiresAt = null;
  order.safepayTrackerId = payment.tracker;
  order.confirmation = order.confirmation || {};
  order.confirmation.confirmedAt = at;
  order.confirmation.confirmedVia = 'safepay_payment';
  order.paymentResult = order.paymentResult || {};
  order.paymentResult.emailAddress = order.shippingInfo?.email || '';
  order.paymentResult.failureCode = '';
  order.paymentResult.failureMessage = '';
  order.paymentResult.failureAt = null;
  setAllSellerFulfillmentStatus(order, 'confirmed', at);
  if (order.sellerFulfillment?.length) syncAggregateDeliveryState(order);
  else order.orderStatus = 'confirmed';
  await order.save({ session });
  await removeFulfilledOrderItemsFromCart({ userId: order.user, orderItems: order.orderItems, fulfillmentId: order._id, session });
  await enqueuePaidOrderBuyerNotifications(order, { session });
  for (const seller of [...new Set((order.sellerSettlement || []).map(entry => id(entry.seller)).filter(Boolean))]) {
    await enqueuePaidOrderSellerNotifications(order, seller, { session });
  }
}

async function settleWallet(payment, session) {
  const idempotencyKey = `safepay:${payment.environment}:${payment._id}:wallet-credit`;
  const existing = await WalletTransaction.findOne({ idempotencyKey }).session(session);
  if (existing) {
    if (existing.status !== 'completed' || id(existing.safepayPaymentId) !== id(payment)
        || existing.safepayEnvironment !== payment.environment || id(existing.user) !== id(payment.user)
        || existing.currency !== payment.currency || existing.amount !== fromMinorUnits(payment.amountMinor)
        || existing.safepayTrackerId !== payment.tracker) {
      throw fail('The saved Wallet credit does not match this payment.', 'SAFEPAY_WALLET_BINDING_INVALID');
    }
    // Do not replenish a funding lot that the customer has already spent.
    await enqueueWalletTransactionNotification(existing, { session });
    return;
  }
  const transaction = await creditWalletInSession({ userId: payment.user, amount: fromMinorUnits(payment.amountMinor),
    currency: payment.currency, type: 'top_up', referenceType: 'safepay_payment', referenceId: payment.tracker,
    idempotencyKey,
    description: 'Rozare Wallet top-up via Safepay', allowLocked: true,
    metadata: { provider: 'safepay', providerEnvironment: payment.environment, safepayPaymentId: id(payment),
      // Passing the native fields through the generic credit helper below
      // keeps the credit and its funding provenance in the same transaction.
      fundingRemainingMinor: 0, fundingOriginalAvailableMinor: 0 },
  }, session);
  if (id(transaction.user) !== id(payment.user) || transaction.referenceType !== 'safepay_payment'
    || transaction.referenceId !== payment.tracker || transaction.currency !== payment.currency
    || transaction.amount !== fromMinorUnits(payment.amountMinor)) throw fail('Wallet payment identity changed.', 'SAFEPAY_WALLET_BINDING_INVALID');
  transaction.safepayPaymentId = payment._id;
  transaction.safepayEnvironment = payment.environment;
  transaction.safepayTrackerId = payment.tracker;
  transaction.paymentFlow = 'safepay_hosted';
  transaction.paymentSetupState = 'complete';
  transaction.paymentSetupCompletedAt = transaction.completedAt;
  transaction.clientSurface = 'mobile';
  transaction.metadata = { ...transaction.metadata, fundingRemainingMinor: transaction.metadata.availableCreditedMinor,
    fundingOriginalAvailableMinor: transaction.metadata.availableCreditedMinor };
  await transaction.save({ session });
  await enqueueWalletTransactionNotification(transaction, { session });
}

async function settleSafepayPayment(payment, tracker, session) {
  if (!session?.inTransaction?.()) throw fail('Payment settlement requires an atomic transaction.', 'SAFEPAY_TRANSACTION_REQUIRED');
  if (payment.purpose === 'order') return settleOrder(payment, session);
  if (payment.purpose === 'wallet_top_up') return settleWallet(payment, session);
  if (payment.purpose === 'subscription') return require('./safepayBillingService').settleBillingPayment(payment, tracker, session);
  if (payment.purpose === 'subdomain') return require('./safepaySubdomainService').settle(payment, tracker, session);
  if (payment.purpose === 'return_settlement') return require('./returnService').completeSafepayReturnSettlement(payment, tracker, session);
  // Seller entitlement handlers are separate from order/Wallet settlement;
  // an unsupported purpose must never accidentally credit a different flow.
  throw fail('This payment purpose is not enabled for settlement.', 'SAFEPAY_PURPOSE_NOT_ENABLED');
}

async function closeSafepayPayment(payment, session) {
  if (payment.purpose === 'return_settlement') return require('./returnService').closeSafepayReturnSettlement(payment, session);
  if (payment.purpose === 'subdomain') return require('./safepaySubdomainService').releaseCheckout(payment, session);
  if (payment.purpose === 'order') {
    const order = await Order.findById(payment.order).session(session);
    assertSafepayOrderBinding(order, payment, getExpectedOrderTotalMinor(order));
    await cancelUnpaidOrderLocally({ orderId: payment.order, externalPaymentClosed: true, session,
      reason: 'Safepay confirmed that this unpaid checkout is cancelled or expired.' });
  }
}

async function quarantineSafepayPayment(payment, tracker, session) {
  const refunded = await require('./safepayRefundService').reconcileOrderRefund(payment, tracker, session);
  if (refunded) return refunded;
  if (payment.purpose === 'subdomain') return require('./safepaySubdomainService').hold(payment, tracker, session);
  if (payment.purpose === 'subscription') {
    await require('./safepayBillingService').holdBillingPayment(payment, tracker, session);
    return;
  }
  const orderIds = payment.order ? [payment.order] : [];
  let returnSeller = null;
  if (payment.purpose === 'return_settlement') {
    const request = await require('../models/ReturnRequest').findOne({ _id: payment.returnRequest,
      seller: payment.user, 'settlement.safepayPaymentId': payment._id }).session(session);
    if (request) {
      returnSeller = id(request.seller);
      await Wallet.updateOne({ user: request.buyer, status: 'active' }, { $set: { status: 'locked', lockSource: 'system',
        lockedReason: 'A card-funded return refund needs payment reconciliation. Please contact support.' } }, { session });
    }
  }
  if (payment.purpose === 'wallet_top_up') {
    // Preserve any existing admin/manual lock. A provider-risk system lock is
    // not auto-cleared by the unrelated Stripe liability reconciler.
    await Wallet.updateOne({ user: payment.user, status: 'active' }, { $set: { status: 'locked', lockSource: 'system',
      lockedReason: 'A Safepay-funded payment needs reconciliation. Please contact support.' } }, { session });
    const source = await WalletTransaction.findOne({ idempotencyKey: `safepay:${payment.environment}:${payment._id}:wallet-credit` }).session(session);
    if (source) {
      const spent = await WalletTransaction.find({ type: 'order_payment', status: 'completed',
        'metadata.fundingProvenance.sourceTransactionId': String(source._id) }).select('referenceId').session(session);
      orderIds.push(...spent.map(row => row.referenceId));
    }
  }
  const orders = orderIds.length ? await Order.find({ _id: { $in: orderIds } }).session(session) : [];
  const sellers = [...new Set([...orders.flatMap(order => (order.sellerSettlement || []).map(row => id(row.seller))), returnSeller].filter(Boolean))].sort();
  for (const seller of sellers) {
    // Share the withdrawal transaction fence so a payout cannot race an
    // unaccounted refund/dispute from another payment provider.
    await SellerSettlementLock.findOneAndUpdate({ seller }, { $inc: { version: 1 } }, { upsert: true, new: true, session });
    const eventId = `safepay:${payment.environment}:${payment._id}:review`;
    const riskTrackKey = `safepay:${payment.environment}:${payment.tracker}`;
    await SellerPaymentRiskHold.updateOne({ seller, eventId, riskTrackKey }, { $setOnInsert: {
      provider: 'safepay', providerPaymentId: payment.tracker, providerEnvironment: payment.environment,
      sourceType: payment.purpose === 'wallet_top_up' ? 'wallet_top_up' : payment.purpose === 'return_settlement' ? 'return_settlement' : 'order_payment',
      sourceReferenceId: id(payment), eventType: tracker.state, riskTrack: 'refund', unknownExposure: true, status: 'pending',
    } }, { upsert: true, session, runValidators: true });
  }
}

module.exports = { settleSafepayPayment, closeSafepayPayment, quarantineSafepayPayment };
