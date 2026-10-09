'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../../models/User');
const Store = require('../../models/Store');
const Sub = require('../../models/SellerSubscription');
const Operation = require('../../models/SafepayBillingOperation');
const Payment = require('../../models/SafepayPayment');
const helper = require('../../scripts/prepareSafepayBillingFairnessQa');
const payments = require('../../services/safepayPaymentService');
const lifecycle = require('../../services/safepayBillingLifecycleService');
const { createSafepayClient } = require('../../services/safepayClient');
let replica, seller, target, targetStore;
const previous = { ...process.env };
const RUN = 'qa-billing-fairness-isolated-proof-20261010';
beforeAll(async () => {
  Object.assign(process.env, { SAFEPAY_ENV: 'sandbox', SAFEPAY_WEB_ENABLED: 'true', SAFEPAY_MOBILE_ENABLED: 'true',
    SAFEPAY_SANDBOX_PUBLIC_KEY: 'sec_fairness-harness-test', SAFEPAY_SANDBOX_SECRET_KEY: 'private-fairness-harness-test',
    SAFEPAY_SANDBOX_WEBHOOK_SECRET: 'private-fairness-harness-webhook', SAFEPAY_SANDBOX_WEBHOOK_SCHEME: 'sha512-raw' });
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(replica.getUri());
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
}, 120000);
afterAll(async () => { process.env = previous; await mongoose.disconnect(); await replica?.stop(); });
beforeEach(async () => {
  for (const model of Object.values(mongoose.models)) await model.deleteMany({});
  await mongoose.connection.collection(helper.JOURNAL).deleteMany({});
  seller = await User.create({ username: 'Existing Approved Seller', email: helper.EMAIL, role: 'seller', status: 'active' });
  targetStore = await Store.create({ seller: seller._id, storeName: 'Existing Approved Seller', storeSlug: 'existing-approved-seller',
    isActive: true, moderationStatus: 'approved', productCurrency: 'PKR', productCurrencyStatus: 'active' });
  target = await Sub.create({ seller: seller._id, billingProvider: 'safepay', status: 'active', plan: 'starter',
    currentPeriodStart: new Date(Date.now() - 86400000), currentPeriodEnd: new Date(Date.now() + 28 * 86400000),
    safepayBilling: { environment: 'sandbox', contractId: 'existing-real-qa-contract', monthlyMinor: 999, currency: 'USD',
      autoRenew: true, consentVersion: 'rozare-safepay-recurring-v1', consentedAt: new Date(Date.now() - 86400000),
      customerId: 'cus_existing-real-qa-customer', cardId: 'pm_existing-real-qa-card',
      anchorAt: new Date(Date.now() - 86400000), nextChargeAt: new Date(Date.now() + 28 * 86400000), cycle: 1 } });
});

test('bounded seed has a durable exact-ID journal, no login profiles/stores/cards, and never changes the approved agreement', async () => {
  const before = await Sub.findById(target._id).select('+safepayBilling.cardId').lean();
  const result = await helper.seed({ runId: RUN, count: 25 });
  expect(result).toMatchObject({ sandbox: true, count: 25, evidenceKind: helper.KIND,
    orphanProfiles: true, syntheticMoneyCapturedMinor: 0, attemptedReads: 0, attemptedOperations: 0 });
  expect(await User.countDocuments()).toBe(1); expect(await Store.countDocuments()).toBe(1);
  expect(await Sub.countDocuments()).toBe(26); expect(await Operation.countDocuments()).toBe(25);
  expect(await Payment.countDocuments()).toBe(25);
  expect(await Sub.findById(target._id).select('+safepayBilling.cardId').lean()).toEqual(before);
  expect((await Store.findById(targetStore._id)).isActive).toBe(true);
  const rows = await Payment.find({}).select('+cardId').lean();
  expect(rows.every(row => !row.customerId && !row.cardId && row.chargeStartedAt && row.status === 'ready'
    && row.chargeOutcome === 'unknown' && !row.appliedAt && !row.capturedMinor)).toBe(true);
  const journal = await mongoose.connection.collection(helper.JOURNAL).findOne({ _id: RUN });
  expect(journal.ids).toHaveLength(25);
  const text = JSON.stringify(journal);
  expect(text).not.toContain('pm_existing-real-qa-card'); expect(text).not.toContain('cus_existing-real-qa-customer');
  await helper.cleanup(RUN);
  expect(await Sub.countDocuments()).toBe(1); expect(await Payment.countDocuments()).toBe(0);
}, 60000);

test.each(['404', 'valid_pending'])('real worker and provider adapter issue GET-only calls with %s reporter response', async mode => {
  await helper.seed({ runId: RUN, count: 3 });
  const calls = [];
  const http = async (url, options) => {
    calls.push({ method: options.method, path: new URL(url).pathname });
    if (options.method !== 'GET') throw new Error('Forbidden fixture mutation');
    if (mode === '404') return { ok: false, status: 404, json: async () => ({ status: { errors: ['Not found'] } }) };
    const token = new URL(url).pathname.split('/').pop(), payment = await Payment.findOne({ tracker: token }).lean();
    return { ok: true, status: 200, json: async () => ({ data: { tracker: {
      token, client: 'sec_fairness-harness-test', environment: 'sandbox', mode: 'subscription',
      state: 'TRACKER_STARTED', metadata: { order_id: payment.reference },
      purchase_totals: { quote_amount: { amount: payment.amountMinor, currency: payment.currency } },
    } } }) };
  };
  const real = payments.createSafepayPaymentService({ clientFor: config => createSafepayClient({ config, fetchImpl: http }) });
  const submit = jest.spyOn(payments, 'submitRecurringPayment').mockImplementation(id => real.submitRecurringPayment(id));
  const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  try { await lifecycle.createBillingWorker()(); await lifecycle.createBillingWorker()(); }
  finally { submit.mockRestore(); errors.mockRestore(); }
  expect(calls).toHaveLength(3);
  expect(calls.every(call => call.method === 'GET' && call.path.startsWith('/reporter/api/v1/payments/track_qa-fairness-'))).toBe(true);
  const result = await helper.inspect(RUN);
  expect(result).toMatchObject({ attemptedOperations: 3, attemptedReads: 3, syntheticMoneyCapturedMinor: 0 });
  expect(await Payment.countDocuments({ status: 'paid' })).toBe(0);
  expect(await Operation.countDocuments({ status: 'applied' })).toBe(0);
  expect((await Sub.findById(target._id)).safepayBilling.contractId).toBe('existing-real-qa-contract');
  await helper.cleanup(RUN);
});

test('cleanup touches only its journal IDs, is atomic if a lease is active, and retains a cleanup receipt', async () => {
  await helper.seed({ runId: RUN, count: 2 });
  await helper.seed({ runId: `${RUN}-other`, count: 1 });
  const receipt = await mongoose.connection.collection(helper.JOURNAL).findOne({ _id: RUN });
  await Payment.updateOne({ _id: receipt.ids[1].paymentId }, { $set: { leaseUntil: new Date(Date.now() + 60000) } });
  await expect(helper.cleanup(RUN)).rejects.toMatchObject({ code: 'QA_FAIRNESS_ACTIVE_LEASE_OR_SCOPE_CHANGED' });
  // The first triple was not deleted by the failed transaction.
  expect(await Payment.countDocuments()).toBe(3); expect(await Operation.countDocuments()).toBe(3);
  await Payment.updateOne({ _id: receipt.ids[1].paymentId }, { $set: { leaseUntil: null } });
  expect(await helper.cleanup(RUN)).toMatchObject({ state: 'cleaned', count: 2 });
  expect(await Payment.countDocuments()).toBe(1); expect(await Operation.countDocuments()).toBe(1);
  expect(await Sub.countDocuments()).toBe(2); expect(await User.countDocuments()).toBe(1);
  expect(await helper.cleanup(RUN)).toMatchObject({ state: 'cleaned' });
  expect((await mongoose.connection.collection(helper.JOURNAL).findOne({ _id: RUN })).zeroMoneyVerifiedBeforeCleanup).toBe(true);
  await helper.cleanup(`${RUN}-other`);
});

test('any captured/refunded/applied or profile-scoped mutation refuses cleanup rather than deleting suspicious money', async () => {
  await helper.seed({ runId: RUN, count: 1 });
  const receipt = await mongoose.connection.collection(helper.JOURNAL).findOne({ _id: RUN });
  await Payment.updateOne({ _id: receipt.ids[0].paymentId }, { $set: { capturedMinor: 1 } });
  await expect(helper.cleanup(RUN)).rejects.toMatchObject({ code: 'QA_FAIRNESS_RECORD_INVARIANT_CHANGED' });
  expect(await Payment.countDocuments()).toBe(1);
  await Payment.updateOne({ _id: receipt.ids[0].paymentId }, { $set: { capturedMinor: 0 } });
  await User.create({ _id: receipt.ids[0].sellerId, username: 'Unexpected attached profile', email: 'unexpected@example.com' });
  await expect(helper.cleanup(RUN)).rejects.toMatchObject({ code: 'QA_FAIRNESS_ORPHAN_SCOPE_CHANGED' });
  expect(await Operation.countDocuments()).toBe(1);
});

test('quiesce leaves current leases unchanged, latches idle scheduling after their completion, and permits exact cleanup', async () => {
  await helper.seed({ runId: RUN, count: 1 });
  const beforeTarget = await Sub.findById(target._id).select('+safepayBilling.cardId').lean();
  const receipt = await mongoose.connection.collection(helper.JOURNAL).findOne({ _id: RUN }), row = receipt.ids[0];
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const calls = [];
  const real = payments.createSafepayPaymentService({ clientFor: config => createSafepayClient({ config,
    fetchImpl: async (url, options) => {
      calls.push({ method: options.method, path: new URL(url).pathname });
      entered(); await gate;
      return { ok: false, status: 404, json: async () => ({ status: { errors: ['Not found'] } }) };
    } }) });
  const submit = jest.spyOn(payments, 'submitRecurringPayment').mockImplementation(id => real.submitRecurringPayment(id));
  const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  let running;
  try {
    running = lifecycle.createBillingWorker()(); await started;
    const operation = await Operation.findById(row.operationId).select('+workerLeaseToken').lean();
    const payment = await Payment.findById(row.paymentId).select('+processingToken').lean();
    const first = await helper.quiesce(RUN);
    expect(first).toMatchObject({ state: 'quiescing', allQuiesced: false, pendingQuiesceRows: 2 });
    const untouchedOperation = await Operation.findById(row.operationId).select('+workerLeaseToken').lean();
    const untouchedPayment = await Payment.findById(row.paymentId).select('+processingToken').lean();
    expect(untouchedOperation.workerLeaseToken).toBe(operation.workerLeaseToken);
    expect(untouchedOperation.workerLeaseUntil).toEqual(operation.workerLeaseUntil);
    expect(untouchedOperation.workerNextAttemptAt).toEqual(operation.workerNextAttemptAt);
    expect(untouchedPayment.processingToken).toBe(payment.processingToken);
    expect(untouchedPayment.leaseUntil).toEqual(payment.leaseUntil);
    expect(untouchedPayment.nextReconcileAt).toEqual(payment.nextReconcileAt);
    await expect(helper.cleanup(RUN)).rejects.toMatchObject({ code: 'QA_FAIRNESS_QUIESCE_INCOMPLETE' });
    release(); await running;
    const second = await helper.quiesce(RUN);
    expect(second).toMatchObject({ state: 'quiesced', allQuiesced: true, pendingQuiesceRows: 0, pendingQuiesceTriples: 0 });
    expect(second.quiesceUntil > new Date(Date.now() + 6 * 86400000)).toBe(true);
    await lifecycle.createBillingWorker()(); expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    // The actual secondary worker also respects the latched reconcile date.
    const noOutbound = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('No external provider requests permitted'));
    try {
      await require('../../services/safepayWebhookWorker').runSafepayWebhookWorker();
      expect(noOutbound).not.toHaveBeenCalled();
    } finally { noOutbound.mockRestore(); }
    expect(await Sub.findById(target._id).select('+safepayBilling.cardId').lean()).toEqual(beforeTarget);
    expect(await helper.cleanup(RUN)).toMatchObject({ state: 'cleaned', syntheticMoneyCapturedMinor: 0 });
    expect(await Sub.countDocuments()).toBe(1); expect(await Payment.countDocuments()).toBe(0);
  } finally { release(); await running; submit.mockRestore(); errors.mockRestore(); }
});

test('quiesce is namespace-scoped, survives late scheduling overrides and refuses suspicious money without changing real statuses', async () => {
  await helper.seed({ runId: RUN, count: 1 });
  await helper.seed({ runId: `${RUN}-other`, count: 1 });
  const receipt = await mongoose.connection.collection(helper.JOURNAL).findOne({ _id: RUN });
  const other = await mongoose.connection.collection(helper.JOURNAL).findOne({ _id: `${RUN}-other` });
  const otherBefore = await Payment.findById(other.ids[0].paymentId).lean();
  await helper.quiesce(RUN);
  expect(await Payment.findById(other.ids[0].paymentId).lean()).toEqual(otherBefore);
  // A previously selected worker read may finish after the latching check.
  await Payment.updateOne({ _id: receipt.ids[0].paymentId }, { $set: { nextReconcileAt: new Date(Date.now() + 60000) } });
  // Its task-owned manual-review status survives the old queued read's retry
  // date overwrite, so neither selector can re-enroll it indefinitely.
  expect((await helper.inspect(RUN)).allQuiesced).toBe(true);
  expect((await helper.quiesce(RUN)).allQuiesced).toBe(true);
  await Payment.updateOne({ _id: receipt.ids[0].paymentId }, { $set: { refundedMinor: 1 } });
  await expect(helper.quiesce(RUN)).rejects.toMatchObject({ code: 'QA_FAIRNESS_RECORD_INVARIANT_CHANGED' });
  expect((await Payment.findById(receipt.ids[0].paymentId)).status).toBe('manual_review');
  expect((await Operation.findById(receipt.ids[0].operationId)).status).toBe('manual_review');
});

test('preselected reporter reads cannot re-enroll task-owned manual-review records after quiesce', async () => {
  await helper.seed({ runId: RUN, count: 2 });
  const beforeTarget = await Sub.findById(target._id).select('+safepayBilling.cardId').lean();
  await Payment.updateMany({ 'terms.qaFairness.namespace': RUN }, { $set: { nextReconcileAt: new Date(Date.now() - 1) } });
  const alreadySelected = await Payment.find({ environment: 'sandbox', status: { $in: ['creating', 'ready', 'cancel_requested', 'refund_pending'] },
    nextReconcileAt: { $lte: new Date() } }).sort({ nextReconcileAt: 1 }).limit(10).select('_id');
  expect(alreadySelected).toHaveLength(2);
  expect((await helper.quiesce(RUN)).allQuiesced).toBe(true);
  const lateCalls = [];
  const real = payments.createSafepayPaymentService({ clientFor: config => createSafepayClient({ config,
    fetchImpl: async (url, options) => {
      lateCalls.push({ path: new URL(url).pathname, method: options.method });
      return { ok: false, status: 404, json: async () => ({ status: { errors: ['Not found'] } }) };
    } }) });
  for (const row of alreadySelected) await expect(real.reconcilePayment(row._id)).rejects.toBeTruthy();
  expect(lateCalls).toHaveLength(2); expect(lateCalls.every(call => call.method === 'GET')).toBe(true);
  expect(await Payment.countDocuments({ status: 'manual_review' })).toBe(2);
  expect((await helper.inspect(RUN)).allQuiesced).toBe(true);
  const noOutbound = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('No external requests permitted'));
  try {
    await lifecycle.createBillingWorker()();
    await require('../../services/safepayWebhookWorker').runSafepayWebhookWorker();
    expect(noOutbound).not.toHaveBeenCalled();
  } finally { noOutbound.mockRestore(); }
  expect(await Sub.findById(target._id).select('+safepayBilling.cardId').lean()).toEqual(beforeTarget);
  expect(await helper.cleanup(RUN)).toMatchObject({ state: 'cleaned', syntheticMoneyCapturedMinor: 0 });
});

test('manual-review fixture states are accepted only after a journaled quiesce and never authorize money', async () => {
  await helper.seed({ runId: RUN, count: 1 });
  const receipt = await mongoose.connection.collection(helper.JOURNAL).findOne({ _id: RUN });
  await Payment.updateOne({ _id: receipt.ids[0].paymentId }, { $set: { status: 'manual_review' } });
  await expect(helper.inspect(RUN)).rejects.toMatchObject({ code: 'QA_FAIRNESS_RECORD_INVARIANT_CHANGED' });
  await Payment.updateOne({ _id: receipt.ids[0].paymentId }, { $set: { status: 'ready' } });
  const paused = await helper.quiesce(RUN);
  expect(paused).toMatchObject({ allQuiesced: true, quiesceMethod: helper.QUIESCE_METHOD, syntheticMoneyCapturedMinor: 0 });
  expect(await Payment.countDocuments({ capturedMinor: { $ne: 0 } })).toBe(0);
  expect(await Operation.countDocuments({ appliedAt: { $ne: null } })).toBe(0);
  await helper.cleanup(RUN);
});

test('production, excessive counts, reused namespaces, missing approved seller and tampered journal scope are rejected', async () => {
  await expect(helper.seed({ runId: RUN, count: 32 })).rejects.toMatchObject({ code: 'QA_FAIRNESS_COUNT_UNSAFE' });
  expect(await Payment.countDocuments()).toBe(0);
  await helper.seed({ runId: RUN, count: 1 });
  await expect(helper.seed({ runId: RUN, count: 1 })).rejects.toMatchObject({ code: 'QA_FAIRNESS_NAMESPACE_ALREADY_USED' });
  const original = process.env.SAFEPAY_ENV; process.env.SAFEPAY_ENV = 'production';
  Object.assign(process.env, { SAFEPAY_PRODUCTION_PUBLIC_KEY: 'sec_production-harness-test',
    SAFEPAY_PRODUCTION_SECRET_KEY: 'private-production-harness-test',
    SAFEPAY_PRODUCTION_WEBHOOK_SECRET: 'production-harness-webhook', SAFEPAY_PRODUCTION_WEBHOOK_SCHEME: 'sha512-raw' });
  try { await expect(helper.cleanup(RUN)).rejects.toMatchObject({ code: 'SANDBOX_REQUIRED' }); }
  finally { process.env.SAFEPAY_ENV = original; }
  await mongoose.connection.collection(helper.JOURNAL).updateOne({ _id: RUN }, { $set: { 'ids.0.paymentId': target._id } });
  await expect(helper.cleanup(RUN)).rejects.toMatchObject({ code: 'QA_FAIRNESS_JOURNAL_UNSAFE' });
  await User.updateOne({ _id: seller._id }, { $set: { status: 'blocked' } });
  await expect(helper.seed({ runId: `${RUN}-missing`, count: 1 })).rejects.toMatchObject({ code: 'QA_FAIRNESS_APPROVED_SELLER_REQUIRED' });
  expect(await Payment.countDocuments()).toBe(1);
});

test('CLI defaults to read-only and rejects ambiguous, duplicate, unknown and out-of-range arguments', () => {
  expect(helper.parseArgs(['--run-id', RUN])).toEqual({ action: '--dry-run', runId: RUN, count: 25 });
  expect(helper.parseArgs(['--seed', '--run-id', RUN, '--count', '31'])).toEqual({ action: '--seed', runId: RUN, count: 31 });
  expect(helper.parseArgs(['--quiesce', '--run-id', RUN])).toEqual({ action: '--quiesce', runId: RUN, count: 25 });
  for (const args of [['--seed', '--cleanup', '--run-id', RUN], ['--seed', '--seed', '--run-id', RUN],
    ['--seed', '--anything', '--run-id', RUN], ['--run-id', RUN, '--count', '32'],
    ['--run-id', RUN, '--count', '-1'], ['--run-id', RUN, '--run-id', `${RUN}-second`],
    ['--seed', '--run-id'], ['--seed']]) expect(() => helper.parseArgs(args)).toThrow();
});
