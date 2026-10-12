'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Customer = require('../../models/SafepayCustomer');
const Payment = require('../../models/SafepayPayment');
const Subscription = require('../../models/SellerSubscription');
const { createSafepayPaymentService, paymentResponse } = require('../../services/safepayPaymentService');
const { verifySavedSetupCard } = require('../../services/safepayCardSetupService');
const config = { environment: 'sandbox', publicKey: 'sec_card-setup-fixture' };
const customerId = 'cus_card-setup-fixture', buyer = new mongoose.Types.ObjectId();
const at = new Date('2026-10-12T12:00:00Z');
const card = (token, last4 = '1111', patch = {}) => ({ token, customer: customerId, merchant_api_key: config.publicKey,
  is_deleted: false, max_usage: -1, expires_at: { seconds: 2100000000 },
  cybersource: { token: 'tms_private-fixture', bin: '520000', last_four: last4, expiry_month: '12', expiry_year: '2030' }, ...patch });
const trackerFor = (payment, last4 = '1111', patch = {}) => ({ token: payment.tracker, state: 'TRACKER_ENDED', intent: 'CYBERSOURCE',
  attempts: [{ token: 'attempt_fixture', tracker: payment.tracker, mode: 'instrument', is_success: true,
    customer: { token: customerId }, payment_method: { tracker: payment.tracker, attempt: 'attempt_fixture',
      bin: '520000', last_four: last4, expiration_month: '12', expiration_year: '2030', do_card_on_file: false } }], ...patch });
let replica, service, client, link, wallet, sequence;
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Promise.all([Customer, Payment, Subscription].map(model => model.init()));
}, 60000);
afterAll(async () => { await mongoose.disconnect(); await replica?.stop(); });
beforeEach(async () => {
  await Promise.all([Customer, Payment, Subscription].map(model => model.deleteMany({})));
  sequence = 0; wallet = [card('pm_existing-card', '2222')];
  link = await Customer.create({ user: buyer, environment: 'sandbox', customerId, status: 'ready', defaultCardId: wallet[0].token });
  client = { listCards: jest.fn(async () => wallet), getCard: jest.fn(async (customer, id) => wallet.find(c => c.token === id)),
    getTracker: jest.fn(async (id, payment) => trackerFor(payment)) };
  service = createSafepayPaymentService({ configFor: () => config, clientFor: () => client, now: () => at,
    settle: jest.fn(), close: jest.fn(), quarantine: jest.fn() });
});
async function setup() {
  const payment = await service.ensurePayment({ user: buyer, customerId, purpose: 'card_setup',
    requestKey: `card-setup-fixture-${++sequence}`, reference: `card:setup-fixture-${sequence}`, currency: 'PKR', amountMinor: 0,
    terms: { consentVersion: 'safepay-card-storage-v1', reusableRequired: true } });
  payment.tracker = `track_fixture-${sequence}`; payment.status = 'ready'; await payment.save();
  return payment;
}
const currentDefault = async () => (await Customer.findById(link._id).select('+defaultCardId')).defaultCardId;

test('successful zero-value setup makes the exact reusable card default even without the hosted checkbox', async () => {
  await Subscription.create({ seller: buyer, plan: 'elite', status: 'active', billingProvider: 'safepay',
    safepayBilling: { environment: 'sandbox', customerId, cardId: 'pm_existing-card' } });
  const payment = await setup(); wallet.push(card('pm_new-card'));
  const finished = await service.reconcilePayment(payment._id);
  expect(paymentResponse(finished)).toMatchObject({ status: 'authorized', cardSaved: true, completed: true, savedPaymentMethodId: 'pm_new-card' });
  expect(finished.cardSetup.defaultAppliedAt).toEqual(at);
  expect(await currentDefault()).toBe('pm_new-card');
  expect((await Subscription.findOne({ seller: buyer }).select('+safepayBilling.cardId')).safepayBilling.cardId).toBe('pm_existing-card');
  expect(finished.capturedMinor).toBe(0); expect(finished.paidAt).toBeNull();
});
test('the first card becomes default, and a re-added unique existing card can also become default', async () => {
  wallet = []; const first = await setup(); wallet = [card('pm_first-card')];
  await service.reconcilePayment(first._id); expect(await currentDefault()).toBe('pm_first-card');
  await Customer.updateOne({ _id: link._id }, { $set: { defaultCardId: null } });
  const readded = await setup(); await service.reconcilePayment(readded._id);
  expect(await currentDefault()).toBe('pm_first-card');
});
test('retrying a setup keeps its original snapshot and does not re-list or create another attempt', async () => {
  const payment = await setup(); wallet.push(card('pm_new-card'));
  const retried = await service.ensurePayment({ user: buyer, customerId, purpose: 'card_setup',
    requestKey: 'card-setup-fixture-1', reference: 'card:setup-fixture-1', currency: 'PKR', amountMinor: 0,
    terms: { consentVersion: 'safepay-card-storage-v1', reusableRequired: true } });
  expect(String(retried._id)).toBe(String(payment._id));
  expect(retried.cardSetup.existingCardIds).toEqual(['pm_existing-card']);
  expect(client.listCards).toHaveBeenCalledTimes(1);
});
test('completed setup replay cannot undo a later manual selection', async () => {
  const payment = await setup(); wallet.push(card('pm_new-card'));
  await service.reconcilePayment(payment._id);
  await Customer.updateOne({ _id: link._id }, { $set: { defaultCardId: 'pm_existing-card', defaultCardSetupOrder: '' }, $inc: { defaultCardManualRevision: 1 } });
  await service.reconcilePayment(payment._id);
  expect(await currentDefault()).toBe('pm_existing-card');
  expect(client.listCards).toHaveBeenCalledTimes(2);
});
test('manual selection made while a setup is open takes precedence', async () => {
  const payment = await setup(); wallet.push(card('pm_new-card'));
  await Customer.updateOne({ _id: link._id }, { $inc: { defaultCardManualRevision: 1 } });
  const finished = await service.reconcilePayment(payment._id);
  expect(await currentDefault()).toBe('pm_existing-card');
  expect(finished.cardSetup.savedCardId).toBe('pm_new-card');
  expect(finished.cardSetup.defaultAppliedAt).toBeNull();
});
test.each([true, false])('newer setup remains default independent of completion order: newest first %s', async newestFirst => {
  const older = await setup(), newer = await setup();
  wallet.push(card('pm_older-card'), card('pm_newer-card', '3333'));
  client.getTracker.mockImplementation(async (id, payment) => trackerFor(payment, String(payment._id) === String(newer._id) ? '3333' : '1111'));
  for (const payment of newestFirst ? [newer, older] : [older, newer]) await service.reconcilePayment(payment._id);
  expect(await currentDefault()).toBe('pm_newer-card');
});
test.each(['TRACKER_STARTED', 'TRACKER_CANCELLED', 'TRACKER_EXPIRED'])('%s never changes the default', async state => {
  const payment = await setup(); wallet.push(card('pm_new-card'));
  client.getTracker.mockResolvedValue(trackerFor(payment, '1111', { state }));
  const finished = await service.reconcilePayment(payment._id);
  expect(await currentDefault()).toBe('pm_existing-card');
  expect(paymentResponse(finished).cardSaved).toBe(false);
});
test.each(['no-new-card', 'single-use', 'expired', 'deleted', 'other-owner', 'other-merchant', 'ambiguous', 'wrong-mask', 'wrong-attempt', 'no-attempt'])('does not authorize setup or change default on %s evidence', async kind => {
  const payment = await setup();
  if (kind !== 'no-new-card') wallet.push(card('pm_new-card', kind === 'wrong-mask' ? '4444' : '1111', {
    ...(kind === 'single-use' ? { max_usage: 1 } : {}), ...(kind === 'expired' ? { expires_at: { seconds: 1 } } : {}),
    ...(kind === 'deleted' ? { is_deleted: true } : {}), ...(kind === 'other-owner' ? { customer: 'cus_foreign-owner' } : {}),
    ...(kind === 'other-merchant' ? { merchant_api_key: 'sec_other-merchant' } : {}),
  }));
  if (kind === 'ambiguous') wallet.push(card('pm_duplicate-card'));
  const tracker = trackerFor(payment);
  if (kind === 'wrong-attempt') tracker.attempts[0].payment_method.attempt = 'unrelated';
  if (kind === 'no-attempt') tracker.attempts = [];
  client.getTracker.mockResolvedValue(tracker);
  await expect(service.reconcilePayment(payment._id)).rejects.toMatchObject({ code: expect.stringMatching(/^SAFEPAY_(SAVED_CARD_PENDING|CARD_MISMATCH)$/) });
  const unfinished = await Payment.findById(payment._id);
  expect(unfinished.appliedAt).toBeNull(); expect(paymentResponse(unfinished).cardSaved).toBe(false);
  expect(await currentDefault()).toBe('pm_existing-card');
});
test('eventual wallet visibility can finish the same setup without a duplicate tracker', async () => {
  const payment = await setup();
  await expect(service.reconcilePayment(payment._id)).rejects.toMatchObject({ code: 'SAFEPAY_SAVED_CARD_PENDING' });
  wallet.push(card('pm_new-card')); await service.reconcilePayment(payment._id);
  expect(await currentDefault()).toBe('pm_new-card'); expect(await Payment.countDocuments()).toBe(1);
});
test.each(['deleting', 'closed', 'changed-customer'])('completion cannot select a card in a %s profile', async reason => {
  const payment = await setup(); wallet.push(card('pm_new-card'));
  await Customer.updateOne({ _id: link._id }, { $set: reason === 'deleting' ? { deletingCardId: 'pm_new-card' }
    : reason === 'closed' ? { status: 'deleted' } : { customerId: 'cus_changed-profile' } });
  await expect(service.reconcilePayment(payment._id)).rejects.toMatchObject({ code: 'SAFEPAY_SAVED_CARD_PENDING' });
  expect(await currentDefault()).toBe('pm_existing-card');
});
test('provider re-read must still return the exact owned reusable card', async () => {
  const payment = await setup(); wallet.push(card('pm_new-card'));
  client.getCard.mockResolvedValue(card('pm_new-card', '9999'));
  await expect(verifySavedSetupCard(payment, trackerFor(payment), config, client, at)).rejects.toMatchObject({ code: 'SAFEPAY_SAVED_CARD_PENDING' });
  expect(await currentDefault()).toBe('pm_existing-card');
});
test('an unavailable customer cannot snapshot cards or create a payment', async () => {
  await Customer.updateOne({ _id: link._id }, { $set: { status: 'deleted' } });
  await expect(setup()).rejects.toMatchObject({ code: 'SAFEPAY_CUSTOMER_MISMATCH' });
  expect(client.listCards).not.toHaveBeenCalled(); expect(await Payment.countDocuments()).toBe(0);
});
test('legacy customer fields can safely receive their first automatic default without migration', async () => {
  await Customer.collection.updateOne({ _id: link._id }, { $unset: { defaultCardManualRevision: '', defaultCardSetupOrder: '' } });
  const payment = await setup(); wallet.push(card('pm_new-card'));
  await service.reconcilePayment(payment._id);
  expect(await currentDefault()).toBe('pm_new-card');
});
test('default selection and card completion roll back together on persistence failure', async () => {
  const payment = await setup(); wallet.push(card('pm_new-card'));
  const saving = jest.spyOn(Payment.prototype, 'save').mockRejectedValueOnce(Object.assign(new Error('Persistence unavailable'), { code: 'TEST_SAVE_FAILED' }));
  try { await expect(service.reconcilePayment(payment._id)).rejects.toMatchObject({ code: 'TEST_SAVE_FAILED' }); }
  finally { saving.mockRestore(); }
  expect(await currentDefault()).toBe('pm_existing-card');
  expect((await Payment.findById(payment._id)).appliedAt).toBeNull();
  await service.reconcilePayment(payment._id); expect(await currentDefault()).toBe('pm_new-card');
});
test.each(['owner', 'environment'])('setup cannot use a different %s customer', async reason => {
  const other = createSafepayPaymentService({ configFor: () => ({ ...config, environment: reason === 'environment' ? 'production' : 'sandbox' }), clientFor: () => client });
  await expect(other.ensurePayment({ user: reason === 'owner' ? new mongoose.Types.ObjectId() : buyer, customerId,
    purpose: 'card_setup', requestKey: 'foreign-card-setup', reference: 'card:foreign-setup', currency: 'PKR', amountMinor: 0 }))
    .rejects.toMatchObject({ code: 'SAFEPAY_CUSTOMER_MISMATCH' });
  expect(await Payment.countDocuments()).toBe(0); expect(client.listCards).not.toHaveBeenCalled();
});
