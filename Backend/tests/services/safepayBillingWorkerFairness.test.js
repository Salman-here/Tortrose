'use strict';
// Real MongoDB, invoice lifecycle, payment service and provider adapter.
// Only outbound HTTP is controlled; no captured/applied flag is forced.
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../../models/User');
const Store = require('../../models/Store');
const Sub = require('../../models/SellerSubscription');
const Operation = require('../../models/SafepayBillingOperation');
const Payment = require('../../models/SafepayPayment');
const Customer = require('../../models/SafepayCustomer');
const lifecycle = require('../../services/safepayBillingLifecycleService');
const billing = require('../../services/safepayBillingService');
const payments = require('../../services/safepayPaymentService');
const { createSafepayClient } = require('../../services/safepayClient');
const oldEnv = { ...process.env };
let replica, submit, http, trackers, modes, captures, postCounts, due, serial, beforeCharge;

beforeAll(async () => {
  Object.assign(process.env, { SAFEPAY_ENV: 'sandbox', SAFEPAY_WEB_ENABLED: 'true', SAFEPAY_MOBILE_ENABLED: 'true',
    SAFEPAY_SANDBOX_PUBLIC_KEY: 'sec_worker-fairness', SAFEPAY_SANDBOX_SECRET_KEY: 'private-worker-fairness',
    SAFEPAY_SANDBOX_WEBHOOK_SECRET: 'private-worker-fairness-webhook', SAFEPAY_SANDBOX_WEBHOOK_SCHEME: 'sha512-raw' });
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
  const realService = payments.createSafepayPaymentService({
    clientFor: config => createSafepayClient({ config, fetchImpl: (...args) => http(...args) }),
  });
  submit = jest.spyOn(payments, 'submitRecurringPayment').mockImplementation(id => realService.submitRecurringPayment(id));
}, 120000);

afterAll(async () => { submit.mockRestore(); process.env = oldEnv; await mongoose.disconnect(); await replica?.stop(); });
beforeEach(async () => {
  for (const model of Object.values(mongoose.models)) await model.deleteMany({});
  trackers = new Map(); modes = new Map(); captures = []; postCounts = new Map(); serial = 0; beforeCharge = null;
  due = new Date(Date.now() - 60000); submit.mockClear();
  http = jest.fn(async (url, options) => {
    const path = new URL(url).pathname;
    const ok = data => ({ ok: true, status: 200, json: async () => ({ data }) });
    if (path === '/order/payments/v3/' && options.method === 'POST') {
      const value = JSON.parse(options.body), token = `track_worker-fairness-${trackers.size + 1}`;
      const tracker = { token, client: value.merchant_api_key, environment: 'sandbox', mode: value.mode,
        entry_mode: value.entry_mode, customer: value.user, metadata: value.metadata, state: 'TRACKER_STARTED',
        purchase_totals: { quote_amount: { amount: value.amount, currency: value.currency } } };
      trackers.set(token, tracker); return ok({ tracker });
    }
    if (path.startsWith('/reporter/api/v1/payments/') && options.method === 'GET') {
      const tracker = trackers.get(path.split('/').pop());
      if (modes.get(tracker?.customer) === 'read_failure') throw new Error('Provider temporarily unavailable');
      return ok({ tracker });
    }
    if (path.includes('/wallet/')) {
      const parts = path.split('/');
      return ok({ token: parts.at(-1), customer: parts.at(-3), merchant_api_key: 'sec_worker-fairness',
        is_deleted: false, max_usage: -1, expires_at: { seconds: Math.floor(Date.now() / 1000) + 86400000 },
        cybersource: { token: 'qa-network-token', last_four: '1111' } });
    }
    if (path.startsWith('/order/payments/v3/') && options.method === 'POST') {
      const tracker = trackers.get(path.split('/').pop()), mode = modes.get(tracker.customer);
      postCounts.set(tracker.token, (postCounts.get(tracker.token) || 0) + 1);
      if (beforeCharge) await beforeCharge(tracker);
      if (mode === 'declined') return { ok: false, status: 402, json: async () => ({ status: { errors: ['Declined'] } }) };
      if (mode === 'unknown') throw new Error('Response lost before outcome is known');
      tracker.state = 'TRACKER_ENDED';
      tracker.charge = { amount: tracker.purchase_totals.quote_amount, capture: { totals: tracker.purchase_totals.quote_amount } };
      captures.push({ tracker: tracker.token, ...tracker.purchase_totals.quote_amount });
      if (mode === 'unknown_paid') throw new Error('Capture completed, response lost');
      return ok({ tracker });
    }
    throw new Error(`Unexpected fixture provider route: ${path}`);
  });
});

async function fixture(mode = 'success', extra = {}) {
  const n = ++serial;
  const seller = await User.create({ username: `Fair Worker ${n}`, email: `fair-worker-${n}@example.com`, role: 'seller', status: 'active' });
  await Store.create({ seller: seller._id, storeName: `Fair Worker ${n}`, storeSlug: `fair-worker-${n}`,
    productCurrency: 'PKR', productCurrencyStatus: 'active', isActive: true, moderationStatus: 'approved' });
  const customerId = `cus_worker-fairness-${n}`, cardId = `pm_worker-fairness-${n}`;
  await Customer.create({ user: seller._id, environment: 'sandbox', customerId, status: 'ready' });
  modes.set(customerId, mode);
  const sub = await Sub.create({ seller: seller._id, status: 'active', plan: 'starter', planName: 'Rozare Starter',
    currentPeriodStart: new Date(due.getTime() - 30 * 86400000), currentPeriodEnd: due,
    hasUsedFreePeriod: true, starterBonusPeriodUsed: true,
    safepayBilling: { environment: 'sandbox', contractId: `fair-worker-contract-${n}`, autoRenew: true,
      customerId, cardId, version: 1, monthlyMinor: 999, creditMinor: 0, cycle: 0,
      anchorAt: due, nextChargeAt: due, consentVersion: billing.CONSENT_VERSION, consentedAt: new Date(due.getTime() - 86400000), ...extra },
    billingProvider: 'safepay' });
  return { seller, sub, customerId };
}

async function omitScheduling(model, filter, prefix = '') {
  await model.collection.updateMany(filter, { $unset: Object.fromEntries(
    ['workerNextAttemptAt', 'workerLastAttemptAt', 'workerAttempts', 'workerLeaseToken', 'workerLeaseUntil']
      .map(name => [`${prefix}${name}`, ''])) });
}

test('26th and 31st due sellers renew despite 25 older unknown invoices, including missing legacy scheduling fields and restart', async () => {
  const rows = [];
  for (let n = 0; n < 31; n++) rows.push(await fixture(n < 25 ? 'unknown' : 'success'));
  await omitScheduling(Sub, {}, 'safepayBilling.');
  await lifecycle.runBillingWorker();
  expect(await Operation.countDocuments({ status: 'awaiting_payment' })).toBe(25);
  expect(await Operation.countDocuments()).toBe(25);
  // A new worker instance represents a restarted process; history is durable.
  await lifecycle.createBillingWorker()();
  expect(captures).toHaveLength(6);
  expect((await Sub.findById(rows[25].sub._id)).status).toBe('active');
  expect((await Sub.findById(rows[30].sub._id)).status).toBe('active');
  expect(await Operation.countDocuments()).toBe(31);
  expect(await Payment.countDocuments()).toBe(31);
  expect([...postCounts.values()].every(count => count === 1)).toBe(true);
  const unknown = await Operation.find({ status: 'awaiting_payment' });
  expect(unknown.every(op => op.workerAttempts === 1 && op.workerNextAttemptAt > new Date())).toBe(true);
  expect(unknown.every(op => op.terms.dueMinor === 999 && op.terms.periodStart.getTime() === due.getTime() && op.terms.cycle === 0)).toBe(true);
}, 90000);

test('more than both batch sizes of existing accepted invoices drain fairly without replaying old unknown captures', async () => {
  const rows = [];
  for (let n = 0; n < 31; n++) { const row = await fixture(n < 20 ? 'unknown' : 'success'); rows.push(row); await lifecycle.queueRenewal(row.sub._id); }
  await omitScheduling(Operation, {});
  await lifecycle.runBillingWorker();
  expect(submit).toHaveBeenCalledTimes(20);
  expect(captures).toHaveLength(0);
  await lifecycle.createBillingWorker()();
  expect(captures).toHaveLength(11);
  expect(submit).toHaveBeenCalledTimes(31);
  expect((await Sub.findById(rows.at(-1).sub._id)).status).toBe('active');
  const first = await Operation.findOne({ subscription: rows[0].sub._id });
  const frozen = JSON.stringify(first.terms);
  await Operation.updateMany({ status: 'awaiting_payment' }, { $set: { workerNextAttemptAt: new Date(Date.now() - 1) } });
  await lifecycle.createBillingWorker()();
  expect([...postCounts.values()].every(count => count === 1)).toBe(true);
  const retried = await Operation.findById(first._id);
  expect(retried.workerAttempts).toBe(2); expect(JSON.stringify(retried.terms)).toBe(frozen);
  expect(retried.workerNextAttemptAt.getTime() - Date.now()).toBeGreaterThan(50000);
}, 90000);

test('separate concurrent workers claim each invoice once, and same-process overlap is also fenced', async () => {
  for (let n = 0; n < 26; n++) await lifecycle.queueRenewal((await fixture('unknown')).sub._id);
  const first = lifecycle.createBillingWorker(), second = lifecycle.createBillingWorker();
  await Promise.all([first(), first(), second()]);
  await lifecycle.createBillingWorker()();
  expect(await Operation.countDocuments({ workerAttempts: 1 })).toBe(26);
  expect(submit).toHaveBeenCalledTimes(26);
  expect(trackers.size).toBe(26);
  expect([...postCounts.values()].every(count => count === 1)).toBe(true);
}, 90000);

test('due subscription leases prevent competing workers from creating or dispatching a duplicate cycle', async () => {
  for (let n = 0; n < 26; n++) await fixture('unknown');
  await Promise.all([lifecycle.createBillingWorker()(), lifecycle.createBillingWorker()()]);
  await lifecycle.createBillingWorker()();
  expect(await Operation.countDocuments()).toBe(26);
  expect(await Payment.countDocuments()).toBe(26);
  expect(trackers.size).toBe(26);
  expect([...postCounts.values()].every(count => count === 1)).toBe(true);
}, 90000);

test('active claims survive restart; an expired claim is reclaimed without another capture request', async () => {
  const row = await fixture('unknown'), op = await lifecycle.queueRenewal(row.sub._id);
  await lifecycle.runBillingWorker();
  await Operation.updateOne({ _id: op._id }, { $set: { workerNextAttemptAt: new Date(Date.now() - 1),
    workerLeaseToken: 'crashed-worker-claim', workerLeaseUntil: new Date(Date.now() + 60000) } });
  submit.mockClear();
  await lifecycle.createBillingWorker()(); expect(submit).not.toHaveBeenCalled();
  await Operation.updateOne({ _id: op._id }, { $set: { workerLeaseUntil: new Date(Date.now() - 1) } });
  await lifecycle.createBillingWorker()();
  expect(submit).toHaveBeenCalledTimes(1);
  expect([...postCounts.values()]).toEqual([1]);
  expect((await Operation.findById(op._id)).workerAttempts).toBe(2);
});

test('subscription claims are also durable and an expired pre-invoice lease resumes exactly one anchored cycle', async () => {
  const row = await fixture();
  await Sub.updateOne({ _id: row.sub._id }, { $set: { 'safepayBilling.workerLeaseToken': 'crashed-before-invoice',
    'safepayBilling.workerLeaseUntil': new Date(Date.now() + 60000) } });
  await lifecycle.createBillingWorker()();
  expect(await Operation.countDocuments()).toBe(0);
  await Sub.updateOne({ _id: row.sub._id }, { $set: { 'safepayBilling.workerLeaseUntil': new Date(Date.now() - 1) } });
  await lifecycle.createBillingWorker()(); await lifecycle.createBillingWorker()();
  expect(captures).toHaveLength(1); expect(await Operation.countDocuments()).toBe(1);
  expect((await Sub.findById(row.sub._id)).safepayBilling.cycle).toBe(1);
});

test('the billing transaction fence preserves the scheduler lease until dispatch finishes and CAS cleanup clears it', async () => {
  const row = await fixture();
  let claim;
  beforeCharge = async () => {
    claim = await Sub.findById(row.sub._id).select('+safepayBilling.workerLeaseToken');
    const publicRead = await Sub.findById(row.sub._id).lean();
    expect(publicRead.safepayBilling).not.toHaveProperty('workerLeaseToken');
    const pending = await Operation.findOne({ subscription: row.sub._id });
    expect(await billing.operationStatus(row.seller._id, pending._id)).not.toHaveProperty('workerLeaseToken');
  };
  await lifecycle.runBillingWorker();
  expect(claim.safepayBilling.workerLeaseToken).toEqual(expect.any(String));
  expect(claim.safepayBilling.workerLeaseUntil.getTime()).toBeGreaterThan(Date.now());
  const current = await Sub.findById(row.sub._id).select('+safepayBilling.workerLeaseToken');
  expect(current.safepayBilling.workerLeaseToken).toBeNull();
  expect(current.safepayBilling.workerLeaseUntil).toBeNull();
  expect(current.safepayBilling.workerNextAttemptAt).toBeNull();
  expect(current.safepayBilling.workerAttempts).toBe(0);
  expect(captures).toHaveLength(1);
});

test('new invoices cannot always outrank an older due reconciliation just because scheduling fields are missing', async () => {
  const old = await fixture('unknown'), first = await lifecycle.queueRenewal(old.sub._id);
  await lifecycle.runBillingWorker();
  await Operation.updateOne({ _id: first._id }, { $set: { workerNextAttemptAt: new Date(Date.now() - 120000) } });
  for (let n = 0; n < 21; n++) {
    const op = await lifecycle.queueRenewal((await fixture('unknown')).sub._id);
    await omitScheduling(Operation, { _id: op._id });
  }
  submit.mockClear(); await lifecycle.createBillingWorker()();
  expect(String(submit.mock.calls[0][0])).toBe(String(first.payment));
  expect(submit).toHaveBeenCalledTimes(20);
  expect((await Operation.findById(first._id)).workerAttempts).toBe(2);
  await lifecycle.createBillingWorker()();
  expect(await Operation.countDocuments({ workerAttempts: { $gte: 1 } })).toBe(22);
  expect([...postCounts.values()].every(count => count === 1)).toBe(true);
}, 90000);

test('late capture discovered after restart applies the same pending invoice once without shifting its frozen period', async () => {
  const row = await fixture('unknown'), op = await lifecycle.queueRenewal(row.sub._id);
  await lifecycle.runBillingWorker();
  // The external provider eventually finishes the original capture.
  const tracker = [...trackers.values()][0];
  tracker.state = 'TRACKER_ENDED';
  tracker.charge = { amount: tracker.purchase_totals.quote_amount, capture: { totals: tracker.purchase_totals.quote_amount } };
  await Operation.updateOne({ _id: op._id }, { $set: { workerNextAttemptAt: new Date(Date.now() - 1) } });
  await lifecycle.createBillingWorker()(); await lifecycle.createBillingWorker()();
  const current = await Sub.findById(row.sub._id), applied = await Operation.findById(op._id);
  expect(applied.status).toBe('applied'); expect([...postCounts.values()]).toEqual([1]);
  expect(current.safepayBilling.cycle).toBe(1);
  expect(current.currentPeriodStart).toEqual(new Date(op.terms.periodStart));
  expect(current.currentPeriodEnd).toEqual(new Date(op.terms.periodEnd));
  expect(await Payment.countDocuments()).toBe(1); expect(await Operation.countDocuments()).toBe(1);
});

test('unknown reads and malformed due subscription terms back off, while an eligible tail still runs', async () => {
  const broken = [];
  for (let n = 0; n < 25; n++) {
    const row = await fixture('success'); broken.push(row);
    // Deliberately invalid old terms exercise the actual error branch.
    await Sub.collection.updateOne({ _id: row.sub._id }, { $unset: { 'safepayBilling.anchorAt': '' } });
  }
  const tail = await fixture('success');
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try { await lifecycle.runBillingWorker(); await lifecycle.createBillingWorker()(); }
  finally { log.mockRestore(); }
  expect(captures).toHaveLength(1);
  expect((await Sub.findById(tail.sub._id)).status).toBe('active');
  expect((await Sub.findById(broken[0].sub._id)).safepayBilling.workerNextAttemptAt > new Date()).toBe(true);
  const readFailure = await fixture('read_failure'); await lifecycle.queueRenewal(readFailure.sub._id);
  const failureLog = jest.spyOn(console, 'error').mockImplementation(() => {});
  try { await lifecycle.runBillingWorker(); await lifecycle.runBillingWorker(); }
  finally { failureLog.mockRestore(); }
  const op = await Operation.findOne({ subscription: readFailure.sub._id });
  expect(op.workerAttempts).toBe(1); expect(op.workerNextAttemptAt > new Date()).toBe(true);
  expect(op.status).toBe('awaiting_payment');
}, 90000);

test('retry backoff is bounded and never shifts the cycle, amount, consent or captured period', async () => {
  const row = await fixture('unknown'), op = await lifecycle.queueRenewal(row.sub._id);
  await lifecycle.runBillingWorker();
  const before = await Operation.findById(op._id);
  await Operation.updateOne({ _id: op._id }, { $set: { workerAttempts: 9, workerNextAttemptAt: new Date(Date.now() - 1) } });
  const started = Date.now(); await lifecycle.createBillingWorker()();
  const current = await Operation.findById(op._id);
  expect(current.workerNextAttemptAt.getTime() - started).toBeGreaterThanOrEqual(15 * 60000);
  expect(current.workerNextAttemptAt.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60000);
  expect(current.terms).toEqual(before.terms);
  expect(current.sourceVersion).toBe(before.sourceVersion); expect(current.consentVersion).toBe(before.consentVersion);
  expect([...postCounts.values()]).toEqual([1]);
});

test('cancellation before dispatch stops an invoice; after an unknown dispatch only reconciliation is allowed', async () => {
  const before = await fixture(), beforeOp = await lifecycle.queueRenewal(before.sub._id);
  await lifecycle.cancel(before.seller._id); await lifecycle.runBillingWorker();
  expect((await Operation.findById(beforeOp._id)).status).toBe('cancelled'); expect(trackers.size).toBe(0);
  const after = await fixture('unknown'), afterOp = await lifecycle.queueRenewal(after.sub._id);
  await lifecycle.runBillingWorker(); await lifecycle.cancel(after.seller._id);
  await Operation.updateOne({ _id: afterOp._id }, { $set: { workerNextAttemptAt: new Date(Date.now() - 1) } });
  await lifecycle.createBillingWorker()();
  expect([...postCounts.values()]).toEqual([1]);
  expect((await Sub.findById(after.sub._id)).safepayBilling.autoRenew).toBe(false);
});

test('credit-only renewal, period-ending cancellation and suspended accounts do not submit a payment', async () => {
  const credit = await fixture('success', { creditMinor: 999 });
  const cancelled = await fixture(); await lifecycle.cancel(cancelled.seller._id);
  const held = await fixture(); await Sub.updateOne({ _id: held.sub._id }, { $set: { 'paymentRisk.suspended': true } });
  await lifecycle.runBillingWorker();
  expect(submit).not.toHaveBeenCalled(); expect(trackers.size).toBe(0);
  const op = await Operation.findOne({ subscription: credit.sub._id });
  expect(op.status).toBe('applied'); expect(op.terms.dueMinor).toBe(0); expect(op.payment).toBeNull();
  expect((await Sub.findById(cancelled.sub._id)).status).toBe('cancelled');
  expect(await Operation.countDocuments({ subscription: held.sub._id })).toBe(0);
});

test('declined and captured-but-response-lost invoices are terminal; worker reruns never silently retry a card', async () => {
  const declined = await fixture('declined'), recovered = await fixture('unknown_paid');
  await lifecycle.runBillingWorker(); await lifecycle.createBillingWorker()();
  const failed = await Operation.findOne({ subscription: declined.sub._id });
  const applied = await Operation.findOne({ subscription: recovered.sub._id });
  expect(failed.status).toBe('failed'); expect(applied.status).toBe('applied');
  const declinedSub = await Sub.findById(declined.sub._id).select('+safepayBilling.workerLeaseToken');
  expect(declinedSub.safepayBilling.nextChargeAt).toBeNull();
  expect(declinedSub.safepayBilling.workerLeaseToken).toBeNull();
  expect(declinedSub.safepayBilling.workerLeaseUntil).toBeNull();
  expect(declinedSub.safepayBilling.workerNextAttemptAt).toBeNull();
  expect(declinedSub.safepayBilling.workerAttempts).toBe(0);
  expect((await Operation.findById(failed._id).select('+workerLeaseToken')).workerLeaseToken).toBeNull();
  expect(failed.workerLeaseUntil).toBeNull();
  expect(failed.workerNextAttemptAt > new Date()).toBe(true);
  expect((await Sub.findById(recovered.sub._id)).safepayBilling.cycle).toBe(1);
  expect(captures).toHaveLength(1); expect([...postCounts.values()]).toEqual([1, 1]);
});

test('an outage spanning the frozen renewal period requires review rather than collecting multiple missed months', async () => {
  const row = await fixture();
  const anchor = new Date(due); anchor.setUTCMonth(anchor.getUTCMonth() - 2);
  await Sub.updateOne({ _id: row.sub._id }, { $set: { 'safepayBilling.anchorAt': anchor,
    'safepayBilling.nextChargeAt': anchor, currentPeriodEnd: anchor } });
  await lifecycle.runBillingWorker(); await lifecycle.createBillingWorker()();
  const current = await Sub.findById(row.sub._id);
  expect(current.safepayBilling.lastFailureCode).toBe('SUBSCRIPTION_MISSED_PERIOD_REVIEW');
  expect(current.safepayBilling.nextChargeAt).toBeNull();
  expect(await Operation.countDocuments()).toBe(0); expect(submit).not.toHaveBeenCalled();
});
