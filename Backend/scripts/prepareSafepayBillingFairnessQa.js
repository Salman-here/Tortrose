'use strict';
// Explicit, disposable Sandbox-only backlog fixture. It does not run a worker,
// call a provider, create a user/store, or modify the real seller's agreement.
// Evidence from it is a CONTROLLED SYNTHETIC unresolved backlog, not real
// captured invoices. Only the existing real QA seller's tail renewal is real.
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const Store = require('../models/Store');
const Sub = require('../models/SellerSubscription');
const Operation = require('../models/SafepayBillingOperation');
const Payment = require('../models/SafepayPayment');
const EMAIL = 'rozare-safepay-seller-20260925@mailinator.com';
const JOURNAL = 'qa_safepay_billing_fairness_receipts';
const KIND = 'controlled-synthetic-unresolved-billing-backlog-v1';
const QUIESCE_METHOD = 'task-owned-zero-money-manual-review-v1';
const id = value => String(value?._id || value || '');
const refuse = code => { throw Object.assign(new Error(code), { code }); };

function namespace(value) {
  if (typeof value !== 'string' || !/^qa-billing-fairness-[a-z0-9-]{8,70}$/.test(value)) refuse('QA_FAIRNESS_NAMESPACE_REQUIRED');
  return value;
}
function boundedCount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 31) refuse('QA_FAIRNESS_COUNT_UNSAFE');
  return value;
}
function startupGuard() {
  const config = require('../config/safepay').readSafepayConfig(process.env, { requireWebhook: true });
  if (config.environment !== 'sandbox') refuse('SANDBOX_REQUIRED');
  if (typeof require('../services/safepayBillingLifecycleService').createBillingWorker !== 'function') {
    refuse('QA_FAIRNESS_REPAIRED_WORKER_REQUIRED');
  }
  if (mongoose.connection.readyState !== 1) refuse('QA_FAIRNESS_DATABASE_REQUIRED');
  return config;
}

async function targetGuard(session = null) {
  const seller = await User.findOne({ email: EMAIL, role: 'seller', status: 'active' }).select('_id').session(session).lean();
  if (!seller) refuse('QA_FAIRNESS_APPROVED_SELLER_REQUIRED');
  const sub = await Sub.findOne({ seller: seller._id, billingProvider: 'safepay', 'safepayBilling.environment': 'sandbox' })
    .select('_id seller status currentPeriodEnd safepayBilling.contractId safepayBilling.monthlyMinor safepayBilling.currency '
      + 'safepayBilling.consentVersion safepayBilling.consentedAt safepayBilling.autoRenew safepayBilling.pendingOperation paymentRisk.suspended')
    .session(session).lean();
  const store = await Store.findOne({ seller: seller._id }).select('_id').session(session).lean();
  if (!sub || !store || !['active', 'free_period'].includes(sub.status) || !sub.safepayBilling.autoRenew
    || sub.safepayBilling.pendingOperation || sub.paymentRisk?.suspended || !sub.safepayBilling.contractId
    || !sub.safepayBilling.consentedAt
    || sub.safepayBilling.consentVersion !== require('../services/safepayBillingService').CONSENT_VERSION
    || !Number.isSafeInteger(sub.safepayBilling.monthlyMinor) || sub.safepayBilling.monthlyMinor <= 0
    || sub.safepayBilling.currency !== 'USD') refuse('QA_FAIRNESS_TARGET_NOT_READY');
  // No customer/card/credential fields are selected, copied or emitted.
  return { sellerId: seller._id, subscriptionId: sub._id, contractId: sub.safepayBilling.contractId,
    monthlyMinor: sub.safepayBilling.monthlyMinor, currency: sub.safepayBilling.currency,
    consentVersion: sub.safepayBilling.consentVersion };
}

function buildPlan(runId, count, at = new Date()) {
  namespace(runId); boundedCount(count);
  const acceptedAt = new Date(at.getTime() - 3600000);
  const periodEnd = new Date(acceptedAt); periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
  const triples = [];
  for (let ordinal = 1; ordinal <= count; ordinal++) {
    const sellerId = new mongoose.Types.ObjectId(), subscriptionId = new mongoose.Types.ObjectId();
    const operationId = new mongoose.Types.ObjectId(), paymentId = new mongoose.Types.ObjectId();
    const reference = `${runId}:invoice:${ordinal}`, contractId = `${runId}:contract:${ordinal}`;
    const tag = { namespace: runId, kind: KIND, ordinal };
    const terms = { plan: 'starter', planName: 'Controlled synthetic QA only', currency: 'USD', monthlyMinor: 999,
      grossMinor: 999, dueMinor: 999, cycle: 0, periodStart: acceptedAt, periodEnd,
      sourceContractId: contractId, qaFairness: tag };
    triples.push({ ids: { ordinal, sellerId, subscriptionId, operationId, paymentId },
      sub: { _id: subscriptionId, seller: sellerId, billingProvider: 'safepay', status: 'past_due',
        plan: 'starter', planName: 'Controlled synthetic QA only', blockedReason: `QA_FAIRNESS_ONLY:${runId}`,
        currentPeriodStart: new Date(acceptedAt.getTime() - 30 * 86400000), currentPeriodEnd: acceptedAt,
        safepayBilling: { environment: 'sandbox', contractId, version: 1, autoRenew: true, cycle: 0,
          anchorAt: acceptedAt, nextChargeAt: acceptedAt, monthlyMinor: 999, currency: 'USD', creditMinor: 0,
          customerId: null, cardId: null, consentVersion: 'qa-fairness-never-authorized', consentedAt: null,
          pendingOperation: operationId } },
      op: { _id: operationId, seller: sellerId, subscription: subscriptionId, environment: 'sandbox', kind: 'renewal',
        requestKey: reference, fingerprint: crypto.createHash('sha256').update(JSON.stringify(terms)).digest('hex'),
        sourceVersion: 1, terms, status: 'awaiting_payment', acceptedAt,
        consentVersion: 'qa-fairness-never-authorized', cardId: null, payment: paymentId },
      payment: { _id: paymentId, user: sellerId, environment: 'sandbox', purpose: 'subscription', providerMode: 'subscription',
        reference, requestKey: reference, fingerprint: crypto.createHash('sha256').update(reference).digest('hex'),
        amountMinor: 999, currency: 'USD', customerId: null, cardId: null, status: 'ready',
        tracker: `track_qa-fairness-${crypto.randomUUID()}`, providerState: 'TRACKER_STARTED',
        // Independent barriers: status excludes tracker creation; pre-existing
        // capture intent excludes another authorization even if GET succeeds;
        // null customer/card + deliberately invalid consent deny its binding.
        chargeStartedAt: acceptedAt, chargeOutcome: 'unknown', capturedMinor: 0, refundedMinor: 0,
        walletRefundMinor: 0, appliedAt: null, nextReconcileAt: new Date(at.getTime() + 30 * 60000),
        terms: { billingOperationId: id(operationId), subscriptionId: id(subscriptionId), contractId, qaFairness: tag } },
    });
  }
  return { runId, count, createdAt: at, triples };
}

async function seed({ runId, count = 25 } = {}) {
  startupGuard(); namespace(runId); boundedCount(count);
  const plan = buildPlan(runId, count);
  await mongoose.connection.transaction(async session => {
    const target = await targetGuard(session);
    const existing = await mongoose.connection.collection(JOURNAL).findOne({ _id: runId }, { session });
    if (existing) refuse('QA_FAIRNESS_NAMESPACE_ALREADY_USED');
    const sellerIds = plan.triples.map(row => row.ids.sellerId);
    if (await User.exists({ _id: { $in: sellerIds } }).session(session)
      || await Store.exists({ seller: { $in: sellerIds } }).session(session)) refuse('QA_FAIRNESS_ORPHAN_SCOPE_REQUIRED');
    await mongoose.connection.collection(JOURNAL).insertOne({ _id: runId, kind: KIND, environment: 'sandbox',
      state: 'seeded', count, createdAt: plan.createdAt, target, ids: plan.triples.map(row => row.ids),
      disclosure: 'Controlled synthetic unresolved backlog; no provider payments or user profiles are created.' }, { session });
    await Sub.insertMany(plan.triples.map(row => row.sub), { session });
    await Operation.insertMany(plan.triples.map(row => row.op), { session });
    await Payment.insertMany(plan.triples.map(row => row.payment), { session });
  });
  return inspect(runId);
}

function validJournal(receipt, runId) {
  if (!receipt || receipt._id !== namespace(runId) || receipt.kind !== KIND || receipt.environment !== 'sandbox'
    || !['seeded', 'quiescing', 'quiesced', 'cleaned'].includes(receipt.state) || boundedCount(receipt.count) !== receipt.ids?.length
    || !receipt.target?.sellerId || !receipt.target?.subscriptionId) refuse('QA_FAIRNESS_JOURNAL_UNSAFE');
  const allIds = receipt.ids.flatMap(row => [row.sellerId, row.subscriptionId, row.operationId, row.paymentId]);
  if (allIds.some(value => !mongoose.isObjectIdOrHexString(value))
    || new Set(allIds.map(id)).size !== receipt.count * 4
    || allIds.some(value => [id(receipt.target.sellerId), id(receipt.target.subscriptionId)].includes(id(value)))
    || receipt.ids.some((row, index) => row.ordinal !== index + 1)) refuse('QA_FAIRNESS_JOURNAL_UNSAFE');
  return receipt;
}

async function inspect(runId, session = null) {
  startupGuard(); namespace(runId);
  const receipt = validJournal(await mongoose.connection.collection(JOURNAL).findOne({ _id: runId }, { session }), runId);
  const sellerIds = receipt.ids.map(row => row.sellerId);
  if (await User.exists({ _id: { $in: sellerIds } }).session(session)
    || await Store.exists({ seller: { $in: sellerIds } }).session(session)) refuse('QA_FAIRNESS_ORPHAN_SCOPE_CHANGED');
  const rows = [];
  for (const item of receipt.ids) {
    const sub = await Sub.findById(item.subscriptionId).select('+safepayBilling.cardId +safepayBilling.workerLeaseToken').session(session).lean();
    const op = await Operation.findById(item.operationId).select('+cardId +workerLeaseToken').session(session).lean();
    const payment = await Payment.findById(item.paymentId).select('+cardId +requestKey +processingToken').session(session).lean();
    if (receipt.state === 'cleaned') {
      if (sub || op || payment) refuse('QA_FAIRNESS_CLEANUP_INCOMPLETE');
      continue;
    }
    const tag = value => value?.namespace === runId && value?.kind === KIND && value?.ordinal === item.ordinal;
    const reference = `${runId}:invoice:${item.ordinal}`, contractId = `${runId}:contract:${item.ordinal}`;
    const manualReviewAllowed = receipt.quiesceMethod === QUIESCE_METHOD && receipt.quiesceRequestedAt
      && ['quiescing', 'quiesced'].includes(receipt.state);
    if (!sub || !op || !payment || id(sub.seller) !== id(item.sellerId) || sub.billingProvider !== 'safepay'
      || sub.status !== 'past_due' || sub.blockedReason !== `QA_FAIRNESS_ONLY:${runId}`
      || sub.safepayBilling?.environment !== 'sandbox' || sub.safepayBilling.contractId !== contractId
      || id(sub.safepayBilling.pendingOperation) !== id(item.operationId) || !sub.safepayBilling.autoRenew
      || sub.safepayBilling.customerId || sub.safepayBilling.cardId || sub.safepayBilling.consentedAt
      || sub.safepayBilling.consentVersion !== 'qa-fairness-never-authorized' || sub.safepayBilling.cycle !== 0
      || sub.safepayBilling.monthlyMinor !== 999 || sub.safepayBilling.creditMinor !== 0
      || op.environment !== 'sandbox' || id(op.seller) !== id(item.sellerId) || id(op.subscription) !== id(item.subscriptionId)
      || op.requestKey !== reference || !['awaiting_payment', ...(manualReviewAllowed ? ['manual_review'] : [])].includes(op.status)
      || op.appliedAt || op.cardId
      || id(op.payment) !== id(item.paymentId) || !tag(op.terms?.qaFairness)
      || op.consentVersion !== 'qa-fairness-never-authorized' || op.terms?.dueMinor !== 999
      || payment.environment !== 'sandbox' || id(payment.user) !== id(item.sellerId) || payment.purpose !== 'subscription'
      || payment.providerMode !== 'subscription' || !['ready', ...(manualReviewAllowed ? ['manual_review'] : [])].includes(payment.status)
      || payment.reference !== reference
      || payment.requestKey !== reference || payment.customerId || payment.cardId || !payment.chargeStartedAt
      || payment.chargeOutcome !== 'unknown' || !/^track_qa-fairness-[a-f0-9-]{36}$/.test(payment.tracker || '')
      || payment.currency !== 'USD' || payment.amountMinor !== 999 || payment.capturedMinor !== 0
      || payment.refundedMinor !== 0 || payment.walletRefundMinor !== 0 || payment.appliedAt || payment.paidAt
      || payment.order || payment.store || payment.returnRequest || payment.providerSubscriptionId || payment.providerPlanId
      || payment.riskPending || !tag(payment.terms?.qaFairness)
      || payment.terms?.billingOperationId !== id(item.operationId)
      || payment.terms?.subscriptionId !== id(item.subscriptionId) || payment.terms?.contractId !== contractId) {
      refuse('QA_FAIRNESS_RECORD_INVARIANT_CHANGED');
    }
    const quiesceLatched = !!manualReviewAllowed && op.status === 'manual_review' && payment.status === 'manual_review'
      && !sub.safepayBilling.workerLeaseUntil && !sub.safepayBilling.workerLeaseToken
      && !op.workerLeaseUntil && !op.workerLeaseToken && !payment.leaseUntil && !payment.processingToken;
    rows.push({ ordinal: item.ordinal, operationStatus: op.status, paymentStatus: payment.status,
      workerAttempts: op.workerAttempts || 0, reconcileAttempts: payment.reconcileAttempts || 0,
      unknownCaptureIntent: true, capturedMinor: 0, applied: false, quiesceLatched,
      scheduling: { subscriptionNextAt: sub.safepayBilling.workerNextAttemptAt || null,
        operationNextAt: op.workerNextAttemptAt || null, paymentReconcileAt: payment.nextReconcileAt || null,
        subscriptionLeasePresent: !!(sub.safepayBilling.workerLeaseUntil || sub.safepayBilling.workerLeaseToken),
        operationLeasePresent: !!(op.workerLeaseUntil || op.workerLeaseToken),
        paymentLeasePresent: !!(payment.leaseUntil || payment.processingToken) } });
  }
  return { sandbox: true, namespace: runId, evidenceKind: KIND, state: receipt.state,
    startupMode: { environment: 'sandbox', repairedWorkerModule: true,
      webCheckoutEnabled: process.env.SAFEPAY_WEB_ENABLED === 'true', mobileCheckoutEnabled: process.env.SAFEPAY_MOBILE_ENABLED === 'true' },
    count: receipt.count, targetEmail: EMAIL, targetSubscriptionId: id(receipt.target.subscriptionId),
    orphanProfiles: true, syntheticMoneyCapturedMinor: 0,
    attemptedOperations: rows.filter(row => row.workerAttempts > 0).length,
    attemptedReads: rows.reduce((total, row) => total + row.reconcileAttempts, 0),
    allQuiesced: receipt.state === 'quiesced' && rows.length === receipt.count && rows.every(row => row.quiesceLatched),
    quiesceMethod: receipt.quiesceMethod || null,
    pendingQuiesceTriples: rows.filter(row => !row.quiesceLatched).length, quiesceUntil: receipt.quiesceUntil || null,
    unlatchedSample: rows.filter(row => !row.quiesceLatched).slice(0, 5),
    sample: rows.slice(0, 3) };
}

async function quiesce(runId) {
  startupGuard(); namespace(runId);
  let pendingRows = 0;
  await mongoose.connection.transaction(async session => {
    await inspect(runId, session);
    const receipt = validJournal(await mongoose.connection.collection(JOURNAL).findOne({ _id: runId }, { session }), runId);
    if (receipt.state === 'cleaned') return;
    const at = new Date(), until = receipt.quiesceUntil && new Date(receipt.quiesceUntil) > at
      ? new Date(receipt.quiesceUntil) : new Date(at.getTime() + 7 * 86400000);
    pendingRows = 0;
    for (const row of receipt.ids) {
      // Only idle, token-free TASK-OWNED SYNTHETIC rows enter manual review.
      // This does not touch any real invoice/status or financial amount. Dates
      // alone are insufficient: a previously selected reporter read can later
      // overwrite its retry date. Manual review is excluded from BOTH worker
      // selectors even after that late read, without clearing a live lease.
      const updates = [
        [Operation, { _id: row.operationId, environment: 'sandbox', 'terms.qaFairness.namespace': runId,
          status: { $in: ['awaiting_payment', 'manual_review'] }, workerLeaseUntil: null, workerLeaseToken: null },
        { status: 'manual_review', workerNextAttemptAt: until }],
        [Payment, { _id: row.paymentId, environment: 'sandbox', 'terms.qaFairness.namespace': runId,
          status: { $in: ['ready', 'manual_review'] }, capturedMinor: 0, appliedAt: null, leaseUntil: null, processingToken: { $in: ['', null] } },
        { status: 'manual_review', nextReconcileAt: until }],
        [Sub, { _id: row.subscriptionId, seller: row.sellerId, 'safepayBilling.environment': 'sandbox',
          blockedReason: `QA_FAIRNESS_ONLY:${runId}`, 'safepayBilling.workerLeaseUntil': null,
          'safepayBilling.workerLeaseToken': null }, { 'safepayBilling.workerNextAttemptAt': until }],
      ];
      for (const [model, query, changes] of updates) {
        const result = await model.updateOne(query, { $set: changes }).session(session);
        if (result.matchedCount !== 1) pendingRows += 1;
      }
    }
    await mongoose.connection.collection(JOURNAL).updateOne({ _id: runId, kind: KIND, environment: 'sandbox' },
      { $set: { state: pendingRows ? 'quiescing' : 'quiesced', quiesceUntil: until,
        quiesceMethod: QUIESCE_METHOD,
        quiesceRequestedAt: receipt.quiesceRequestedAt || at, quiesceCheckedAt: at,
        pendingQuiesceRows: pendingRows, zeroMoneyVerifiedBeforeQuiesce: true } }, { session });
  });
  const result = await inspect(runId);
  return { ...result, pendingQuiesceRows: pendingRows,
    quiesceInstruction: !result.allQuiesced && result.state !== 'cleaned' ? 'Current leases were left unchanged. Wait for them to finish, then repeat --quiesce.'
      : 'Only zero-money synthetic op/payment records are in manual review. Run exact-ID --cleanup; live leases remain protected.' };
}

async function cleanup(runId) {
  startupGuard(); namespace(runId);
  await mongoose.connection.transaction(async session => {
    const current = await inspect(runId, session);
    if (current.state === 'cleaned') return;
    if (current.state === 'quiescing' || current.state === 'quiesced' && !current.allQuiesced) refuse('QA_FAIRNESS_QUIESCE_INCOMPLETE');
    const receipt = validJournal(await mongoose.connection.collection(JOURNAL).findOne({ _id: runId }, { session }), runId);
    const manualReview = receipt.quiesceMethod === QUIESCE_METHOD;
    const at = new Date();
    const noLease = path => ({ $or: [{ [path]: null }, { [path]: { $lte: at } }] });
    for (const row of receipt.ids) {
      const deletes = [
        [Operation, { _id: row.operationId, environment: 'sandbox', 'terms.qaFairness.namespace': runId,
          status: manualReview ? 'manual_review' : 'awaiting_payment', ...noLease('workerLeaseUntil') }],
        [Payment, { _id: row.paymentId, environment: 'sandbox', 'terms.qaFairness.namespace': runId,
          status: manualReview ? 'manual_review' : 'ready', capturedMinor: 0, appliedAt: null, ...noLease('leaseUntil') }],
        [Sub, { _id: row.subscriptionId, seller: row.sellerId, 'safepayBilling.environment': 'sandbox',
          blockedReason: `QA_FAIRNESS_ONLY:${runId}`, ...noLease('safepayBilling.workerLeaseUntil') }],
      ];
      for (const [model, query] of deletes) {
        const result = await model.deleteOne(query).session(session);
        if (result.deletedCount !== 1) refuse('QA_FAIRNESS_ACTIVE_LEASE_OR_SCOPE_CHANGED');
      }
    }
    await mongoose.connection.collection(JOURNAL).updateOne({ _id: runId, kind: KIND, environment: 'sandbox', state: { $in: ['seeded', 'quiesced'] } },
      { $set: { state: 'cleaned', cleanedAt: at, zeroMoneyVerifiedBeforeCleanup: true } }, { session });
  });
  return inspect(runId);
}

function parseArgs(args) {
  let action = null, runId, count = 25;
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (seen.has(value)) refuse('QA_FAIRNESS_ARGUMENTS_UNSAFE');
    seen.add(value);
    if (['--seed', '--readback', '--quiesce', '--cleanup', '--dry-run'].includes(value)) {
      if (action) refuse('QA_FAIRNESS_ARGUMENTS_UNSAFE');
      action = value;
    } else if (['--run-id', '--count'].includes(value)) {
      const next = args[++index];
      if (!next || next.startsWith('--')) refuse('QA_FAIRNESS_ARGUMENTS_UNSAFE');
      if (value === '--run-id') runId = namespace(next);
      else { if (!/^[1-9][0-9]?$/.test(next)) refuse('QA_FAIRNESS_COUNT_UNSAFE'); count = boundedCount(Number(next)); }
    } else refuse('QA_FAIRNESS_ARGUMENTS_UNSAFE');
  }
  namespace(runId);
  return { action: action || '--dry-run', runId, count };
}

async function main() {
  require('dotenv').config({ quiet: true });
  const config = require('../config/safepay').readSafepayConfig(process.env, { requireWebhook: true });
  if (config.environment !== 'sandbox') refuse('SANDBOX_REQUIRED');
  const { action, runId, count } = parseArgs(process.argv.slice(2));
  require('node:dns').setServers(['1.1.1.1', '8.8.8.8']);
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
  startupGuard();
  const result = action === '--seed' ? await seed({ runId, count }) : action === '--quiesce' ? await quiesce(runId)
    : action === '--cleanup' ? await cleanup(runId)
    : action === '--readback' ? await inspect(runId) : (await targetGuard(), {
      dryRun: true, sandbox: true, namespace: runId, count, targetEmail: EMAIL, evidenceKind: KIND,
      createsLoginProfiles: false, copiesCardsOrCredentials: false, changesRealAgreement: false, providerCalls: 0,
    });
  console.log(JSON.stringify(result));
}
if (require.main === module) main().catch(error => { console.error(error.code || 'QA_FAIRNESS_FAILED'); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
module.exports = { EMAIL, JOURNAL, KIND, QUIESCE_METHOD, namespace, boundedCount, parseArgs, startupGuard, targetGuard, buildPlan, seed, inspect, quiesce, cleanup };
