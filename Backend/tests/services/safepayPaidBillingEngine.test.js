'use strict';
// Real MongoDB transactions + the real provider adapter and billing engine.
// Only external HTTP replies are controlled; no paid/failed flags are forced.
const mockOwnedCard = jest.fn();
jest.mock('../../services/safepayCustomerService', () => ({ requireOwnedReusableCard: mockOwnedCard }));
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../../models/User'); const Store = require('../../models/Store');
const Sub = require('../../models/SellerSubscription'); const Operation = require('../../models/SafepayBillingOperation');
const Payment = require('../../models/SafepayPayment'); const Customer = require('../../models/SafepayCustomer');
const Claim = require('../../models/SellerCheckoutClaim'); const Outbox = require('../../models/NotificationOutbox');
const billing = require('../../services/safepayBillingService'); const lifecycle = require('../../services/safepayBillingLifecycleService');
const recovery = require('../../services/safepayBillingRecoveryService'); const payments = require('../../services/safepayPaymentService');
const { createSafepayClient } = require('../../services/safepayClient');
const { readSafepayConfig } = require('../../config/safepay');
let replica, seller, sub, customer, submit, http, mode, trackers, captures, beforeCharge, declineHttpStatus;
const previous = { ...process.env };
beforeAll(async () => {
  Object.assign(process.env, { SAFEPAY_ENV: 'sandbox', SAFEPAY_WEB_ENABLED: 'true', SAFEPAY_MOBILE_ENABLED: 'true',
    SAFEPAY_SANDBOX_PUBLIC_KEY: 'sec_paid-engine', SAFEPAY_SANDBOX_SECRET_KEY: 'private-paid-engine-secret',
    SAFEPAY_SANDBOX_WEBHOOK_SECRET: 'private-paid-engine-webhook', SAFEPAY_SANDBOX_WEBHOOK_SCHEME: 'sha512-raw' });
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(replica.getUri());
  await Promise.all([User, Store, Sub, Operation, Payment, Customer, Claim, Outbox, require('../../models/SafepayRefundEvent')].map(m => m.init()));
  const service = payments.createSafepayPaymentService({ clientFor: config => createSafepayClient({ config, fetchImpl: (...args) => http(...args) }) });
  submit = jest.spyOn(payments, 'submitRecurringPayment').mockImplementation(paymentId => service.submitRecurringPayment(paymentId));
}, 120000);
afterAll(async () => { submit.mockRestore(); process.env = previous; await mongoose.disconnect(); await replica?.stop(); });
beforeEach(async () => {
  for (const model of Object.values(mongoose.models)) await model.deleteMany({});
  mode = 'success'; declineHttpStatus = 403; trackers = new Map(); captures = []; beforeCharge = null; submit.mockClear();
  seller = await User.create({ username: 'Paid Billing Engine QA', email: 'paid-billing-engine@example.com', role: 'seller', status: 'active' });
  await Store.create({ seller: seller._id, storeName: 'Paid Billing Engine QA', storeSlug: 'paid-billing-engine-qa',
    productCurrency: 'PKR', productCurrencyStatus: 'active', isActive: true, moderationStatus: 'approved' });
  sub = await Sub.create({ seller: seller._id, status: 'trial', trialStartDate: new Date(), trialEndDate: new Date(Date.now() + 86400000), hasUsedFreePeriod: true });
  customer = await Customer.create({ user: seller._id, environment: 'sandbox', customerId: 'cus_paid-engine-owned', status: 'ready' });
  mockOwnedCard.mockResolvedValue({ link: customer, card: { token: 'pm_paid-engine-owned' }, config: readSafepayConfig() });
  http = jest.fn(async (url, options) => {
    const path = new URL(url).pathname;
    const ok = data => ({ ok: true, status: 200, json: async () => ({ data }) });
    if (path === '/order/payments/v3/' && options.method === 'POST') {
      const value = JSON.parse(options.body), token = `track_paid-engine-${trackers.size + 1}`;
      const tracker = { token, client: value.merchant_api_key, environment: 'sandbox', mode: value.mode,
        entry_mode: value.entry_mode, customer: value.user, metadata: value.metadata, state: 'TRACKER_STARTED',
        purchase_totals: { quote_amount: { amount: value.amount, currency: value.currency } } };
      trackers.set(token, tracker); return ok({ tracker });
    }
    if (path.startsWith('/reporter/api/v1/payments/') && options.method === 'GET') return ok({ tracker: trackers.get(path.split('/').pop()) });
    if (path.includes('/wallet/')) return ok({ token: 'pm_paid-engine-owned', customer: customer.customerId,
      merchant_api_key: 'sec_paid-engine', is_deleted: false, max_usage: -1,
      expires_at: { seconds: Math.floor(Date.now() / 1000) + 86400000 }, cybersource: { token: 'qa-network-token', last_four: '1111' } });
    if (path.startsWith('/order/payments/v3/') && options.method === 'POST') {
      if (beforeCharge) await beforeCharge();
      if (mode === 'declined') return { ok: false, status: declineHttpStatus, json: async () => ({ status: { errors: ['Declined'] } }) };
      if (mode === 'unknown_pending') throw new Error('Lost provider response');
      const tracker = trackers.get(path.split('/').pop());
      tracker.state = 'TRACKER_ENDED';
      tracker.charge = { amount: tracker.purchase_totals.quote_amount, capture: { totals: tracker.purchase_totals.quote_amount } };
      captures.push({ tracker: tracker.token, ...tracker.purchase_totals.quote_amount });
      if (mode === 'unknown_paid') throw new Error('Capture succeeded, response lost');
      return ok({ tracker });
    }
    throw new Error('Unexpected fixture provider route');
  });
});
const quote = extra => billing.createQuote(seller._id, { plan: 'starter', includeMetaAds: false,
  requestKey: `paid-engine-${new mongoose.Types.ObjectId()}`, ...extra });
const accept = quoteId => billing.acceptQuote(seller._id, { quoteId, cardId: 'pm_paid-engine-owned',
  consentAccepted: true, consentVersion: billing.CONSENT_VERSION });
async function makeDue() {
  const current = await Sub.findById(sub._id), due = new Date(Date.now() - 60000), anchor = new Date(due);
  anchor.setUTCDate(Math.min(28, anchor.getUTCDate())); anchor.setUTCMonth(anchor.getUTCMonth() - current.safepayBilling.cycle);
  await Sub.updateOne({ _id: sub._id }, { $set: { 'safepayBilling.anchorAt': anchor, 'safepayBilling.nextChargeAt': due, currentPeriodEnd: due } });
}
test('paid first invoice uses exact quoted money and activates once only after the adapter verifies capture', async () => {
  const q = await quote(); expect(q).toMatchObject({ dueNowMinor: 999, monthlyAmountMinor: 999, freePeriodDays: 0 });
  expect((await accept(q.quoteId)).completed).toBe(true);
  await accept(q.quoteId);
  expect(captures).toHaveLength(1); expect(captures[0]).toMatchObject({ amount: 999, currency: 'USD' });
  expect(await Payment.countDocuments({ status: 'paid', appliedAt: { $ne: null } })).toBe(1);
  expect((await Sub.findById(sub._id)).status).toBe('active');
});
test('accepted recurring work and a due renewal drain once during a two-surface pause', async () => {
  await accept((await quote()).quoteId); await makeDue();
  const before = captures.length;
  process.env.SAFEPAY_WEB_ENABLED = 'false'; process.env.SAFEPAY_MOBILE_ENABLED = 'false';
  try {
    await lifecycle.runBillingWorker(); await lifecycle.runBillingWorker();
    expect(captures.length - before).toBe(1);
    expect(await Operation.countDocuments({ kind: 'renewal', status: 'applied' })).toBe(1);
    expect((await Sub.findById(sub._id)).status).toBe('active');
  } finally { process.env.SAFEPAY_WEB_ENABLED = 'true'; process.env.SAFEPAY_MOBILE_ENABLED = 'true'; }
});
test.each([400, 402, 403, 422])('processor-declined renewal HTTP%s blocks access and only a fresh consented exact-invoice retry restores the original period', async httpStatus => {
  declineHttpStatus = httpStatus;
  await accept((await quote()).quoteId); await makeDue(); mode = 'declined';
  await lifecycle.runBillingWorker();
  const failed = await Operation.findOne({ kind: 'renewal' });
  expect(failed.status).toBe('failed'); expect(captures).toHaveLength(1);
  let current = await Sub.findById(sub._id);
  expect(current.status).toBe('past_due'); expect(current.safepayBilling.nextChargeAt).toBeNull();
  const q = await recovery.retryQuote(seller._id, { requestKey: 'paid-engine-explicit-retry', failedOperation: String(failed._id) });
  expect(q).toMatchObject({ dueNowMinor: 999, freePeriodDays: 0 });
  await expect(billing.acceptQuote(seller._id, { quoteId: q.quoteId, cardId: 'pm_paid-engine-owned' })).rejects.toMatchObject({ code: 'SUBSCRIPTION_CONSENT_REQUIRED' });
  mode = 'success'; await accept(q.quoteId); await accept(q.quoteId);
  current = await Sub.findById(sub._id);
  expect(current.status).toBe('active'); expect(current.currentPeriodEnd).toEqual(new Date(failed.terms.periodEnd));
  expect(current.safepayBilling.lastFailedOperation).toBeNull(); expect(captures).toHaveLength(2);
});
test.each(['unknown_paid', 'unknown_pending'])('lost authorization response %s never causes a second capture request', async selectedMode => {
  mode = selectedMode;
  const q = await quote(); const result = await accept(q.quoteId);
  const payment = await Payment.findById(result.paymentId);
  const posts = () => http.mock.calls.filter(([url, options]) => /\/order\/payments\/v3\/track_/.test(url) && options.method === 'POST').length;
  await payments.submitRecurringPayment(payment._id); await payments.submitRecurringPayment(payment._id);
  expect(posts()).toBe(1);
  if (selectedMode === 'unknown_paid') { expect(captures).toHaveLength(1); expect((await Sub.findById(sub._id)).status).toBe('active'); }
  else { expect(captures).toHaveLength(0); expect((await Sub.findById(sub._id)).status).not.toBe('active');
    expect((await Payment.findById(payment._id)).chargeOutcome).toBe('unknown'); }
});
test('paid upgrade and Meta add/remove preserve the funded period; downgrade is charged at its frozen next-period rate', async () => {
  await accept((await quote()).quoteId);
  const before = await Sub.findById(sub._id);
  const elite = await quote({ kind: 'upgrade', includeMetaAds: false });
  expect(elite.monthlyAmountMinor).toBe(2165); expect(elite.dueNowMinor).toBeGreaterThan(0);
  await accept(elite.quoteId);
  expect(captures.at(-1).amount).toBe(elite.dueNowMinor);
  let current = await Sub.findById(sub._id);
  expect(current.plan).toBe('elite'); expect(current.currentPeriodEnd).toEqual(before.currentPeriodEnd);
  const meta = await quote({ kind: 'upgrade', includeMetaAds: true }); await accept(meta.quoteId);
  current = await Sub.findById(sub._id);
  expect(current.metaAdsIncluded).toBe(true); expect(current.safepayBilling.monthlyMinor).toBe(2565);
  const count = captures.length;
  const removal = await quote({ kind: 'upgrade', includeMetaAds: false }); await accept(removal.quoteId);
  expect(captures).toHaveLength(count);
  current = await Sub.findById(sub._id);
  expect(current.metaAdsIncluded).toBe(false); expect(current.safepayBilling.creditMinor).toBe(removal.creditMinor);
  await lifecycle.scheduleDowngrade(seller._id);
  expect((await Sub.findById(sub._id)).plan).toBe('elite');
  await makeDue(); await lifecycle.runBillingWorker();
  const downgrade = await Operation.findOne({ kind: 'downgrade' });
  expect(downgrade.status).toBe('applied'); expect(downgrade.terms.monthlyMinor).toBe(999);
  expect(captures.at(-1).amount).toBe(999 - removal.creditMinor);
  current = await Sub.findById(sub._id);
  expect(current.plan).toBe('starter'); expect(current.pendingDowngrade?.toPlan).toBeNull();
});
test('cancellation during an already claimed capture preserves funded access but stops every later renewal', async () => {
  const q = await quote(); beforeCharge = () => lifecycle.cancel(seller._id);
  await accept(q.quoteId);
  const current = await Sub.findById(sub._id);
  expect(current.status).toBe('active'); expect(current.safepayBilling.autoRenew).toBe(false);
  expect(current.safepayBilling.nextChargeAt).toBeNull(); expect(captures).toHaveLength(1);
});

test('an unaccepted prepatch credit quote expires atomically, releases its claim and never rewrites accepted history', async () => {
  await accept((await quote()).quoteId);
  await accept((await quote({ kind: 'upgrade', includeMetaAds: true })).quoteId);
  const requestKey = 'legacy-unbounded-meta-credit';
  const old = await quote({ kind: 'upgrade', includeMetaAds: false, requestKey });
  const original = await Operation.findById(old.quoteId);
  // Emulate the old immutable quote format, not a payment or balance mutation.
  await Operation.collection.updateOne({ _id: original._id }, { $unset: { 'terms.proration.metaCreditFunding': '' } });
  const captureCount = captures.length;
  await expect(accept(old.quoteId)).rejects.toMatchObject({ code: 'SUBSCRIPTION_QUOTE_STALE' });
  const retired = await quote({ kind: 'upgrade', includeMetaAds: false, requestKey });
  expect(retired.status).toBe('expired');
  expect(await Claim.countDocuments({ token: original.terms.checkoutClaimToken })).toBe(0);
  expect((await Sub.findById(sub._id)).safepayBilling.creditMinor).toBe(0);
  const fresh = await quote({ kind: 'upgrade', includeMetaAds: false, requestKey: 'fresh-bounded-meta-credit' });
  await accept(fresh.quoteId); const credited = (await Sub.findById(sub._id)).safepayBilling.creditMinor;
  const applied = await Operation.findById(fresh.quoteId);
  await Operation.collection.updateOne({ _id: applied._id }, { $unset: { 'terms.proration.metaCreditFunding': '' } });
  expect((await quote({ kind: 'upgrade', includeMetaAds: false, requestKey: 'fresh-bounded-meta-credit' })).status).toBe('applied');
  await accept(fresh.quoteId);
  expect((await Sub.findById(sub._id)).safepayBilling.creditMinor).toBe(credited);
  expect(captures).toHaveLength(captureCount);
});

test('using an add-on credit to re-add and remove Meta cannot replenish or grow the funded credit', async () => {
  await accept((await quote()).quoteId);
  await accept((await quote({ kind: 'upgrade', includeMetaAds: true })).quoteId);
  const removal = await quote({ kind: 'upgrade', includeMetaAds: false }); await accept(removal.quoteId);
  const firstCredit = (await Sub.findById(sub._id)).safepayBilling.creditMinor;
  const count = captures.length;
  const readd = await quote({ kind: 'upgrade', includeMetaAds: true }); await accept(readd.quoteId);
  expect(readd.dueNowMinor).toBe(0);
  const again = await quote({ kind: 'upgrade', includeMetaAds: false }); await accept(again.quoteId); await accept(again.quoteId);
  expect((await Sub.findById(sub._id)).safepayBilling.creditMinor).toBeLessThanOrEqual(firstCredit);
  expect(captures).toHaveLength(count);
});

test('a new Meta-inclusive monthly invoice starts a fresh full-month funded allowance rather than reusing an old partial slice', async () => {
  await accept((await quote()).quoteId);
  await accept((await quote({ kind: 'upgrade', includeMetaAds: true })).quoteId);
  await makeDue(); await lifecycle.runBillingWorker();
  const renewal = await Operation.findOne({ kind: 'renewal' });
  expect(renewal.status).toBe('applied'); expect(renewal.terms.metaAddonMinor).toBe(400);
  const current = await Sub.findById(sub._id);
  expect(await require('../../services/safepayMetaCreditService').currentMetaFunding(current, 'sandbox')).toMatchObject({
    operationId: String(renewal._id), allowanceMinor: 400 });
});
