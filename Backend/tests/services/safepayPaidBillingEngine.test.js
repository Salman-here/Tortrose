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
const realDateNow = Date.now.bind(Date);
const useBillingClock = () => jest.useFakeTimers({ doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask',
  'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
afterEach(() => {jest.useRealTimers();delete process.env.SAFEPAY_SUBSCRIPTION_TEST_WINDOW;});
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
      expires_at: { seconds: Math.floor(Date.now() / 1000) + 90 * 86400 }, cybersource: { token: 'qa-network-token', last_four: '1111' } });
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

const enableTestClock=()=>{const now=new Date();process.env.SAFEPAY_SUBSCRIPTION_TEST_WINDOW=JSON.stringify({startsAt:new Date(now.getTime()-1000),expiresAt:new Date(now.getTime()+119*60000)});};
const acceptTest=q=>billing.acceptQuote(seller._id,{quoteId:q.quoteId,cardId:'pm_paid-engine-owned',consentAccepted:true,consentVersion:billing.CONSENT_VERSION,billingTestId:q.billingTest.id});
async function expectNotice(aggregateId, eventType, title, body) {
  const notices = await Outbox.find({ aggregateId: String(aggregateId), eventType }).lean();
  expect(notices.map(notice => notice.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
  for (const notice of notices) {
    const content = notice.channel === 'email' ? { subject: title, text: body }
      : notice.channel === 'whatsapp' ? { message: `*${title}*\n\n${body}\n\nView details: https://rozare.com/seller-dashboard/subscription` } : { title, body };
    expect(notice.payload).toMatchObject(content);
  }
}

test.each([['starter',10],['elite',15]])('live-test %s has a %i-minute intro and two exact $1 engine renewals without duplicate collection',async(plan,minutes)=>{
 await Sub.updateOne({_id:sub._id},{$set:{hasUsedFreePeriod:false}});enableTestClock();
 const q=await quote({plan,includeMetaAds:plan==='elite'});expect(q).toMatchObject({monthlyAmountMinor:100,dueNowMinor:0,billingTest:{renewalMinutes:20}});
 await expect(accept(q.quoteId)).rejects.toMatchObject({code:'SUBSCRIPTION_QUOTE_STALE'});
 expect((await acceptTest(q)).completed).toBe(true);let current=await Sub.findById(sub._id);
 expect(current.currentPeriodEnd-current.currentPeriodStart).toBe(minutes*60000);expect(captures).toHaveLength(0);
 await expectNotice(q.quoteId, 'subscription.payment_received', 'Your subscription introductory period has started',
   `Your ${current.planName} plan was activated with a ${minutes}-minute free introductory period. Amount due at activation: $0.00. Review your current billing dates, plan price and renewal settings in Subscription.`);
 useBillingClock();jest.setSystemTime(new Date(current.currentPeriodEnd.getTime()+10));await lifecycle.runBillingWorker();await lifecycle.runBillingWorker();
 expect(captures).toHaveLength(1);expect(captures[0]).toMatchObject({amount:100,currency:'USD'});
 current=await Sub.findById(sub._id);expect(current.currentPeriodEnd-current.currentPeriodStart).toBe(20*60000);
 jest.setSystemTime(new Date(current.currentPeriodEnd.getTime()+10));await lifecycle.runBillingWorker();await lifecycle.runBillingWorker();
 expect(captures).toHaveLength(2);expect(captures.every(row=>row.amount===100)).toBe(true);
 expect(await Operation.countDocuments({kind:'renewal',status:'applied'})).toBe(2);
 for (const renewal of await Operation.find({kind:'renewal',status:'applied'})) {
   await expectNotice(renewal._id, 'subscription.payment_received', 'Your subscription was updated',
     `Your ${renewal.terms.planName} subscription was updated successfully. Amount paid: $1.00. Review your current billing dates, plan price and renewal settings in Subscription.`);
 }
});
test('a declined test enrollment keeps the original failure wording in all four channels', async () => {
 enableTestClock();mode='declined';const q=await quote();await acceptTest(q);
 await expectNotice(q.quoteId, 'subscription.payment_failed', 'Subscription payment unsuccessful',
   'Your payment of $1.00 was unsuccessful. This attempt did not activate or extend your subscription. Review your payment method and retry in Subscription.');
 expect((await Sub.findById(sub._id)).safepayBilling.autoRenew).toBe(false);
});

test('a declined test renewal preserves the approved retry notice and the original failure schedule', async () => {
 enableTestClock();await acceptTest(await quote());let current=await Sub.findById(sub._id);
 useBillingClock();jest.setSystemTime(new Date(current.currentPeriodEnd.getTime()+10));mode='declined';await lifecycle.runBillingWorker();
 current=await Sub.findById(sub._id);const failed=await Operation.findById(current.safepayBilling.lastFailedOperation);
 const notice=require('../../services/safepayRenewalPolicy').failureNotice(current,failed);
 await expectNotice(failed._id,'subscription.payment_failed',notice.title,notice.body.replace('{{money.charged}}','$1.00'));
 expect(current.safepayBilling.recovery.attempts).toBe(1);
 expect(current.safepayBilling.recovery.nextRetryAt.getTime()-Date.now()).toBeGreaterThan(24*60*60000);
});

test('test cancellation keeps the original lifecycle wording with only the rate and interval substituted', async () => {
 enableTestClock();await acceptTest(await quote());await lifecycle.cancel(seller._id);const current=await Sub.findById(sub._id);
 await expectNotice(sub._id,'subscription.cancelled','Subscription renewal cancelled',
   `Automatic renewal of your plan ($1.00 per 20 minutes) is turned off. You can use your current plan until ${current.currentPeriodEnd.toISOString().slice(0,10)}. Review your subscription details if you want to resume.`);
 expect(current.safepayBilling.autoRenew).toBe(false);expect(current.safepayBilling.nextChargeAt).toBeNull();
});

test('test-window expiry cancels an unstarted invoice and cannot switch a new test agreement to the regular price',async()=>{
 await Sub.updateOne({_id:sub._id},{$set:{hasUsedFreePeriod:false}});enableTestClock();
 const q=await quote();await acceptTest(q);const current=await Sub.findById(sub._id);
 useBillingClock();jest.setSystemTime(new Date(current.currentPeriodEnd.getTime()+1));const op=await lifecycle.queueRenewal(sub._id);
 expect(op.terms.dueMinor).toBe(100);expect(captures).toHaveLength(0);
 jest.setSystemTime(new Date(new Date(q.billingTest.expiresAt).getTime()+1));await lifecycle.runBillingWorker();
 expect(captures).toHaveLength(0);expect((await Sub.findById(sub._id)).safepayBilling.autoRenew).toBe(false);
 expect((await Payment.findById(op.payment)).chargeStartedAt).toBeNull();
});

const enableManualClock=()=>{process.env.SAFEPAY_SUBSCRIPTION_TEST_WINDOW=JSON.stringify({startsAt:new Date(Date.now()-1000),untilDisabled:true});};

async function expiredTestRecovery(plan = 'starter') {
  await Sub.updateOne({ _id: sub._id }, { $set: { hasUsedFreePeriod: false } });
  enableManualClock();
  await acceptTest(await quote({ plan }));
  let current = await Sub.findById(sub._id);
  useBillingClock(); jest.setSystemTime(new Date(current.currentPeriodEnd.getTime() + 10));
  mode = 'declined'; await lifecycle.runBillingWorker();
  current = await Sub.findById(sub._id);
  const failed = await Operation.findById(current.safepayBilling.lastFailedOperation);
  jest.setSystemTime(new Date(failed.terms.periodEnd.getTime() + 60 * 60000));
  return { current, failed };
}

test.each(['starter', 'elite'])('%s: an explicitly retried expired $1 test invoice funds a fresh 20-minute cycle without catch-up charges', async plan => {
  const { failed } = await expiredTestRecovery(plan);
  const at = new Date();
  const q = await recovery.retryQuote(seller._id, { requestKey: 'expired-test-explicit-recovery', failedOperation: String(failed._id) });
  const op = await Operation.findById(q.quoteId);
  expect(op.terms).toMatchObject({ dueMinor: 100, currency: 'USD', cycle: failed.terms.cycle, retryOf: String(failed._id) });
  expect(op.terms.periodStart).toEqual(at);
  expect(new Date(op.terms.periodEnd) - new Date(op.terms.periodStart)).toBe(20 * 60000);
  expect(op.terms.billingTestRecovery.sourceOperation).toBe(String(failed._id));
  expect((await Operation.findById(failed._id)).terms.periodEnd).toEqual(failed.terms.periodEnd);
  mode = 'success'; await acceptTest(q); await acceptTest(q); await lifecycle.runBillingWorker();
  let current = await Sub.findById(sub._id);
  expect(captures).toHaveLength(1);
  expect(captures[0]).toMatchObject({ amount: 100, currency: 'USD' });
  expect(current.currentPeriodStart).toEqual(at);
  expect(current.safepayBilling.nextChargeAt).toEqual(current.currentPeriodEnd);
  expect(current.safepayBilling.recovery.rootOperation).toBeNull();
  expect(current.safepayBilling.lastFailedOperation).toBeNull();
  jest.setSystemTime(new Date(current.currentPeriodEnd.getTime() + 10));
  await lifecycle.runBillingWorker(); await lifecycle.runBillingWorker();
  current = await Sub.findById(sub._id);
  expect(captures).toHaveLength(2);
  expect(captures.every(p => p.amount === 100 && p.currency === 'USD')).toBe(true);
  expect(current.currentPeriodEnd - current.currentPeriodStart).toBe(20 * 60000);
});

test('scheduled day-3 test recovery keeps the original retry calendar but funds the current test cycle', async () => {
  const { failed } = await expiredTestRecovery();
  const current = await Sub.findById(sub._id), at = new Date(current.safepayBilling.recovery.nextRetryAt);
  jest.setSystemTime(at); mode = 'success';
  await lifecycle.runBillingWorker(); await lifecycle.runBillingWorker();
  const retry = await Operation.findOne({ 'terms.retryOf': String(failed._id) });
  expect(retry.status).toBe('applied');
  expect(retry.terms.periodStart).toEqual(at);
  expect(new Date(retry.terms.periodEnd) - at).toBe(20 * 60000);
  expect(retry.terms.renewalAttempt).toBe(2);
  expect(captures).toHaveLength(1);
});

test('an expired regular-price invoice cannot use test recovery rebasing', async () => {
  const current = await startRecovery();
  const failed = await Operation.findById(current.safepayBilling.lastFailedOperation);
  jest.setSystemTime(new Date(failed.terms.periodEnd.getTime() + 10));
  await expect(recovery.retryQuote(seller._id, { requestKey: 'normal-expired-period-fence', failedOperation: String(failed._id) }))
    .rejects.toMatchObject({ code: 'SUBSCRIPTION_RECOVERY_EXPIRED' });
  expect(await Operation.countDocuments({ 'terms.retryOf': String(failed._id) })).toBe(0);
});

test('disabling the test prevents an expired test invoice from starting a new charge', async () => {
  const { failed } = await expiredTestRecovery();
  delete process.env.SAFEPAY_SUBSCRIPTION_TEST_WINDOW;
  await expect(recovery.retryQuote(seller._id, { requestKey: 'disabled-expired-test-fence', failedOperation: String(failed._id) })).rejects.toBeTruthy();
  expect(captures).toHaveLength(0);
  expect(await Operation.countDocuments({ 'terms.retryOf': String(failed._id) })).toBe(0);
});

test('cancelling an expired test renewal invalidates a prepared recovery quote before capture', async () => {
  const { failed } = await expiredTestRecovery();
  const q = await recovery.retryQuote(seller._id, { requestKey: 'cancel-expired-test-fence', failedOperation: String(failed._id) });
  await lifecycle.cancel(seller._id); mode = 'success';
  await expect(acceptTest(q)).rejects.toMatchObject({ code: 'SUBSCRIPTION_QUOTE_STALE' });
  expect(captures).toHaveLength(0);
});

test('an expired test invoice with captured money cannot create another payment even if its decline flags are stale', async () => {
  const { failed } = await expiredTestRecovery();
  await Payment.updateOne({ _id: failed.payment }, { $set: { capturedMinor: 100 } });
  await expect(recovery.retryQuote(seller._id, { requestKey: 'captured-expired-test-fence', failedOperation: String(failed._id) }))
    .rejects.toMatchObject({ code: 'SUBSCRIPTION_RETRY_UNAVAILABLE' });
  expect(await Operation.countDocuments({ 'terms.retryOf': String(failed._id) })).toBe(0);
});

test('an expired test retry cannot replace a payment whose capture outcome is still uncertain', async () => {
  const { failed } = await expiredTestRecovery();
  await Payment.updateOne({ _id: failed.payment }, { $set: { chargeOutcome: 'unknown' } });
  await expect(recovery.retryQuote(seller._id, { requestKey: 'unknown-expired-test-fence', failedOperation: String(failed._id) }))
    .rejects.toMatchObject({ code: 'SUBSCRIPTION_RETRY_UNAVAILABLE' });
  expect(captures).toHaveLength(0);
});

test.each([['starter',10],['elite',15]])('operator-ended %s keeps its %i-minute intro and exact $1 renewals beyond two hours',async(plan,minutes)=>{
 await Sub.updateOne({_id:sub._id},{$set:{hasUsedFreePeriod:false}});enableManualClock();
 const q=await quote({plan,includeMetaAds:plan==='elite'});expect(q.billingTest).toMatchObject({untilDisabled:true,expiresAt:null});
 expect(Number.isFinite(new Date(q.expiresAt).getTime())).toBe(true);
 expect(q.terms).toContain('no automatic test expiry');await acceptTest(q);
 let current=await Sub.findById(sub._id);expect(current.currentPeriodEnd-current.currentPeriodStart).toBe(minutes*60000);
 useBillingClock();
 for(let count=1;count<=8;count++) {
  current=await Sub.findById(sub._id);jest.setSystemTime(new Date(current.currentPeriodEnd.getTime()+10));
  await lifecycle.runBillingWorker();await lifecycle.runBillingWorker();expect(captures).toHaveLength(count);
  current=await Sub.findById(sub._id);expect(current.safepayBilling.autoRenew).toBe(true);
  expect(current.currentPeriodEnd-current.currentPeriodStart).toBe(20*60000);
 }
 expect(captures.every(row=>row.amount===100&&row.currency==='USD')).toBe(true);
 expect(await Operation.countDocuments({kind:'renewal',status:'applied','terms.billingTest.untilDisabled':true})).toBe(8);
});

test('switching off an operator-ended test fences unstarted charges and does not switch a new agreement to full price',async()=>{
 enableManualClock();await acceptTest(await quote());let current=await Sub.findById(sub._id);expect(captures).toHaveLength(1);
 useBillingClock();jest.setSystemTime(new Date(current.currentPeriodEnd.getTime()+1));const op=await lifecycle.queueRenewal(sub._id);
 expect(op.terms.billingTest.untilDisabled).toBe(true);delete process.env.SAFEPAY_SUBSCRIPTION_TEST_WINDOW;
 await lifecycle.runBillingWorker();await lifecycle.runBillingWorker();current=await Sub.findById(sub._id);
 expect(captures).toHaveLength(1);expect(current.safepayBilling.autoRenew).toBe(false);expect(current.safepayBilling.nextChargeAt).toBeNull();
 expect((await Payment.findById(op.payment)).chargeStartedAt).toBeNull();
});

test('an already claimed manual-test capture settles once after operator disable and uses the real stop time',async()=>{
 enableManualClock();beforeCharge=async()=>{delete process.env.SAFEPAY_SUBSCRIPTION_TEST_WINDOW;};
 await acceptTest(await quote());const current=await Sub.findById(sub._id);
 expect(captures).toHaveLength(1);expect(current.safepayBilling.autoRenew).toBe(false);
 expect(current.cancelledAt.getFullYear()).toBeGreaterThan(2020);
 await lifecycle.runBillingWorker();expect(captures).toHaveLength(1);
});

test('a restored older agreement can enter the new operator-ended test without reviving a cancellation',async()=>{
 await accept((await quote()).quoteId);enableTestClock();await lifecycle.refreshStatus(sub._id);
 const oldClock=(await Sub.findById(sub._id)).safepayBilling.testClock;
 useBillingClock();jest.setSystemTime(new Date(new Date(oldClock.expiresAt).getTime()+1));await lifecycle.runBillingWorker();
 let current=await Sub.findById(sub._id);expect(current.safepayBilling.testClock.restoredAt).toBeTruthy();
 enableManualClock();await lifecycle.refreshStatus(sub._id);current=await Sub.findById(sub._id);
 expect(current.safepayBilling.testClock.untilDisabled).toBe(true);expect(current.safepayBilling.monthlyMinor).toBe(100);
 expect(current.safepayBilling.nextChargeAt.getTime()-Date.now()).toBe(20*60000);
 await lifecycle.cancel(seller._id);await lifecycle.refreshStatus(sub._id);
 expect((await Sub.findById(sub._id)).safepayBilling.autoRenew).toBe(false);expect(captures).toHaveLength(1);
});
test('global test adoption and expiry preserve the pre-existing monthly agreement and invoice history',async()=>{
 await accept((await quote()).quoteId);const original=await Sub.findById(sub._id);expect(captures[0].amount).toBe(999);enableTestClock();
 await lifecycle.refreshStatus(sub._id);let current=await Sub.findById(sub._id);expect(current.safepayBilling.monthlyMinor).toBe(100);
 expect(current.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now()+19*60000);
 useBillingClock();jest.setSystemTime(new Date(current.currentPeriodEnd.getTime()+1));await lifecycle.runBillingWorker();expect(captures).toHaveLength(2);expect(captures[1].amount).toBe(100);
 jest.setSystemTime(new Date(new Date(current.safepayBilling.testClock.expiresAt).getTime()+1));await lifecycle.runBillingWorker();
 current=await Sub.findById(sub._id);expect(current.safepayBilling.monthlyMinor).toBe(999);expect(current.currentPeriodEnd).toEqual(original.currentPeriodEnd);
 expect(current.safepayBilling.autoRenew).toBe(true);expect(captures).toHaveLength(2);expect(await Payment.countDocuments({status:'paid'})).toBe(2);
});
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
test.each([400, 402, 403, 422])('processor-declined renewal HTTP%s grants bounded recovery access and a consented retry funds the original period', async httpStatus => {
  declineHttpStatus = httpStatus;
  await accept((await quote()).quoteId); await makeDue(); mode = 'declined';
  await lifecycle.runBillingWorker();
  const failed = await Operation.findOne({ kind: 'renewal' });
  expect(failed.status).toBe('failed'); expect(captures).toHaveLength(1);
  let current = await Sub.findById(sub._id);
  expect(current.status).toBe('active'); expect(current.safepayBilling.nextChargeAt).toBeNull();
  expect(current.safepayBilling.recovery.attempts).toBe(1);
  expect(current.safepayBilling.recovery.nextRetryAt).toBeInstanceOf(Date);
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

async function startRecovery(plan = 'starter', selectedMode = 'declined') {
  await accept((await quote({ plan })).quoteId);
  await makeDue();
  useBillingClock(); jest.setSystemTime(new Date(realDateNow()));
  mode = selectedMode;
  await lifecycle.runBillingWorker();
  return Sub.findById(sub._id);
}

test.each(['starter', 'elite'])('%s: four declined scheduled attempts notify all channels once, preserve grace, then cancel only at end of day 7', async plan => {
  let current = await startRecovery(plan);
  const first = await Operation.findById(current.safepayBilling.lastFailedOperation);
  const invoice = { amount: first.terms.dueMinor, start: first.terms.periodStart, end: first.terms.periodEnd };
  const authority = require('../../services/safepayNotificationAuthority').verifySafepayNotificationAuthority;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    current = await Sub.findById(sub._id);
    expect(current.status).toBe('active');
    expect(current.safepayBilling.recovery.attempts).toBe(attempt);
    expect((await Store.findOne({ seller: seller._id })).isActive).toBe(true);
    const failed = await Operation.findById(current.safepayBilling.lastFailedOperation);
    expect(failed.terms.dueMinor).toBe(invoice.amount);
    expect(new Date(failed.terms.periodStart)).toEqual(new Date(invoice.start));
    expect(new Date(failed.terms.periodEnd)).toEqual(new Date(invoice.end));
    const notices = await Outbox.find({ aggregateId: String(failed._id), eventType: 'subscription.payment_failed' }).lean();
    expect(notices.map(n => n.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    for (const notice of notices) expect(await authority(notice)).toBeNull();
    expect(failed.recoveryNotice.finalDay).toBe(attempt === 4);
    const count = await Payment.countDocuments({ purpose: 'subscription' });
    await lifecycle.runBillingWorker(); await lifecycle.runBillingWorker();
    expect(await Payment.countDocuments({ purpose: 'subscription' })).toBe(count);
    if (attempt < 4) {
      const next = current.safepayBilling.recovery.nextRetryAt;
      jest.setSystemTime(new Date(next.getTime() - 1)); await lifecycle.runBillingWorker();
      expect(await Payment.countDocuments({ purpose: 'subscription' })).toBe(count);
      jest.setSystemTime(next); await lifecycle.runBillingWorker();
    }
  }
  current = await Sub.findById(sub._id);
  expect(current.safepayBilling.recovery.nextRetryAt).toBeNull();
  expect(await Operation.countDocuments({ kind: 'renewal', status: 'failed' })).toBe(4);
  expect(captures).toHaveLength(1); // The original funded invoice only.
  const deadline = current.safepayBilling.recovery.cancelAt;
  jest.setSystemTime(new Date(deadline.getTime() - 1));
  expect((await lifecycle.refreshStatus(sub._id)).status).toBe('active');
  jest.setSystemTime(deadline); await lifecycle.runBillingWorker(); await lifecycle.runBillingWorker();
  current = await Sub.findById(sub._id);
  expect(current.status).toBe('cancelled'); expect(current.safepayBilling.autoRenew).toBe(false);
  expect(current.safepayBilling.endedAt).toEqual(deadline);
  expect((await Store.findOne({ seller: seller._id })).isActive).toBe(false);
  const ended = await Outbox.find({ aggregateType: 'SellerSubscription', eventType: 'subscription.cancelled' }).lean();
  expect(ended).toHaveLength(4);
  for (const notice of ended) expect(await authority(notice)).toBeNull();
  const oldFailure = await Outbox.findOne({ aggregateId: String(current.safepayBilling.lastFailedOperation), channel: 'email' }).lean();
  expect(await authority(oldFailure)).toMatchObject({ outcome: 'skipped' });
});

test('a successful automatic retry funds the frozen renewal once and stops every remaining reminder/attempt', async () => {
  let current = await startRecovery();
  const original = await Operation.findById(current.safepayBilling.lastFailedOperation);
  const at = current.safepayBilling.recovery.nextRetryAt;
  mode = 'success'; jest.setSystemTime(at); await lifecycle.runBillingWorker();
  current = await Sub.findById(sub._id);
  expect(current.status).toBe('active'); expect(current.safepayBilling.recovery.rootOperation).toBeNull();
  expect(current.safepayBilling.lastFailedOperation).toBeNull();
  expect(current.currentPeriodEnd).toEqual(new Date(original.terms.periodEnd));
  expect(captures).toHaveLength(2);
  jest.setSystemTime(new Date(at.getTime() + 6 * 86400000)); await lifecycle.runBillingWorker();
  expect(captures).toHaveLength(2); expect(await Operation.countDocuments({ kind: 'renewal' })).toBe(2);
});

test('a card change and explicit retry recover during grace without waiting for the scheduled attempt', async () => {
  let current = await startRecovery();
  await recovery.changeCard(seller._id, { cardId: 'pm_paid-engine-owned', billingVersion: current.safepayBilling.version,
    consentAccepted: true, consentVersion: billing.CONSENT_VERSION });
  const q = await recovery.retryQuote(seller._id, { requestKey: 'grace-explicit-card-recovery', failedOperation: String(current.safepayBilling.lastFailedOperation) });
  mode = 'success'; await accept(q.quoteId);
  current = await Sub.findById(sub._id);
  expect(current.safepayBilling.recovery.rootOperation).toBeNull(); expect(current.safepayBilling.lastFailedOperation).toBeNull();
  expect(captures).toHaveLength(2);
  await lifecycle.runBillingWorker(); expect(captures).toHaveLength(2);
});

test('unknown payment results never create a replacement charge or a false final cancellation', async () => {
  let current = await startRecovery('starter', 'unknown_pending');
  expect(current.safepayBilling.pendingOperation).toBeTruthy();
  const deadline = current.safepayBilling.recovery.cancelAt;
  jest.setSystemTime(new Date(deadline.getTime() + 1));
  await lifecycle.runBillingWorker(); await lifecycle.refreshStatus(sub._id);
  current = await Sub.findById(sub._id);
  expect(current.status).toBe('past_due'); expect(current.safepayBilling.autoRenew).toBe(true);
  expect(current.safepayBilling.endedAt).toBeNull();
  expect(await Operation.countDocuments({ kind: 'renewal' })).toBe(1);
  expect((await Store.findOne({ seller: seller._id })).isActive).toBe(false);
  const posts = http.mock.calls.filter(([url, options]) => /\/order\/payments\/v3\/track_/.test(url) && options.method === 'POST');
  expect(posts).toHaveLength(2); // Enrollment + exactly one unknown renewal.
  expect(await Outbox.countDocuments({ eventType: 'subscription.payment_failed' })).toBe(0);
});

test('manual cancellation during recovery stops every automatic retry', async () => {
  const current = await startRecovery();
  await lifecycle.cancel(seller._id);
  jest.setSystemTime(current.safepayBilling.recovery.nextRetryAt); await lifecycle.runBillingWorker();
  expect(await Operation.countDocuments({ kind: 'renewal' })).toBe(1);
  expect((await Sub.findById(sub._id)).safepayBilling.autoRenew).toBe(false);
});

test('a day-7 retry quote cannot be accepted after the recovery deadline', async () => {
  const current = await startRecovery();
  jest.setSystemTime(new Date(current.safepayBilling.recovery.cancelAt.getTime() - 60000));
  const q = await recovery.retryQuote(seller._id, { requestKey: 'grace-expiring-review', failedOperation: String(current.safepayBilling.lastFailedOperation) });
  jest.setSystemTime(current.safepayBilling.recovery.cancelAt);
  await expect(accept(q.quoteId)).rejects.toMatchObject({ code: 'SUBSCRIPTION_RECOVERY_EXPIRED' });
  expect(captures).toHaveLength(1);
});

test('two processes cannot prepare two payments for the same scheduled retry', async () => {
  const current = await startRecovery();
  jest.setSystemTime(current.safepayBilling.recovery.nextRetryAt);
  const [a, b] = await Promise.all([lifecycle.queueRenewal(sub._id), lifecycle.queueRenewal(sub._id)]);
  expect(String(a._id)).toBe(String(b._id));
  const submissions = await Promise.allSettled([payments.submitRecurringPayment(a.payment), payments.submitRecurringPayment(b.payment)]);
  for (const result of submissions) if (result.status === 'rejected') expect(result.reason.code).toBe('CHECKOUT_IN_PROGRESS');
  await payments.submitRecurringPayment(a.payment);
  expect(await Operation.countDocuments({ kind: 'renewal' })).toBe(2);
  expect((await Sub.findById(sub._id)).safepayBilling.recovery.attempts).toBe(2);
  expect(captures).toHaveLength(1);
});

test('a replacement card is used by the next scheduled retry, not the previous/default card', async () => {
  let current = await startRecovery();
  const replacement = 'pm_paid-engine-replacement';
  mockOwnedCard.mockResolvedValue({ link: customer, card: { token: replacement }, config: readSafepayConfig() });
  await recovery.changeCard(seller._id, { cardId: replacement, billingVersion: current.safepayBilling.version,
    consentAccepted: true, consentVersion: billing.CONSENT_VERSION });
  const originalHttp = http;
  http = async (url, options) => {
    if (new URL(url).pathname.includes('/wallet/')) return { ok: true, status: 200, json: async () => ({ data: {
      token: replacement, customer: customer.customerId, merchant_api_key: 'sec_paid-engine', is_deleted: false,
      max_usage: -1, expires_at: { seconds: Math.floor(Date.now() / 1000) + 90 * 86400 },
      cybersource: { token: 'qa-replacement-network-token', last_four: '1005' } } }) };
    return originalHttp(url, options);
  };
  mode = 'success'; jest.setSystemTime(current.safepayBilling.recovery.nextRetryAt); await lifecycle.runBillingWorker();
  current = await Sub.findById(sub._id).select('+safepayBilling.cardId');
  expect(current.safepayBilling.cardId).toBe(replacement);
  const op = await Operation.findOne({ kind: 'renewal', status: 'applied' }).select('+cardId');
  const paid = await Payment.findById(op.payment).select('+cardId');
  expect(op.cardId).toBe(replacement); expect(paid.cardId).toBe(replacement);
  expect(captures).toHaveLength(2);
});

test('an initial enrollment decline never grants a recovery week or schedules unapproved enrollment charges', async () => {
  mode = 'declined'; await accept((await quote()).quoteId);
  const current = await Sub.findById(sub._id);
  expect(current.safepayBilling.autoRenew).toBe(false);
  expect(current.safepayBilling.recovery.rootOperation).toBeNull();
  await lifecycle.runBillingWorker(); await lifecycle.runBillingWorker();
  expect(await Payment.countDocuments({ purpose: 'subscription' })).toBe(1);
  expect(captures).toHaveLength(0);
});

test('a verified expired unpaid tracker releases its invoice for recovery instead of blocking the subscription forever', async () => {
  await accept((await quote()).quoteId); await makeDue();
  const originalHttp = http;
  http = async (url, options) => {
    const result = await originalHttp(url, options);
    if (new URL(url).pathname.startsWith('/reporter/api/v1/payments/')) {
      const body = await result.json();
      if (body.data.tracker.state === 'TRACKER_STARTED') body.data.tracker.state = 'TRACKER_EXPIRED';
      return { ok: true, status: 200, json: async () => body };
    }
    return result;
  };
  await lifecycle.runBillingWorker();
  const current = await Sub.findById(sub._id);
  expect(current.safepayBilling.pendingOperation).toBeNull();
  expect(current.safepayBilling.lastFailedOperation).toBeTruthy();
  expect(current.safepayBilling.recovery.nextRetryAt).toBeInstanceOf(Date);
  const op = await Operation.findById(current.safepayBilling.lastFailedOperation);
  const payment = await Payment.findById(op.payment);
  expect(op.failureCode).toBe('SAFEPAY_RECURRING_PAYMENT_CLOSED');
  expect(payment.status).toBe('failed'); expect(payment.capturedMinor).toBe(0);
  expect(captures).toHaveLength(1);
});
