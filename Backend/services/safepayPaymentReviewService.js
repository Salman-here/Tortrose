'use strict';
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Review = require('../models/SafepayPaymentReview');
const Payment = require('../models/SafepayPayment');
const Hold = require('../models/SellerPaymentRiskHold');
const SellerLock = require('../models/SellerSettlementLock');
const User = require('../models/User');
const { readSafepayConfig } = require('../config/safepay');
const { createSafepayClient, readMinor, requireTracker } = require('./safepayClient');
const { runInTransaction } = require('./walletService');
const { applyFundingLoss, restoreReviewedWallets } = require('./safepayPaymentReviewFundingService');

const BANK_STATES = new Set(['TRACKER_DISPUTED', 'TRACKER_REVERSED', 'TRACKER_VOIDED']);
const id = value => String(value?._id || value || '');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, code = 'SAFEPAY_REVIEW_INVALID', statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const objectId = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
const exactMinor = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const bankTrack = review => `dispute:safepay:${review.environment}:${review._id}`;

function captureSnapshot(payment, tracker) {
  const charge = tracker?.charge, capture = charge?.capture;
  if (!payment.appliedAt || !payment.paidAt || payment.amountMinor <= 0
      || payment.capturedMinor !== payment.amountMinor || tracker?.token !== payment.tracker
      || tracker.environment !== payment.environment || tracker.intent !== 'CYBERSOURCE'
      || !/^ch_[a-zA-Z0-9-]{8,100}$/.test(charge?.token || '') || charge.tracker !== payment.tracker
      || charge.amount?.currency !== payment.currency || readMinor(charge.amount.amount) !== payment.amountMinor
      || capture?.tracker !== payment.tracker || !/^cap_[a-zA-Z0-9-]{8,100}$/.test(capture?.token || '')
      || capture.totals?.currency !== payment.currency || readMinor(capture.totals.amount) !== payment.amountMinor
      || charge.balance?.currency !== payment.currency || readMinor(charge.balance.amount) > payment.amountMinor) {
    throw fail('The original captured card payment could not be verified.', 'SAFEPAY_REVIEW_CAPTURE_UNVERIFIED');
  }
  return { state: tracker.state, chargeId: charge.token, captureId: capture.token,
    amountMinor: payment.amountMinor, currency: payment.currency, balanceMinor: readMinor(charge.balance.amount),
    updatedAt: charge.updated_at?.seconds ?? tracker.updated_at?.seconds ?? null,
    // Provider chronology changes invalidate stale decisions, without storing
    // customer/card data or depending on an undocumented won/lost field.
    chronology: hash({ events: tracker.events || [], refunds: charge.cybersource_refunds || [] }) };
}

function publicReview(review, payment) {
  return { _id: id(review), paymentId: id(review.payment), environment: review.environment,
    tracker: review.tracker, purpose: review.purpose, providerState: review.providerState,
    providerFingerprint: review.providerFingerprint, currency: review.currency,
    originalAmountMinor: review.originalAmountMinor, principalMinor: review.principalMinor,
    status: review.status, revision: review.revision, sellers: (review.sellers || []).map(id),
    orders: (review.orders || []).map(id), createdAt: review.createdAt, resolvedAt: review.resolvedAt,
    ...(payment ? { originalPaymentReference: payment.reference } : {}),
    providerUrl: `${review.environment === 'sandbox' ? 'https://sandbox.api.getsafepay.com' : 'https://getsafepay.com'}/dashboard/payments-v3/details-v3/${encodeURIComponent(review.tracker)}` };
}

async function lockSellers(sellers, session) {
  for (const seller of [...new Set(sellers.map(id))].sort()) {
    await SellerLock.findOneAndUpdate({ seller }, { $inc: { version: 1 } }, { upsert: true, new: true, session });
  }
}

async function observeBankReview(payment, tracker, { orders = [], sellers = [], session } = {}) {
  if (!session?.inTransaction?.()) throw fail('Payment review requires an atomic transaction.');
  if (!BANK_STATES.has(tracker?.state) || !['order', 'wallet_top_up', 'return_settlement'].includes(payment.purpose)) return null;
  let snapshot;
  try { snapshot = captureSnapshot(payment, tracker); } catch (_) { return null; }
  const providerFingerprint = hash(snapshot);
  let review = await Review.findOne({ payment: payment._id, providerFingerprint }).session(session);
  let created = false;
  if (review && review.status !== 'pending') {
    const remaining = await Hold.exists({ provider: 'safepay', providerPaymentId: payment.tracker,
      providerEnvironment: payment.environment, status: 'pending' }).session(session);
    if (!remaining) await restoreReviewedWallets(payment, session);
    return { resolved: !remaining, status: review.status === 'won' ? 'paid' : 'reversed', review: publicReview(review) };
  }
  await lockSellers(sellers, session);
  if (!review) {
    review = await Review.findOne({ payment: payment._id, status: 'pending' }).session(session);
    if (review) {
      review.providerFingerprint = providerFingerprint;
      review.providerState = tracker.state;
      review.revision += 1;
      review.sellers = [...new Set([...review.sellers.map(id), ...sellers.map(id)])];
      review.orders = [...new Set([...review.orders.map(id), ...orders.map(id)])];
    }
  }
  if (!review) {
    [review] = await Review.create([{ payment: payment._id, environment: payment.environment,
    tracker: payment.tracker, purpose: payment.purpose, providerFingerprint, providerState: tracker.state,
    chargeId: snapshot.chargeId, currency: payment.currency, originalAmountMinor: payment.amountMinor,
    sellers: [...new Set(sellers.map(id))], orders: [...new Set(orders.map(id))] }], { session });
    created = true;
  }
  const holdIds = [];
  review.sellers = [...new Set([...review.sellers.map(id), ...sellers.map(id)])];
  review.orders = [...new Set([...review.orders.map(id), ...orders.map(id)])];
  for (const seller of sellers) {
    const hold = await Hold.findOneAndUpdate({ seller, eventId: `safepay:${payment.environment}:${payment._id}:review:${review._id}`,
      riskTrackKey: bankTrack(review) }, { $setOnInsert: { provider: 'safepay', providerPaymentId: payment.tracker,
      providerEnvironment: payment.environment, sourceType: payment.purpose === 'wallet_top_up' ? 'wallet_top_up'
        : payment.purpose === 'return_settlement' ? 'return_settlement' : 'order_payment',
      sourceReferenceId: id(payment), eventType: tracker.state, riskTrack: 'dispute', disputeId: id(review),
      unknownExposure: true, status: 'pending' } }, { upsert: true, new: true, session, runValidators: true });
    holdIds.push(hold._id);
  }
  // Adopt only this payment's old BANK-state hold. Never clear a separate
  // refund-review hold, another provider or a newer review generation.
  const legacy = await Hold.find({ provider: 'safepay', providerPaymentId: payment.tracker,
    providerEnvironment: payment.environment, status: 'pending',
    eventId: `safepay:${payment.environment}:${payment._id}:review`, eventType: { $in: [...BANK_STATES] } }).session(session);
  review.holdIds = [...new Set([...review.holdIds.map(id), ...holdIds.map(id), ...legacy.map(id)])];
  await review.save({ session });
  if (created) await require('./safepayPaymentReviewNotificationService').notifyPaymentReview(review, payment, session);
  return { resolved: false, review: publicReview(review) };
}

function resolutionInput(input, review) {
  if (!['won', 'lost'].includes(input?.outcome) || input.confirmedProviderDecision !== true
      || !exactMinor(input.expectedRevision) || input.expectedRevision !== review.revision
      || input.expectedProviderFingerprint !== review.providerFingerprint
      || typeof input.operationKey !== 'string' || !/^[a-zA-Z0-9:_-]{16,160}$/.test(input.operationKey)
      || typeof input.providerCaseReference !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_. /-]{4,159}$/.test(input.providerCaseReference.trim())
      || typeof input.evidenceText !== 'string' || input.evidenceText.trim().length < 40 || input.evidenceText.length > 12000) {
    throw fail('A fresh review, final provider decision, case reference and supporting evidence are required.');
  }
  const principalMinor = input.outcome === 'won' ? 0 : input.bankReportedPrincipalMinor;
  if (!exactMinor(principalMinor) || (input.outcome === 'lost' && (principalMinor <= 0 || principalMinor > review.originalAmountMinor))
      || (input.outcome === 'won' && input.bankReportedPrincipalMinor !== undefined && input.bankReportedPrincipalMinor !== 0)) {
    throw fail('The bank-reported principal must use the original payment currency and cannot exceed the captured payment.', 'SAFEPAY_REVIEW_AMOUNT_INVALID');
  }
  const result = { outcome: input.outcome, principalMinor, providerCaseReference: input.providerCaseReference.trim(),
    evidenceText: input.evidenceText.trim(), operationKey: input.operationKey };
  return { ...result, fingerprint: hash(result) };
}

function createSafepayPaymentReviewService({
  configFor = payment => readSafepayConfig({ ...process.env, SAFEPAY_ENV: payment.environment }),
  clientFor = config => createSafepayClient({ config }), now = () => new Date(),
} = {}) {
  async function refreshReview(reviewId) {
    if (!objectId(reviewId)) throw fail('Invalid payment review identity.', 'SAFEPAY_REVIEW_INVALID', 400);
    const initial = await Review.findById(reviewId).lean();
    if (!initial) throw fail('Payment review was not found.', 'SAFEPAY_REVIEW_NOT_FOUND', 404);
    const payment = await Payment.findById(initial.payment);
    if (!payment || payment.environment !== initial.environment || payment.tracker !== initial.tracker
        || payment.currency !== initial.currency || payment.amountMinor !== initial.originalAmountMinor) throw fail('The review payment binding changed.');
    const config = configFor(payment), tracker = await clientFor(config).getTracker(payment.tracker, payment);
    requireTracker(tracker, { tracker: payment.tracker, reference: payment.reference, amountMinor: payment.amountMinor,
      currency: payment.currency, providerMode: payment.providerMode, providerEntryMode: payment.providerEntryMode,
      customerId: payment.customerId, purpose: payment.purpose }, config);
    const fingerprint = hash(captureSnapshot(payment, tracker));
    return runInTransaction(async session => {
      const current = await Review.findById(reviewId).session(session);
      if (current.status === 'pending' && current.providerFingerprint !== fingerprint) {
        if (current.revision !== initial.revision) throw fail('The review changed. Refresh it again.', 'SAFEPAY_REVIEW_STALE');
        current.providerFingerprint = fingerprint; current.providerState = tracker.state; current.revision += 1;
        await current.save({ session });
      }
      // A provider state alone is never a won/lost authority. Rechecking only
      // refreshes evidence; it neither releases holds nor grants money.
      return publicReview(current, payment);
    });
  }
  async function resolveReview(reviewId, input, actorId) {
    // The immutable case-reference uniqueness boundary must be ready before a
    // financial transaction, including immediately after a new deployment.
    await Review.init();
    if (!objectId(reviewId) || !objectId(actorId)) throw fail('Invalid payment review identity.', 'SAFEPAY_REVIEW_INVALID', 400);
    const actor = await User.findOne({ _id: actorId, role: 'admin', status: { $ne: 'blocked' } }).lean();
    if (!actor) throw fail('Only an active admin can resolve a payment review.', 'SAFEPAY_REVIEW_FORBIDDEN', 403);
    const initial = await Review.findById(reviewId).select('+resolutionKey +resolutionFingerprint').lean();
    if (!initial) throw fail('Payment review was not found.', 'SAFEPAY_REVIEW_NOT_FOUND', 404);
    const validated = resolutionInput(input, { ...initial, revision: input.expectedRevision });
    if (initial.status !== 'pending') {
      if (initial.resolutionKey === validated.operationKey && initial.resolutionFingerprint === validated.fingerprint) return publicReview(initial);
      throw fail('This payment review already has a final audited decision.', 'SAFEPAY_REVIEW_ALREADY_RESOLVED');
    }
    const payment = await Payment.findById(initial.payment);
    if (!payment || payment.environment !== initial.environment || payment.tracker !== initial.tracker
        || payment.currency !== initial.currency || payment.amountMinor !== initial.originalAmountMinor) throw fail('The review payment binding changed.');
    const config = configFor(payment);
    const tracker = await clientFor(config).getTracker(payment.tracker, payment);
    requireTracker(tracker, { tracker: payment.tracker, reference: payment.reference, amountMinor: payment.amountMinor,
      currency: payment.currency, providerMode: payment.providerMode, providerEntryMode: payment.providerEntryMode,
      customerId: payment.customerId, purpose: payment.purpose }, config);
    const snapshot = captureSnapshot(payment, tracker);
    if (hash(snapshot) !== initial.providerFingerprint) throw fail('Safepay changed since this review opened. Recheck the payment before recording a decision.', 'SAFEPAY_REVIEW_STALE');
    return runInTransaction(async session => {
      const review = await Review.findById(reviewId).select('+resolutionKey +resolutionFingerprint').session(session);
      const details = resolutionInput(input, { ...review.toObject(), revision: input.expectedRevision });
      if (review.status !== 'pending') {
        if (review.resolutionKey === details.operationKey && review.resolutionFingerprint === details.fingerprint) return publicReview(review);
        throw fail('This payment review already has a final audited decision.', 'SAFEPAY_REVIEW_ALREADY_RESOLVED');
      }
      if (review.revision !== input.expectedRevision) throw fail('The review changed. Refresh it before resolving.', 'SAFEPAY_REVIEW_STALE');
      const current = await Payment.findById(review.payment).session(session);
      if (!current || current.environment !== review.environment || current.tracker !== review.tracker
          || current.amountMinor !== review.originalAmountMinor || current.currency !== review.currency) throw fail('The original payment binding changed.');
      if (current.leaseUntil && new Date(current.leaseUntil).getTime() > now().getTime()) throw fail('Safepay reconciliation is running. Retry this same review shortly.', 'SAFEPAY_REVIEW_BUSY');
      await lockSellers(review.sellers, session);
      // A write to the original payment shares the reconciler's transaction
      // fence; webhook and withdrawal races must retry, not lose a decision.
      await Payment.updateOne({ _id: current._id }, { $inc: { __v: 1 } }, { session });
      let allocations = [], buyerAllocations = [], platformPrincipalMinor = 0;
      if (details.outcome === 'lost') {
        const result = await applyFundingLoss({ payment: current, review, principalMinor: details.principalMinor, tracker, session });
        allocations = result.sellerAllocations; buyerAllocations = result.buyerAllocations;
        platformPrincipalMinor = result.platformPrincipalMinor;
      }
      const at = now();
      review.status = details.outcome; review.revision += 1; review.principalMinor = details.principalMinor;
      review.providerCaseReference = details.providerCaseReference; review.evidenceText = details.evidenceText;
      review.evidenceFingerprint = hash({ evidence: details.evidenceText, reference: details.providerCaseReference });
      review.resolutionKey = details.operationKey; review.resolutionFingerprint = details.fingerprint;
      review.resolvedBy = actorId; review.resolvedAt = at; review.authority = 'admin_reviewed_provider_evidence';
      review.sellerAllocations = allocations;
      review.buyerAllocations = buyerAllocations; review.fundingAccounted = true;
      review.platformPrincipalMinor = platformPrincipalMinor;
      review.sellers = [...new Set([...review.sellers.map(id), ...allocations.map(row => id(row.seller))])];
      review.orders = [...new Set([...review.orders.map(id), ...allocations.map(row => id(row.order)).filter(Boolean)])];
      const totals = new Map();
      for (const row of allocations) totals.set(id(row.seller), (totals.get(id(row.seller)) || 0) + row.amountMinor);
      review.sellerTotals = [...totals].map(([seller, amountMinor]) => ({ seller, amountMinor }));
      await review.save({ session });
      await Hold.updateMany({ _id: { $in: review.holdIds }, provider: 'safepay', providerPaymentId: current.tracker,
        providerEnvironment: current.environment, status: 'pending', eventType: { $in: [...BANK_STATES] } },
      { $set: { status: 'resolved', resolvedAt: at, resolvedByEventId: `safepay-review:${review._id}:${details.outcome}`,
        resolvedExposureMinor: details.principalMinor } }, { session });
      const remaining = await Hold.exists({ provider: 'safepay', providerPaymentId: current.tracker,
        providerEnvironment: current.environment, status: 'pending' }).session(session);
      await Payment.updateOne({ _id: current._id }, { $set: { riskPending: Boolean(remaining),
        status: remaining ? 'manual_review' : details.outcome === 'won' ? 'paid' : 'reversed',
        nextReconcileAt: new Date(at.getTime() + 24 * 60 * 60000) } }, { session });
      await restoreReviewedWallets(current, session);
      await require('./safepayPaymentReviewNotificationService').notifyPaymentReview(review, current, session);
      return publicReview(review, current);
    });
  }
  return { resolveReview, refreshReview };
}

async function isResolvedBankWin(payment, tracker, session = null) {
  if (payment.riskPending || payment.status !== 'paid') return false;
  let fingerprint;
  try { fingerprint = hash(captureSnapshot(payment, tracker)); } catch (_) { return false; }
  let query = Review.exists({ payment: payment._id, environment: payment.environment, tracker: payment.tracker,
    providerFingerprint: fingerprint, status: 'won', fundingAccounted: true,
    authority: 'admin_reviewed_provider_evidence', resolvedAt: { $ne: null }, resolvedBy: { $ne: null } });
  if (session) query = query.session(session);
  return Boolean(await query);
}
module.exports = { BANK_STATES, captureSnapshot, publicReview, observeBankReview, createSafepayPaymentReviewService, isResolvedBankWin };
