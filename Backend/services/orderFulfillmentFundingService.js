'use strict';

const mongoose = require('mongoose');
const Payment = require('../models/SafepayPayment');
const WalletTransaction = require('../models/WalletTransaction');
const Cancellation = require('../models/OrderCancellation');
const ReturnRequest = require('../models/ReturnRequest');
const SellerLock = require('../models/SellerSettlementLock');
const RiskHold = require('../models/SellerPaymentRiskHold');
const BalanceTransaction = require('../models/SellerBalanceTransaction');
const { toMinorUnits } = require('./moneyMath');
const { getExpectedStripeTotalMinor: expectedOrderMinor } = require('./stripeOrderPaymentService');
const { isNoChargeOnlineOrder } = require('./orderNoChargeService');
const { assertSafepayOrderBinding } = require('./safepayPaymentFacts');
const { assertWalletOrderFundingReturnable } = require('./walletOrderFundingRiskService');

const id = value => String(value?._id || value || '');
const invalid = () => Object.assign(new Error('This order payment could not be verified. Please contact support before preparing or shipping these items.'), {
  code: 'ORDER_FUNDING_UNVERIFIED', statusCode: 409, definitiveNoMutation: true,
});
const reversed = () => Object.assign(new Error('This order payment was refunded, reversed or is under review. These items cannot enter fulfillment until payment review is resolved.'), {
  code: 'ORDER_FUNDING_REVERSED', statusCode: 409, definitiveNoMutation: true,
});
const minor = value => { try { return toMinorUnits(value); } catch (_) { throw invalid(); } };

async function accountedCardRefund(payment, session) {
  if (!Number.isSafeInteger(payment.refundedMinor) || payment.refundedMinor < 0) throw invalid();
  if (!payment.refundedMinor) return;
  if (payment.purpose !== 'order') throw reversed();
  const rows = await Cancellation.find({ payment: payment._id, order: payment.order, buyer: payment.user,
    environment: payment.environment, currency: payment.currency, refundDestination: 'original_card', refundStatus: 'refunded' })
    .select('amountMinor refundAmountMinor').session(session).lean();
  let accounted = 0;
  for (const row of rows) {
    const amount = row.refundAmountMinor ?? row.amountMinor;
    if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(accounted + amount)) throw invalid();
    accounted += amount;
  }
  // An attributed cancellation closes its seller's portion, not the other
  // sellers' valid funding. An unscoped provider refund has no such authority.
  if (accounted !== payment.refundedMinor) throw reversed();
}

async function healthyPayment(payment, session) {
  if (!payment) throw invalid();
  if (payment.riskPending || ['manual_review', 'refund_pending', 'refunded', 'closed', 'failed'].includes(payment.status)) throw reversed();
  if (payment.status !== 'paid' || !payment.appliedAt || !payment.paidAt
      || payment.providerMode !== 'payment'
      || !Number.isSafeInteger(payment.amountMinor) || payment.amountMinor <= 0
      || payment.capturedMinor !== payment.amountMinor || !/^track_[A-Za-z0-9-]+$/.test(payment.tracker || '')
      || !['sandbox', 'production'].includes(payment.environment)) throw invalid();
  await accountedCardRefund(payment, session);
  // The authority write shares the provider reconciliation transaction. This
  // matters when a returned card-funded Wallet lot pays a DIFFERENT seller:
  // a refund may lock the original seller rather than this later seller.
  if ((await Payment.updateOne({ _id: payment._id }, { $inc: { __v: 1 } }, { session })).matchedCount !== 1) throw invalid();
}

async function bindCardFundedCredit(source, payment, session) {
  if (source.safepayEnvironment !== payment.environment || source.safepayTrackerId !== payment.tracker
      || source.currency !== payment.currency) throw invalid();
  if (source.type === 'top_up') {
    if (payment.purpose !== 'wallet_top_up' || id(payment.user) !== id(source.user)
        || source.referenceType !== 'safepay_payment' || source.referenceId !== payment.tracker
        || minor(source.amount) !== payment.amountMinor) throw invalid();
    return;
  }
  if (source.type !== 'return_refund' || source.metadata?.cardRefundFunding !== true) throw invalid();
  if (payment.purpose === 'order') {
    if (id(payment.user) !== id(source.user) || id(payment.order) !== id(source.metadata?.sourceOrderId)) throw invalid();
    if (source.referenceType === 'order_cancellation') {
      const row = await Cancellation.findOne({ _id: source.referenceId, order: payment.order, buyer: source.user,
        payment: payment._id, environment: payment.environment, currency: source.currency,
        refundDestination: 'wallet', refundStatus: 'refunded', walletTransaction: source._id }).session(session).lean();
      if (!row || (row.refundAmountMinor ?? row.amountMinor) !== minor(source.amount)) throw invalid();
      return;
    }
    if (source.referenceType === 'return_request') {
      const row = await ReturnRequest.findOne({ _id: source.referenceId, order: payment.order, buyer: source.user,
        currency: source.currency, status: 'returned', 'settlement.walletTransaction': source._id }).session(session).lean();
      if (!row || minor(row.refund?.totalAmount) !== minor(source.amount)) throw invalid();
      return;
    }
  } else if (payment.purpose === 'return_settlement' && source.referenceType === 'return_request') {
    const row = await ReturnRequest.findOne({ _id: source.referenceId, buyer: source.user, seller: payment.user,
      currency: source.currency, status: 'returned', 'settlement.walletTransaction': source._id,
      'settlement.safepayPaymentId': payment._id, 'settlement.safepayEnvironment': payment.environment }).session(session).lean();
    if (!row || id(payment.returnRequest) !== id(row) || minor(row.refund?.totalAmount) !== minor(source.amount)) throw invalid();
    return;
  }
  throw invalid();
}

async function walletAuthority(order, expected, session) {
  const recordedId = order.paymentResult?.walletTransactionId;
  if ((Number(order.sellerCurrencyMoneyVersion) >= 2 && !recordedId)
      || (recordedId && !mongoose.isValidObjectId(recordedId))) throw invalid();
  const debit = await WalletTransaction.findOne({ ...(recordedId ? { _id: recordedId } : {}),
    user: order.user, type: 'order_payment', referenceType: 'order', referenceId: id(order),
    direction: 'debit', status: 'completed', currency: order.currency,
    idempotencyKey: `wallet-order:${id(order)}` }).session(session).lean();
  if (!debit || minor(debit.amount) !== expected) throw invalid();
  if ((await WalletTransaction.updateOne({ _id: debit._id }, { $inc: { __v: 1 } }, { session })).matchedCount !== 1) throw invalid();
  const provenance = debit.metadata?.fundingProvenance;
  if (provenance !== undefined && !Array.isArray(provenance)) throw invalid();
  let tracked = 0;
  const sources = new Map();
  for (const lot of provenance || []) {
    if (lot?.sourceType !== 'wallet_top_up' || !/^[a-f0-9]{24}$/i.test(lot.sourceTransactionId || '')
        || !Number.isSafeInteger(lot.amountMinor) || lot.amountMinor <= 0
        || !Number.isSafeInteger(tracked + lot.amountMinor) || (lot.orderId && id(lot.orderId) !== id(order))) throw invalid();
    tracked += lot.amountMinor;
    const sourceId = lot.sourceTransactionId.toLowerCase();
    sources.set(sourceId, (sources.get(sourceId) || 0) + lot.amountMinor);
  }
  const untracked = debit.metadata?.untrackedFundingMinor;
  if (Number(order.sellerCurrencyMoneyVersion) >= 2 && untracked === undefined) throw invalid();
  if (tracked > expected || (untracked !== undefined && (!Number.isSafeInteger(untracked)
      || untracked < 0 || tracked + untracked !== expected))) throw invalid();
  // Legacy/admin-funded balances remain usable; their owned durable debit is
  // still mandatory. Never silently discard an invalid tracked funding lot.
  for (const sourceId of [...sources.keys()].sort()) {
    const source = await WalletTransaction.findById(sourceId).session(session).lean();
    if (!source || id(source.user) !== id(order.user) || source.direction !== 'credit' || source.status !== 'completed'
        || source.currency !== order.currency || !['top_up', 'return_refund'].includes(source.type)
        || (source.type === 'return_refund' && source.metadata?.cardRefundFunding !== true)
        || sources.get(sourceId) > minor(source.amount)) throw invalid();
    if ((await WalletTransaction.updateOne({ _id: source._id }, { $inc: { __v: 1 } }, { session })).matchedCount !== 1) throw invalid();
    const safepaySource = !!(source.safepayPaymentId || source.safepayEnvironment || source.safepayTrackerId
      || ['safepay_payment', 'safepay_refund'].includes(source.referenceType)
      || source.metadata?.provider === 'safepay' || source.metadata?.safepayPaymentId
      || source.metadata?.fundingProviderPurpose === 'return_settlement');
    if (safepaySource) {
      if (!mongoose.isValidObjectId(source.safepayPaymentId)) throw invalid();
      const payment = await Payment.findById(source.safepayPaymentId).session(session).lean();
      await healthyPayment(payment, session);
      await bindCardFundedCredit(source, payment, session);
    }
  }
}

async function assertOrderFulfillmentFunding({ order, sellerIds, session }) {
  if (!session?.inTransaction?.()) throw invalid();
  if (order.paymentMethod === 'cash_on_delivery') return;
  const sellers = [...new Set((sellerIds || []).map(id).filter(Boolean))].sort();
  if (!sellers.length || sellers.some(seller => !mongoose.isValidObjectId(seller))) throw invalid();
  for (const seller of sellers) {
    const lock = await SellerLock.findOneAndUpdate({ seller }, { $inc: { version: 1 } }, { upsert: true, new: true, session });
    if (!Number.isSafeInteger(lock?.version) || lock.version <= 0) throw invalid();
  }
  let expected;
  try { expected = expectedOrderMinor(order); } catch (_) { throw invalid(); }
  if (expected === 0) {
    if (!isNoChargeOnlineOrder(order) || order.isPaid !== true || order.awaitingPayment !== false
        || order.paymentSetupState !== 'complete' || !order.paymentFulfilledAt || !order.inventoryCommitted) throw invalid();
    return;
  }
  if (order.paymentMethod === 'safepay') {
    if (!mongoose.isValidObjectId(order.safepayPaymentId)) throw invalid();
    const payment = await Payment.findById(order.safepayPaymentId).session(session).lean();
    if (!payment) throw invalid();
    try { assertSafepayOrderBinding(order, payment, expected); } catch (_) { throw invalid(); }
    await healthyPayment(payment, session);
  } else if (order.paymentMethod === 'wallet') {
    await walletAuthority(order, expected, session);
  } else if (order.paymentMethod !== 'stripe') {
    throw invalid();
  }
  // Retain the dormant Stripe implementation without making provider calls.
  // Its existing risk ledger and all tracked Wallet sources still gate dispatch.
  try { await assertWalletOrderFundingReturnable({ orderId: order._id, session }); }
  catch (error) {
    if (['RETURN_EXTERNAL_FUNDING_REVERSAL', 'RETURN_EXTERNAL_FUNDING_REFUND_REVIEW'].includes(error.code)) throw reversed();
    throw invalid();
  }
  const hold = await RiskHold.exists({ seller: { $in: sellers }, status: 'pending', sourceType: 'order_payment',
    $or: [{ sourceReferenceId: id(order) }, ...(order.safepayPaymentId ? [{ sourceReferenceId: id(order.safepayPaymentId) }] : [])] }).session(session);
  const reversal = await BalanceTransaction.exists({ seller: { $in: sellers }, type: 'reversal', direction: 'debit', status: { $in: ['reserved', 'completed'] },
    'metadata.sourceType': 'order_payment', 'metadata.sourceReferenceId': id(order),
    $or: [{ sourceAmount: { $gt: 0 } }, { amountUSD: { $gt: 0 } }] }).session(session);
  if (hold || reversal) throw reversed();
}

module.exports = { assertOrderFulfillmentFunding };
