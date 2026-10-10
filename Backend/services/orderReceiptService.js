'use strict';
const mongoose = require('mongoose');
const Payment = require('../models/SafepayPayment');
const WalletTransaction = require('../models/WalletTransaction');
const RiskHold = require('../models/SellerPaymentRiskHold');
const Cancellation = require('../models/OrderCancellation');
const ReturnRequest = require('../models/ReturnRequest');
const { resolveOrderReference } = require('./orderReferenceService');
const { assertSafepayOrderBinding } = require('./safepayPaymentFacts');
const { normalizeSafepayPaymentRail } = require('./safepayPaymentRailService');
const { getExpectedStripeTotalMinor } = require('./stripeOrderPaymentService');
const { isNoChargeOnlineOrder } = require('./orderNoChargeService');
const { assertWalletOrderFundingReturnable } = require('./walletOrderFundingRiskService');
const { getAccountingOrderCurrency } = require('./orderMoneyService');
const { toMinorUnits, fromMinorUnits } = require('./moneyMath');
const ORDER_STATUSES = new Set(['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled']);
const id = value => String(value?._id || value || '');
const validDate = value => (value instanceof Date || typeof value === 'string') && value
  && Number.isFinite(new Date(value).getTime());
const receiptError = (msg, code, statusCode) => Object.assign(new Error(msg), { code, statusCode });
const reviewReason = 'The current payment evidence requires review. Check the order details or contact support.';

async function getOwnedOrderReceipt({ reference, buyerId }) {
  if (!mongoose.isValidObjectId(buyerId)) throw receiptError('Sign in to view your order confirmation.', 'ORDER_RECEIPT_AUTH_REQUIRED', 401);
  const ref = typeof reference === 'string' ? reference.trim() : '';
  if (!/^[a-f\d]{24}$/i.test(ref) && !/^ORD-[A-Za-z\d-]{1,96}$/.test(ref)) {
    throw receiptError('Use a valid order reference.', 'ORDER_REFERENCE_INVALID', 400);
  }
  // A seller/admin may also buy. This endpoint always uses purchaser identity,
  // never account-role management privileges or success/payment query claims.
  const order = await resolveOrderReference({ reference: ref, scope: { user: buyerId }, lean: true });
  if (!order) throw receiptError('Order not found.', 'ORDER_NOT_FOUND', 404);
  let totalMinor, currency;
  try { totalMinor = getExpectedStripeTotalMinor(order); currency = getAccountingOrderCurrency(order); }
  catch (_) { throw receiptError('This order confirmation could not be verified. Please check your orders.', 'ORDER_RECEIPT_DATA_UNAVAILABLE', 503); }
  const allCancelled = (order.sellerFulfillment || []).length > 0 && order.sellerFulfillment.every(row => row.status === 'cancelled');
  const lifecycleCancelled = allCancelled || Boolean(order.confirmation?.declinedAt);
  if (!lifecycleCancelled && !ORDER_STATUSES.has(order.orderStatus)) throw receiptError('This order status could not be verified. Please check your orders.', 'ORDER_RECEIPT_DATA_UNAVAILABLE', 503);
  const orderStatus = lifecycleCancelled ? 'cancelled' : order.orderStatus;
  const fulfilled = order.isPaid === true && order.awaitingPayment === false
    && validDate(order.paymentFulfilledAt) && validDate(order.paidAt)
    // A completed cancellation restores stock. Its historical fulfillment
    // marker still binds the owned debit/capture needed to verify its refund.
    && (order.inventoryCommitted === true || orderStatus === 'cancelled');
  let paymentStatus = 'pending', healthy = false, paymentRail = 'unknown', reason = '';
  let noPaymentRequired = false;
  try { noPaymentRequired = totalMinor === 0 && isNoChargeOnlineOrder(order); } catch (_) {}
  if (order.paymentMethod === 'cash_on_delivery') {
    healthy = order.awaitingPayment !== true && order.inventoryCommitted === true && validDate(order.createdAt);
    paymentStatus = healthy ? order.isPaid === true && validDate(order.paidAt) && orderStatus === 'delivered' ? 'paid' : 'unpaid' : 'review_required';
    if (!healthy) reason = reviewReason;
  } else if (noPaymentRequired) {
    healthy = Boolean(fulfilled && order.paymentSetupState === 'complete'); paymentStatus = healthy ? 'not_required' : 'pending';
  } else if (order.paymentMethod === 'safepay') {
    const payment = mongoose.isValidObjectId(order.safepayPaymentId) ? await Payment.findOne({ _id: order.safepayPaymentId,
      order: order._id, user: order.user, purpose: 'order', environment: order.safepayEnvironment, currency }).lean() : null;
    if (payment) {
      let bound = false;
      try { assertSafepayOrderBinding(order, payment, totalMinor); bound = payment.amountMinor === totalMinor; } catch (_) {}
      if (bound) paymentRail = normalizeSafepayPaymentRail(payment.paymentRail);
      const returned = Number.isSafeInteger(payment.refundedMinor) && Number.isSafeInteger(payment.walletRefundMinor)
        && payment.refundedMinor >= 0 && payment.walletRefundMinor >= 0 ? payment.refundedMinor + payment.walletRefundMinor : null;
      const invalidRail = paymentRail === 'raast' && (currency !== 'PKR' || payment.providerMode !== 'payment' || payment.providerEntryMode === 'tms');
      if (invalidRail) paymentRail = 'unknown';
      if (!bound || invalidRail || returned === null || returned > totalMinor) { paymentStatus = 'review_required'; reason = reviewReason; }
      else if (payment.riskPending || ['manual_review', 'refund_pending'].includes(payment.status)) { paymentStatus = 'review_required'; reason = reviewReason; }
      else if (totalMinor > 0 && returned === totalMinor) paymentStatus = 'refunded';
      else if (returned > 0) paymentStatus = 'partially_refunded';
      else if (['refunded', 'failed', 'cancelled'].includes(payment.status)) paymentStatus = payment.status === 'refunded' ? 'review_required' : 'cancelled';
      else {
        healthy = Boolean(fulfilled && order.paymentSetupState === 'complete' && payment.status === 'paid' && validDate(payment.appliedAt) && validDate(payment.paidAt)
          && payment.providerMode === 'payment' && payment.capturedMinor === totalMinor && totalMinor > 0
          && /^track_[A-Za-z\d-]+$/.test(payment.tracker || ''));
        paymentStatus = healthy ? 'paid' : order.awaitingPayment === true && order.isPaid !== true ? 'pending' : 'review_required';
        if (paymentStatus === 'review_required') reason = reviewReason;
      }
    } else { paymentStatus = order.awaitingPayment === true && order.isPaid !== true ? 'pending' : 'review_required'; reason = paymentStatus === 'review_required' ? reviewReason : ''; }
  } else if (order.paymentMethod === 'wallet') {
    const recorded = order.paymentResult?.walletTransactionId;
    const debit = !recorded || mongoose.isValidObjectId(recorded) ? await WalletTransaction.findOne({ ...(recorded ? { _id: recorded } : {}),
      user: order.user, type: 'order_payment', referenceType: 'order', referenceId: id(order), direction: 'debit',
      status: 'completed', currency, idempotencyKey: `wallet-order:${id(order)}` }).lean() : null;
    // Wallet checkout has no external setup: the existing implementation keeps
    // its setup state closed and proves payment with the owned committed debit.
    healthy = Boolean(totalMinor > 0 && fulfilled && ['closed', 'complete'].includes(order.paymentSetupState) && debit && toMinorUnits(debit.amount) === totalMinor
      && (Number(order.sellerCurrencyMoneyVersion) < 2 || recorded));
    paymentStatus = healthy ? 'paid' : order.awaitingPayment === true && order.isPaid !== true ? 'pending' : 'review_required';
    if (paymentStatus === 'review_required') reason = reviewReason;
  } else { paymentStatus = 'review_required'; reason = 'This historical payment provider requires verification in order details.'; }
  // These existing funding-risk checks are read-only. The fulfillment authority
  // writes locks/document versions and must never be called by a receipt GET.
  if (healthy && totalMinor > 0 && ['wallet', 'safepay'].includes(order.paymentMethod)) {
    const refs = [id(order), id(order.safepayPaymentId)].filter(Boolean);
    try {
      await assertWalletOrderFundingReturnable({ orderId: order._id });
      if (await RiskHold.exists({ status: 'pending', sourceType: 'order_payment', sourceReferenceId: { $in: refs } })) {
        healthy = false; paymentStatus = 'review_required'; reason = reviewReason;
      }
    } catch (_) { healthy = false; paymentStatus = 'review_required'; reason = reviewReason; }
  }
  // A completed cancellation is current refund information, not a second order
  // placement. Wallet refunds have their owned completed credit as evidence.
  if (healthy && order.paymentMethod === 'wallet') {
    const cancelled = await Cancellation.find({ order: order._id, buyer: order.user, paymentMethod: 'wallet',
      refundDestination: 'wallet', refundStatus: 'refunded' }).lean();
    let refunded = 0;
    for (const row of cancelled) {
      const credit = row.walletTransaction && await WalletTransaction.findOne({ _id: row.walletTransaction, user: order.user,
        type: 'return_refund', direction: 'credit', status: 'completed', currency, referenceType: 'order_cancellation', referenceId: id(row),
        idempotencyKey: `order-cancellation:${id(row)}:wallet` }).lean();
      const amount = row.refundAmountMinor ?? row.amountMinor;
      if (row.currency !== currency || !credit || !Number.isSafeInteger(amount) || amount < 0 || toMinorUnits(credit.amount) !== amount
          || !Number.isSafeInteger(refunded + amount)) {
        healthy = false; paymentStatus = 'review_required'; reason = reviewReason; break;
      }
      refunded += amount;
    }
    if (healthy) {
      const returned = await ReturnRequest.find({ order: order._id, buyer: order.user, status: 'returned',
        'settlement.status': 'completed', 'settlement.walletTransaction': { $ne: null } }).lean();
      for (const row of returned) {
        const credit = await WalletTransaction.findOne({ _id: row.settlement.walletTransaction, user: order.user,
          type: 'return_refund', direction: 'credit', status: 'completed', currency, referenceType: 'return_request', referenceId: id(row),
          idempotencyKey: `return-refund:${id(row)}` }).lean();
        const amount = toMinorUnits(row.refund?.totalAmount);
        if (row.currency !== currency || !credit || amount <= 0 || toMinorUnits(credit.amount) !== amount || !Number.isSafeInteger(refunded + amount)) {
          healthy = false; paymentStatus = 'review_required'; reason = reviewReason; break;
        }
        refunded += amount;
      }
    }
    if (healthy && refunded > 0) { healthy = false; paymentStatus = refunded === totalMinor ? 'refunded' : refunded < totalMinor ? 'partially_refunded' : 'review_required'; }
  }
  if (orderStatus === 'cancelled') {
    healthy = false;
    if (!['refunded', 'partially_refunded', 'review_required'].includes(paymentStatus)) paymentStatus = 'cancelled';
  }
  if (['refunded', 'partially_refunded', 'review_required', 'cancelled'].includes(paymentStatus)) healthy = false;
  const hasCancelledItems = orderStatus === 'cancelled' || (order.sellerFulfillment || []).some(row => row.status === 'cancelled');
  if (paymentStatus === 'review_required' && !reason) reason = reviewReason;
  const isPaid = healthy && ['paid', 'not_required'].includes(paymentStatus);
  return { version: 1, buyerId: id(order.user), mongoOrderId: id(order), orderId: order.orderId,
    paymentMethod: order.paymentMethod, paymentRail, currency, totalMinor, totalAmount: fromMinorUnits(totalMinor),
    placedAt: validDate(order.createdAt) ? new Date(order.createdAt).toISOString() : null, orderStatus, paymentStatus,
    orderPlaced: healthy, isPaid, confirmationRequired: healthy && order.paymentMethod === 'cash_on_delivery'
      && orderStatus === 'pending' && !order.confirmation?.confirmedAt && !order.confirmation?.declinedAt,
    noPaymentRequired, hasCancelledItems, reviewReason: reason };
}
module.exports = { getOwnedOrderReceipt };
