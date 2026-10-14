'use strict';
const Wallet = require('../models/Wallet');
const Transaction = require('../models/WalletTransaction');
const Order = require('../models/Order');
const Payment = require('../models/SafepayPayment');
const Review = require('../models/SafepayPaymentReview');
const Balance = require('../models/SellerBalanceTransaction');
const ReturnRequest = require('../models/ReturnRequest');
const { toMinorUnits, fromMinorUnits } = require('./moneyMath');
const { ensureOrderSellerSettlement, getOrderExchangeRates } = require('./orderMoneyService');
const { freezeFundingSnapshot, consumeBuyerTopUpFunding } = require('./walletPaymentRiskService');
const { refreshWalletPaymentRiskStatus } = require('./walletPaymentLiabilityService');
const { applySellerStripeRiskLedger } = require('./stripeOrderPaymentRiskService');
const id = value => String(value?._id || value || '');
const validMinor = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const fail = message => Object.assign(new Error(message), { code: 'SAFEPAY_REVIEW_FUNDING_UNVERIFIED', statusCode: 409 });
const reasons = new Set([
  'A Safepay-funded payment needs reconciliation. Please contact support.',
  'A card-funded return refund needs payment reconciliation. Please contact support.',
  'A card-funded Wallet refund needs reconciliation. Please contact support.',
]);

const ledgerOptions = (payment, review) => ({ provider: 'safepay', safepayPaymentId: payment._id,
  safepayTrackerId: payment.tracker, safepayEnvironment: payment.environment,
  eventType: 'charge.dispute.closed', disputeId: `safepay-review:${review._id}`, disputeStatus: 'lost',
  disputeTransitionOverride: { terminal: true, resolution: 'lost', terminalTransition: true, ignoredFinancialEvent: false } });

async function sourceCredits(payment, session) {
  const sources = await Transaction.find({ safepayPaymentId: payment._id, direction: 'credit', status: 'completed',
    $or: [{ type: 'top_up' }, { type: 'return_refund', 'metadata.cardRefundFunding': true }] })
    .sort({ completedAt: 1, _id: 1 }).session(session);
  for (const source of sources) {
    const wallet = await Wallet.findById(source.wallet).session(session);
    if (!wallet || id(wallet.user) !== id(source.user) || source.currency !== payment.currency
        || source.safepayEnvironment !== payment.environment || source.safepayTrackerId !== payment.tracker
        || !validMinor(source.metadata?.fundingRemainingMinor) || !validMinor(source.metadata?.fundingOriginalAvailableMinor)
        || source.metadata.fundingRemainingMinor > source.metadata.fundingOriginalAvailableMinor
        || source.metadata.fundingOriginalAvailableMinor > toMinorUnits(source.amount)) throw fail('The Wallet funding source cannot be verified. The review remains held.');
    if (payment.purpose === 'order' && (id(source.user) !== id(payment.user)
        || id(source.metadata?.sourceOrderId) !== id(payment.order))) throw fail('The refunded Wallet credit belongs to a different buyer or order.');
    if (source.type === 'top_up' && (payment.purpose !== 'wallet_top_up' || id(source.user) !== id(payment.user)
        || source.idempotencyKey !== `safepay:${payment.environment}:${payment._id}:wallet-credit`
        || source.referenceType !== 'safepay_payment' || source.referenceId !== payment.tracker
        || toMinorUnits(source.amount) !== payment.amountMinor)) throw fail('The top-up does not match its captured payment.');
    if (source.type === 'return_refund') {
      if (source.referenceType === 'return_request') {
        const request = await ReturnRequest.findOne({ _id: source.referenceId, buyer: source.user,
          currency: source.currency, status: 'returned', 'settlement.walletTransaction': source._id }).session(session);
        if (!request || source.idempotencyKey !== `return-refund:${id(request)}`
            || toMinorUnits(request.refund?.totalAmount) !== toMinorUnits(source.amount)
            || (payment.purpose === 'order' && id(request.order) !== id(payment.order))
            || (payment.purpose === 'return_settlement' && (id(request._id) !== id(payment.returnRequest)
              || id(request.seller) !== id(payment.user) || id(request.settlement.safepayPaymentId) !== id(payment)))) throw fail('The returned Wallet credit has no matching completed refund.');
      } else if (source.referenceType === 'order_cancellation' && payment.purpose === 'order') {
        const cancellation = await require('../models/OrderCancellation').findOne({ _id: source.referenceId,
          payment: payment._id, order: payment.order, buyer: source.user, currency: source.currency,
          environment: payment.environment, refundDestination: 'wallet', refundStatus: 'refunded', walletTransaction: source._id }).session(session);
        if (!cancellation || source.idempotencyKey !== `order-cancellation:${id(cancellation)}:wallet`
            || (cancellation.refundAmountMinor ?? cancellation.amountMinor) !== toMinorUnits(source.amount)) throw fail('The Wallet cancellation refund cannot be verified.');
      } else throw fail('The refunded Wallet credit has an unsupported source.');
    }
  }
  return sources;
}

async function applyOrderTargets({ payment, review, order, targets, sourceReferenceId, session }) {
  const entries = await ensureOrderSellerSettlement(order, { session, requireOrderTotal: true });
  const targetTotal = [...targets.values()].reduce((sum, value) => sum + value, 0);
  if (!validMinor(targetTotal) || entries.some(entry => !validMinor(targets.get(id(entry.seller)) || 0)
      || (targets.get(id(entry.seller)) || 0) > entry.sourceAmountMinor)
      || [...targets.keys()].some(seller => !entries.some(entry => id(entry.seller) === seller))) throw fail('The seller target exceeds its original order funding.');
  if (!targetTotal) return [];
  const result = await applySellerStripeRiskLedger({ ...ledgerOptions(payment, review), session,
    sourceType: sourceReferenceId ? 'wallet_top_up' : 'order_payment', sourceReferenceId: sourceReferenceId || order._id,
    orderId: order._id, orderLabel: `order ${order.orderId}`, sellerEntitlements: entries,
    sourceCurrency: payment.currency, rates: getOrderExchangeRates(order), chargeAmountMinor: payment.amountMinor,
    eventId: `safepay-review:${review._id}:lost:${sourceReferenceId || 'direct'}:${order._id}`,
    disputeExposureMinor: targetTotal, directTrackTargets: true, directSellerTargets: targets });
  return result.sellerImpacts.map(row => ({ seller: row.sellerId, order: order._id, amountMinor: row.sourceAmountMinor }));
}

// Reuse the established Wallet risk policy: unspent/returned buyer principal
// first, then exact seller lots in recorded spend order. No current FX or
// editable seller debit is used. A missing binding aborts the whole transaction.
async function applyCreditLoss({ source, principalMinor, payment, review, session }) {
  const snapshot = await freezeFundingSnapshot({ source, session });
  const buyerTarget = Math.min(principalMinor, snapshot.buyerPrincipalMinor);
  const buyerAllocations = [], sellerAllocations = [];
  if (buyerTarget) {
    const wallet = await Wallet.findById(source.wallet).session(session);
    const collection = await consumeBuyerTopUpFunding({ source, wallet, currency: payment.currency, liabilityMinor: buyerTarget, session });
    source.metadata.fundingOriginalAvailableMinor -= collection.consumedMinor;
    source.markModified('metadata'); await source.save({ session });
    await Transaction.create([{ user: source.user, wallet: source.wallet, type: 'reversal', direction: 'debit', status: 'completed',
      amount: fromMinorUnits(buyerTarget), currency: payment.currency, referenceType: 'safepay_dispute',
      referenceId: id(review), idempotencyKey: `safepay-review:${review._id}:buyer:${source._id}`,
      safepayPaymentId: payment._id, safepayEnvironment: payment.environment, safepayTrackerId: payment.tracker,
      description: 'Bank payment reversal after an admin-reviewed final decision', completedAt: new Date(),
      metadata: { sourceType: 'wallet_top_up', sourcePaymentTransactionId: id(source), sourceTopUpTransactionId: id(source),
        provider: 'safepay', reviewId: id(review), riskTrack: 'dispute', disputeId: `safepay-review:${review._id}`,
        liabilityState: 'final', liabilityMinor: buyerTarget, heldMinor: 0, collectedMinor: collection.consumedMinor,
        writtenOffMinor: 0, outstandingMinor: collection.outstandingMinor } }], { session });
    buyerAllocations.push({ wallet: source.wallet, source: source._id, amountMinor: buyerTarget });
  }
  let remaining = principalMinor - buyerTarget;
  const orderTargets = new Map();
  for (const lot of snapshot.sellerLots) {
    if (!remaining) break;
    const amount = Math.min(remaining, lot.sourceAmountMinor);
    if (!/^[a-f0-9]{24}$/i.test(lot.orderId)) throw fail('The spent Wallet lot has no original order.');
    const targets = orderTargets.get(lot.orderId) || new Map();
    targets.set(lot.seller, (targets.get(lot.seller) || 0) + amount); orderTargets.set(lot.orderId, targets);
    remaining -= amount;
  }
  if (remaining) throw fail('The Wallet funding holders do not cover the bank principal.');
  for (const [orderId, targets] of orderTargets) {
    const order = await Order.findOne({ _id: orderId, user: source.user, paymentMethod: 'wallet', isPaid: true,
      currency: payment.currency }).session(session);
    const debit = order && await Transaction.findOne({ user: source.user, wallet: source.wallet, type: 'order_payment',
      direction: 'debit', status: 'completed', currency: payment.currency, referenceType: 'order', referenceId: id(order) }).session(session);
    if (!order || !debit || toMinorUnits(debit.amount) !== toMinorUnits(order.orderSummary.totalAmount)) throw fail('The spent Wallet lot does not match its owned paid order.');
    sellerAllocations.push(...await applyOrderTargets({ payment, review, order, targets, sourceReferenceId: id(source), session }));
  }
  return { buyerAllocations, sellerAllocations };
}

async function applyFundingLoss({ payment, review, principalMinor, tracker, session }) {
  // Bank refunds are an independent, already-accounted money movement. Do not
  // silently add another full original-principal loss on top of those funds.
  const previous = await Review.find({ payment: payment._id, status: 'lost', _id: { $ne: review._id } }).session(session).lean();
  const recorded = previous.reduce((sum, row) => sum + row.principalMinor, 0);
  if (!validMinor(payment.refundedMinor) || !validMinor(recorded)
      || principalMinor + recorded + payment.refundedMinor > payment.amountMinor) throw fail('This principal overlaps an already recorded bank refund or reversal.');
  // A new loss over previously transferred funding needs the complete live
  // holder history, not a second copy of the first allocation.
  if (recorded) throw fail('A further loss on an already resolved payment needs separate funding reconciliation.');
  if (tracker?.charge?.cybersource_refunds?.length) {
    let evidence;
    try { evidence = require('./safepayRefundService').refundEvidence(tracker, payment, { allowBankReview: true }); } catch (_) { throw fail('Safepay reports a refund that has not been reconciled. Keep the bank review held.'); }
    if (!evidence || evidence.amountMinor !== payment.refundedMinor) throw fail('The provider refund changed. Reconcile it before recording a bank loss.');
  }
  const sources = await sourceCredits(payment, session);
  const buyerAllocations = [], sellerAllocations = [];
  let platformPrincipalMinor = 0;
  if (payment.purpose === 'return_settlement') {
    const request = await ReturnRequest.findOne({ _id: payment.returnRequest, seller: payment.user,
      status: 'returned', currency: payment.currency, 'settlement.safepayPaymentId': payment._id,
      'settlement.safepayEnvironment': payment.environment }).session(session);
    const order = request && await Order.findById(request.order).session(session);
    if (!request || !order || order.currency !== payment.currency || sources.length !== 1
        || id(sources[0].user) !== id(request.buyer) || toMinorUnits(request.refund.totalAmount) !== payment.amountMinor) throw fail('The seller-funded return refund cannot be verified.');
    // The seller still owes the refund they funded by card. The buyer's
    // completed Wallet refund remains valid; do not debit another buyer/seller.
    sellerAllocations.push(...await applyOrderTargets({ payment, review, order,
      targets: new Map([[id(request.seller), principalMinor]]), session }));
  } else if (payment.purpose === 'wallet_top_up') {
    if (sources.length !== 1 || sources[0].type !== 'top_up') throw fail('The captured top-up has no unique completed Wallet credit.');
    const result = await applyCreditLoss({ source: sources[0], principalMinor, payment, review, session });
    buyerAllocations.push(...result.buyerAllocations); sellerAllocations.push(...result.sellerAllocations);
  } else if (payment.purpose === 'order') {
    const order = await Order.findById(payment.order).session(session);
    require('./safepayPaymentFacts').assertSafepayOrderBinding(order, payment,
      require('./stripeOrderPaymentService').getExpectedStripeTotalMinor(order));
    const entries = await ensureOrderSellerSettlement(order, { session, requireOrderTotal: true });
    const sourceTotal = sources.reduce((sum, row) => sum + toMinorUnits(row.amount), 0);
    if (!validMinor(payment.walletRefundMinor) || sourceTotal !== payment.walletRefundMinor) throw fail('The original card-funded Wallet refunds do not reconcile.');
    // When Wallet refunds exist, remove the original seller's *recorded*
    // return debit before following its credit to the current Wallet holders.
    const directTargets = new Map(entries.map(entry => [id(entry.seller), entry.sourceAmountMinor]));
    const cancelled = await require('../models/OrderCancellation').find({ order: order._id, payment: payment._id,
      environment: payment.environment, buyer: payment.user, currency: payment.currency }).session(session).lean();
    let cancelledCardPrincipal = 0, platformCap = 0, removedWalletPrincipal = 0;
    for (const row of cancelled) {
      const seller = id(row.seller), gross = row.amountMinor;
      if (!validMinor(gross) || directTargets.get(seller) !== gross
          || !(order.sellerFulfillment || []).some(value => id(value.seller) === seller && value.status === 'cancelled')) throw fail('The cancelled seller portion cannot be verified.');
      directTargets.set(seller, 0);
      if (row.refundDestination === 'wallet' && row.refundStatus === 'refunded') removedWalletPrincipal += gross;
      else if (row.refundDestination === 'original_card' && row.refundStatus === 'refunded') {
        const refund = row.refundAmountMinor ?? gross, fee = row.deductionMinor || 0;
        if (!validMinor(refund) || !validMinor(fee) || refund + fee !== gross) throw fail('The completed cancellation refund does not reconcile.');
        cancelledCardPrincipal += refund; platformCap += fee;
      } else throw fail('An earlier cancellation refund is still unverified. The review must remain held.');
    }
    const returned = await Balance.find({ order: order._id, status: { $in: ['reserved', 'completed'] },
      $or: [{ type: 'return_refund' }, { type: 'reversal', safepayPaymentId: payment._id, 'metadata.riskTrack': 'refund' }] }).session(session).lean();
    let externalCardPrincipal = 0;
    for (const row of returned) {
      const value = toMinorUnits(row.sourceAmount), seller = id(row.seller), delta = row.direction === 'credit' ? -value : value;
      if (!directTargets.has(seller) || row.sourceCurrency !== payment.currency || row.status !== 'completed') throw fail('The original seller refund debit cannot be verified.');
      directTargets.set(seller, directTargets.get(seller) - delta);
      if (row.type === 'return_refund') removedWalletPrincipal += delta;
      else externalCardPrincipal += delta;
    }
    if (removedWalletPrincipal !== sourceTotal || cancelledCardPrincipal + externalCardPrincipal !== payment.refundedMinor
        || [...directTargets.values()].some(value => !validMinor(value))) throw fail('The prior refunds and original seller deductions do not reconcile.');
    let remaining = principalMinor;
    for (const source of sources) {
      const amount = Math.min(remaining, toMinorUnits(source.amount));
      if (!amount) break;
      const result = await applyCreditLoss({ source, principalMinor: amount, payment, review, session });
      buyerAllocations.push(...result.buyerAllocations); sellerAllocations.push(...result.sellerAllocations); remaining -= amount;
    }
    if (remaining) {
      // Exact proportional allocation preserves the normal multi-seller
      // policy; the remaining weights exclude already returned Wallet funds.
      const { allocateHouseMonotoneMinorUnits } = require('./moneyMath');
      const directTotal = [...directTargets.values()].reduce((sum, value) => sum + value, 0), sellerPrincipal = Math.min(remaining, directTotal);
      if (sellerPrincipal) {
        const targets = allocateHouseMonotoneMinorUnits(sellerPrincipal, [...directTargets].map(([key, weight]) => ({ key, weight })));
        sellerAllocations.push(...await applyOrderTargets({ payment, review, order, targets, session }));
      }
      platformPrincipalMinor = remaining - sellerPrincipal;
      if (platformPrincipalMinor > platformCap) throw fail('The bank principal exceeds the verified remaining funding holders.');
    }
  } else throw fail('This payment purpose has no verified funding allocation.');
  const total = [...sellerAllocations, ...buyerAllocations].reduce((sum, row) => sum + row.amountMinor, platformPrincipalMinor);
  if (total !== principalMinor) throw fail('The calculated holders do not conserve the bank-reported principal.');
  return { buyerAllocations, sellerAllocations, platformPrincipalMinor };
}

async function restoreReviewedWallets(payment, session) {
  const credits = await Transaction.find({ safepayPaymentId: payment._id, direction: 'credit', status: 'completed' }).select('wallet').session(session).lean();
  const wallets = [...new Set(credits.map(row => id(row.wallet)).filter(Boolean))];
  for (const walletId of wallets) {
    const wallet = await Wallet.findById(walletId).session(session);
    if (!wallet || wallet.status !== 'locked' || wallet.lockSource !== 'system' || !reasons.has(wallet.lockedReason)) continue;
    const sources = await Transaction.find({ wallet: walletId, safepayPaymentId: { $ne: null }, direction: 'credit', status: 'completed' }).select('safepayPaymentId').session(session).lean();
    const paymentIds = [...new Set(sources.map(row => id(row.safepayPaymentId)))];
    const otherPending = await Review.exists({ payment: { $in: paymentIds }, status: 'pending' }).session(session);
    const unhealthy = await Payment.exists({ _id: { $in: paymentIds }, $or: [{ riskPending: true },
      { status: { $in: ['manual_review', 'refund_pending'] } }] }).session(session);
    if (otherPending || unhealthy) continue;
    wallet.status = 'active'; wallet.lockSource = null; wallet.lockedReason = ''; await wallet.save({ session });
    await refreshWalletPaymentRiskStatus(wallet._id, session);
  }
}

async function reviewedFundingIsHealthy(payment, orderId, session) {
  if (!payment || payment.status !== 'reversed' || payment.riskPending || !payment.appliedAt || !payment.paidAt) return false;
  const reviews = await Review.find({ payment: payment._id }).session(session).lean();
  if (!reviews.length || reviews.some(row => row.status === 'pending')) return false;
  let total = 0, lost = false;
  for (const row of reviews) {
    if (row.environment !== payment.environment || row.tracker !== payment.tracker || row.currency !== payment.currency
        || row.originalAmountMinor !== payment.amountMinor) return false;
    if (row.status !== 'lost') continue;
    lost = true;
    if (!row.fundingAccounted || row.authority !== 'admin_reviewed_provider_evidence' || !row.resolvedBy || !row.resolvedAt) return false;
    const allocations = [...(row.sellerAllocations || []), ...(row.buyerAllocations || [])];
    if (allocations.some(value => !validMinor(value.amountMinor))
        || !validMinor(row.platformPrincipalMinor ?? 0)
        || allocations.reduce((sum, value) => sum + value.amountMinor, row.platformPrincipalMinor || 0) !== row.principalMinor
        || row.sellerAllocations.some(value => id(value.order) === id(orderId) && value.amountMinor > 0)) return false;
    total += row.principalMinor;
  }
  return lost && validMinor(total) && total + payment.refundedMinor <= payment.amountMinor
    && !(payment.purpose === 'order' && id(payment.order) === id(orderId));
}

module.exports = { applyFundingLoss, restoreReviewedWallets, reviewedFundingIsHealthy };
