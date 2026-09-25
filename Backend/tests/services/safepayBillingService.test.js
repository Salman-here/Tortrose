'use strict';
const mockCard = jest.fn();
jest.mock('../../services/safepayCustomerService', () => ({ requireOwnedReusableCard: mockCard }));
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../../models/User');
const Store = require('../../models/Store');
const Subscription = require('../../models/SellerSubscription');
const Operation = require('../../models/SafepayBillingOperation');
const Payment = require('../../models/SafepayPayment');
const Customer = require('../../models/SafepayCustomer');
const Promotion = require('../../models/SubscriptionPromotion');
const Claim = require('../../models/SellerCheckoutClaim');
const Outbox = require('../../models/NotificationOutbox');
const billing = require('../../services/safepayBillingService');
const lifecycle = require('../../services/safepayBillingLifecycleService');
const payments = require('../../services/safepayPaymentService');
const recovery = require('../../services/safepayBillingRecoveryService');
let replica, seller, sub, customer, submit;
beforeAll(async () => {
  Object.assign(process.env, { SAFEPAY_ENV: 'sandbox', SAFEPAY_SANDBOX_PUBLIC_KEY: 'sec_test-billing',
    SAFEPAY_SANDBOX_SECRET_KEY: 'private-billing-test-secret', SAFEPAY_SANDBOX_WEBHOOK_SECRET: 'private-billing-webhook-secret', SAFEPAY_SANDBOX_WEBHOOK_SCHEME: 'sha512-raw' });
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Promise.all([User, Store, Subscription, Operation, Payment, Customer, Promotion, Claim, Outbox].map(model => model.init()));
  submit = jest.spyOn(payments, 'submitRecurringPayment').mockResolvedValue({ status: 'pending' });
}, 120000);
afterAll(async () => { submit.mockRestore(); await mongoose.disconnect(); await replica?.stop(); });
beforeEach(async () => {
  for (const model of [User, Store, Subscription, Operation, Payment, Customer, Promotion, Claim, Outbox]) await model.deleteMany({});
  submit.mockClear(); mockCard.mockReset();
  seller = await User.create({ username: 'Safepay Seller Fixture', email: 'safepay-billing@example.com', role: 'seller', status: 'active' });
  await Store.create({ seller: seller._id, storeName: 'Safepay Billing Fixture', storeSlug: 'safepay-billing-fixture',
    logo: 'https://example.com/logo.png', productCurrency: 'PKR', productCurrencyStatus: 'active', isActive: true, moderationStatus: 'approved' });
  sub = await Subscription.create({ seller: seller._id, status: 'trial', trialStartDate: new Date(), trialEndDate: new Date(Date.now() + 15 * 86400000) });
  customer = await Customer.create({ user: seller._id, environment: 'sandbox', customerId: 'cus_owned-billing-fixture', status: 'ready' });
  mockCard.mockResolvedValue({ link: customer, card: { token: 'pm_owned-billing-fixture' }, config: { environment: 'sandbox' } });
});
const accept = quoteId => billing.acceptQuote(seller._id, { quoteId, cardId: 'pm_owned-billing-fixture', consentAccepted: true, consentVersion: billing.CONSENT_VERSION });
const quote = (extra = {}) => billing.createQuote(seller._id, { plan: 'starter', includeMetaAds: false, requestKey: 'billing-fixture-request', ...extra });

test('a plan quote or a saved card alone never starts a subscription', async () => {
  const q = await quote();
  expect(q).toMatchObject({ monthlyAmountMinor: 999, freePeriodDays: 30, dueNowMinor: 0, requiresSafepayAccount: false });
  expect((await Subscription.findById(sub._id)).status).toBe('trial');
  await expect(billing.acceptQuote(seller._id, { quoteId: q.quoteId, cardId: 'pm_owned-billing-fixture' })).rejects.toMatchObject({ code: 'SUBSCRIPTION_CONSENT_REQUIRED' });
  expect(submit).not.toHaveBeenCalled();
});
test('Starter introductory period activates once, with original pricing and a six-calendar-month bonus', async () => {
  const q = await quote();
  expect((await accept(q.quoteId)).completed).toBe(true);
  const initial = await Subscription.findById(sub._id);
  expect(initial.status).toBe('free_period'); expect(initial.hasUsedFreePeriod).toBe(true);
  expect(initial.safepayBilling.monthlyMinor).toBe(999); expect(initial.safepayBilling.autoRenew).toBe(true);
  expect(initial.freePeriodEndDate.getTime() - initial.subscribedAt.getTime()).toBe(30 * 86400000);
  expect(initial.starterBonusPeriodUsed).toBe(true);
  const notices = await Outbox.countDocuments();
  await accept(q.quoteId);
  const replay = await Subscription.findById(sub._id);
  expect(replay.freePeriodEndDate).toEqual(initial.freePeriodEndDate);
  expect(await Outbox.countDocuments()).toBe(notices);
  expect(await Payment.countDocuments()).toBe(0);
  expect(submit).not.toHaveBeenCalled();
});
test('FIRST100 uses the shared capacity and records a Safepay claim without fake Stripe IDs', async () => {
  const q = await quote({ couponCode: 'FIRST100' });
  expect(q.monthlyAmountMinor).toBe(599);
  await accept(q.quoteId);
  const promotion = await Promotion.findOne({ code: 'FIRST100' });
  expect(promotion.claims).toHaveLength(1); expect(promotion.reservations).toHaveLength(0);
  expect(promotion.claims[0].provider).toBe('safepay'); expect(promotion.claims[0].checkoutSessionId).toBeNull();
  expect(String(promotion.claims[0].safepayOperationId)).toBe(q.quoteId);
  expect((await Subscription.findById(sub._id)).founderOffer.active).toBe(true);
});
test('rejoining cannot receive a second introductory period and stays unfunded until exact payment settles', async () => {
  sub.hasUsedFreePeriod = true; await sub.save();
  const q = await quote(); expect(q.dueNowMinor).toBe(999); expect(q.freePeriodDays).toBe(0);
  const result = await accept(q.quoteId); expect(result.completed).toBe(false);
  let current = await Subscription.findById(sub._id); expect(current.status).toBe('trial');
  const payment = await Payment.findById(result.paymentId);
  expect(payment).toMatchObject({ amountMinor: 999, currency: 'USD', providerMode: 'subscription', customerId: customer.customerId });
  await mongoose.connection.transaction(session => billing.settleBillingPayment(payment, { state: 'TRACKER_ENDED' }, session));
  current = await Subscription.findById(sub._id);
  expect(current.status).toBe('active'); expect(current.safepayBilling.cycle).toBe(1);
});
test('cancel and resume change future renewal only, without extending existing access', async () => {
  await accept((await quote()).quoteId);
  const before = await Subscription.findById(sub._id);
  await lifecycle.cancel(seller._id);
  let current = await Subscription.findById(sub._id);
  expect(current.status).toBe('free_period'); expect(current.currentPeriodEnd).toEqual(before.currentPeriodEnd);
  expect(current.safepayBilling.autoRenew).toBe(false); expect(current.safepayBilling.nextChargeAt).toBeNull();
  await lifecycle.resume(seller._id);
  current = await Subscription.findById(sub._id);
  expect(current.safepayBilling.autoRenew).toBe(true); expect(current.currentPeriodEnd).toEqual(before.currentPeriodEnd);
});
test('cancellation before an authorization claim stops the pending initial invoice', async () => {
  sub.hasUsedFreePeriod = true; await sub.save();
  const result = await accept((await quote()).quoteId);
  await lifecycle.cancel(seller._id);
  expect((await Payment.findById(result.paymentId)).status).toBe('cancelled');
  expect(await billing.claimRecurringCharge(result.paymentId)).toBeNull();
});
test('cancellation after charge started is preserved when the funded period activates', async () => {
  sub.hasUsedFreePeriod = true; await sub.save();
  const result = await accept((await quote()).quoteId);
  await Payment.updateOne({ _id: result.paymentId }, { $set: { status: 'ready', tracker: 'track_owned-billing-fixture' } });
  const claimed = await billing.claimRecurringCharge(result.paymentId); expect(claimed).toBeTruthy();
  await lifecycle.cancel(seller._id);
  await mongoose.connection.transaction(session => billing.settleBillingPayment(claimed, { state: 'TRACKER_ENDED' }, session));
  const current = await Subscription.findById(sub._id);
  expect(current.status).toBe('active'); expect(current.cancelledAt).toBeTruthy();
  expect(current.safepayBilling.autoRenew).toBe(false); expect(current.safepayBilling.nextChargeAt).toBeNull();
});
test('one renewal operation is created per anchored cycle, and no new access is granted before payment', async () => {
  await accept((await quote()).quoteId);
  const anchor = new Date(Date.now() - 60000);
  await Subscription.updateOne({ _id: sub._id }, { $set: { 'safepayBilling.anchorAt': anchor, 'safepayBilling.nextChargeAt': anchor, currentPeriodEnd: anchor } });
  const first = await lifecycle.queueRenewal(sub._id);
  const second = await lifecycle.queueRenewal(sub._id);
  expect(String(second._id)).toBe(String(first._id));
  expect(await Operation.countDocuments({ kind: 'renewal' })).toBe(1);
  expect((await Subscription.findById(sub._id)).status).toBe('past_due');
  const payment = await Payment.findById(first.payment);
  await mongoose.connection.transaction(session => billing.settleBillingPayment(payment, { state: 'TRACKER_ENDED' }, session));
  expect((await Subscription.findById(sub._id)).status).toBe('active');
  expect((await Store.findOne({ seller: seller._id })).isActive).toBe(true);
});
test('stale/cross-account quotes and a changed card cannot alter the agreed billing intent', async () => {
  const q = await quote();
  await Subscription.updateOne({ _id: sub._id }, { $inc: { 'safepayBilling.version': 1 } });
  await expect(accept(q.quoteId)).rejects.toMatchObject({ code: 'SUBSCRIPTION_QUOTE_STALE' });
  expect(await Payment.countDocuments()).toBe(0);
});

const declinedRenewal = async () => {
  await accept((await quote()).quoteId);
  const anchor = new Date(Date.now() - 60000);
  await Subscription.updateOne({ _id: sub._id }, { $set: { 'safepayBilling.anchorAt': anchor,
    'safepayBilling.nextChargeAt': anchor, currentPeriodEnd: anchor } });
  const op = await lifecycle.queueRenewal(sub._id);
  const payment = await Payment.findByIdAndUpdate(op.payment, { $set: { status: 'failed', chargeOutcome: 'declined' } }, { new: true });
  await mongoose.connection.transaction(session => billing.failBillingPayment(payment, session));
  return op;
};

test('a declined renewal retries only after a fresh exact-amount consent and never extends the original period', async () => {
  const failed = await declinedRenewal();
  const q = await recovery.retryQuote(seller._id, { requestKey: 'retry-renewal-fixture', failedOperation: String(failed._id) });
  expect(q.dueNowMinor).toBe(999); expect(q.freePeriodDays).toBe(0);
  const retry = await accept(q.quoteId);
  expect(retry.completed).toBe(false);
  const op = await Operation.findById(q.quoteId);
  expect(new Date(op.terms.periodEnd)).toEqual(new Date(failed.terms.periodEnd));
  expect(String(op.payment)).not.toBe(String(failed.payment));
  await mongoose.connection.transaction(async session => billing.settleBillingPayment(await Payment.findById(op.payment).session(session), { state: 'TRACKER_ENDED' }, session));
  const current = await Subscription.findById(sub._id);
  expect(current.status).toBe('active'); expect(current.safepayBilling.lastFailedOperation).toBeNull();
  expect(current.currentPeriodEnd).toEqual(new Date(failed.terms.periodEnd));
});

test('uncertain payments cannot be retried on a new tracker', async () => {
  const failed = await declinedRenewal();
  await Payment.updateOne({ _id: failed.payment }, { $set: { chargeOutcome: 'unknown' } });
  await expect(recovery.retryQuote(seller._id, { requestKey: 'retry-unknown-fixture', failedOperation: String(failed._id) }))
    .rejects.toMatchObject({ code: 'SUBSCRIPTION_RETRY_UNAVAILABLE' });
});

test('cancellation invalidates an unaccepted retry quote', async () => {
  const failed = await declinedRenewal();
  const q = await recovery.retryQuote(seller._id, { requestKey: 'retry-cancel-fixture', failedOperation: String(failed._id) });
  await lifecycle.cancel(seller._id);
  await expect(accept(q.quoteId)).rejects.toMatchObject({ code: 'SUBSCRIPTION_QUOTE_STALE' });
});

test('changing a subscription card requires owned-card consent and preserves amount and renewal date', async () => {
  await accept((await quote()).quoteId);
  const before = await Subscription.findById(sub._id);
  mockCard.mockResolvedValue({ link: customer, card: { token: 'pm_replacement-billing-fixture' }, config: { environment: 'sandbox' } });
  await recovery.changeCard(seller._id, { cardId: 'pm_replacement-billing-fixture', billingVersion: before.safepayBilling.version,
    consentAccepted: true, consentVersion: billing.CONSENT_VERSION });
  const after = await Subscription.findById(sub._id).select('+safepayBilling.cardId');
  expect(after.safepayBilling.cardId).toBe('pm_replacement-billing-fixture');
  expect(after.safepayBilling.nextChargeAt).toEqual(before.safepayBilling.nextChargeAt);
  expect(after.safepayBilling.monthlyMinor).toBe(before.safepayBilling.monthlyMinor);
  expect(await Payment.countDocuments()).toBe(0);
});

test('a customer deletion fence prevents concurrently selecting the card for renewal', async () => {
  await accept((await quote()).quoteId);
  const before = await Subscription.findById(sub._id);
  await Customer.updateOne({ _id: customer._id }, { $set: { deletingCardId: 'pm_owned-billing-fixture' } });
  await expect(recovery.changeCard(seller._id, { cardId: 'pm_owned-billing-fixture', billingVersion: before.safepayBilling.version,
    consentAccepted: true, consentVersion: billing.CONSENT_VERSION })).rejects.toMatchObject({ code: 'CARD_REMOVAL_PENDING' });
});

test('a read of expired access hides the store without charging a card', async () => {
  await accept((await quote()).quoteId);
  await Subscription.updateOne({ _id: sub._id }, { $set: { currentPeriodEnd: new Date(Date.now() - 60000) } });
  expect((await lifecycle.refreshStatus(sub._id)).status).toBe('past_due');
  expect((await Store.findOne({ seller: seller._id })).isActive).toBe(false);
  expect(submit).not.toHaveBeenCalled();
});

test('a declined first invoice allows a new explicit enrollment without a free-period reset', async () => {
  sub.hasUsedFreePeriod = true; await sub.save();
  const result = await accept((await quote()).quoteId);
  const payment = await Payment.findById(result.paymentId);
  await mongoose.connection.transaction(session => billing.failBillingPayment(payment, session));
  expect((await Subscription.findById(sub._id)).safepayBilling.autoRenew).toBe(false);
  const fresh = await quote({ requestKey: 'new-paid-enrollment-fixture' });
  expect(fresh.dueNowMinor).toBe(999); expect(fresh.freePeriodDays).toBe(0);
});
