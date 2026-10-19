'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Payment = require('../../models/SafepayPayment');
const Customer = require('../../models/SafepayCustomer');
const Contact = require('../../models/SafepayCheckoutContact');
const Address = require('../../models/SafepayCheckoutAddress');
const { POLICY: ADDRESS_POLICY } = require('../../services/safepayCheckoutAddressService');
const { POLICY: CHECKOUT_CONTACT_POLICY } = require('../../services/safepayCheckoutContactService');
const { createSafepayClient } = require('../../services/safepayClient');
const { createSafepayPaymentService, fingerprint } = require('../../services/safepayPaymentService');
let replica;
let clock;
let client;
let settle;
let quarantine;
let service;
let providerState;
const config = { environment: 'sandbox', publicKey: 'sec_fixture-sandbox', secretKey: 'private-fixture', checkoutHost: 'https://sandbox.api.getsafepay.com' };
const buyer = new mongoose.Types.ObjectId();
const input = () => ({ user: buyer, purpose: 'wallet_top_up', reference: 'wallet:fixture-reference', requestKey: 'attempt-fixture-key', amountMinor: 12345, currency: 'PKR' });

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Payment.init();
}, 60000);
afterAll(async () => { await mongoose.disconnect(); await replica?.stop(); });
beforeEach(async () => {
  await Payment.deleteMany({});
  await Customer.deleteMany({});
  await Contact.deleteMany({});
  await Address.deleteMany({});
  await mongoose.connection.collection('safepay_test_effects').deleteMany({});
  clock = new Date('2026-09-25T10:00:00Z');
  providerState = 'TRACKER_STARTED';
  const tracker = () => ({ token: 'track_fixture-owned-payment', state: providerState });
  client = { createTracker: jest.fn(async () => tracker()), getTracker: jest.fn(async () => tracker()),
    findTrackerByReference: jest.fn(async () => tracker()), createAuthToken: jest.fn(async () => 'temporary-checkout-token'),
    buildPaymentCheckoutUrl: createSafepayClient({ config }).buildPaymentCheckoutUrl };
  settle = jest.fn(async (payment, provider, session) => {
    await mongoose.connection.collection('safepay_test_effects').insertOne({ _id: payment._id, amount: payment.amountMinor }, { session });
  });
  quarantine = jest.fn(async () => {});
  service = createSafepayPaymentService({ configFor: () => config, clientFor: () => client, settle, quarantine, close: async () => {}, now: () => clock,
    savedCheckoutFor: payment => `https://rozare.up.railway.app/api/safepay/saved-checkout/${payment._id}#ticket=test-checkout-ticket` });
});

test('same attempt is reused and any amount or currency change is rejected', async () => {
  const payment = await service.ensurePayment(input());
  expect(String((await service.ensurePayment(input()))._id)).toBe(String(payment._id));
  for (const patch of [{ amountMinor: 12346 }, { currency: 'USD' }, { reference: 'different-reference' }]) {
    await expect(service.ensurePayment({ ...input(), ...patch })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  }
  expect(await Payment.countDocuments()).toBe(1);
});

test('billing address prefill is frozen to an owned reference and reopening cannot create another payment', async () => {
  await Address.create({ user: buyer, environment: 'sandbox', addressId: 'address_owned-fixture', addressHash: 'a'.repeat(64), status: 'ready' });
  const data = { ...input(), purpose: 'order', checkoutAddressId: 'address_owned-fixture',
    terms: { checkoutAddressPolicy: ADDRESS_POLICY, checkoutAddressHash: 'a'.repeat(64) } };
  const payment = await service.ensurePayment(data);
  expect(String((await service.ensurePayment(data))._id)).toBe(String(payment._id));
  const update = jest.spyOn(require('../../models/Order'), 'updateOne').mockResolvedValue({ matchedCount: 1 });
  try {
    const first = await service.prepareCheckout(payment._id, { clientSurface: 'web' });
    const again = await service.prepareCheckout(payment._id, { clientSurface: 'mobile' });
    expect(new URL(first.checkoutUrl).searchParams.get('address')).toBe('address_owned-fixture');
    expect(again.paymentId).toBe(first.paymentId); expect(client.createTracker).toHaveBeenCalledTimes(1);
    expect(await Payment.countDocuments()).toBe(1); expect(payment.capturedMinor).toBe(0);
  } finally { update.mockRestore(); }
});
test.each([{ user: new mongoose.Types.ObjectId() }, { environment: 'production' }, { addressHash: 'b'.repeat(64) }, { status: 'creating' }])(
  'cannot bind a foreign or unverified address: %j', async patch => {
    await Address.create({ user: buyer, environment: 'sandbox', addressId: 'address_owned-fixture', addressHash: 'a'.repeat(64), status: 'ready', ...patch });
    await expect(service.ensurePayment({ ...input(), purpose: 'order', checkoutAddressId: 'address_owned-fixture',
      terms: { checkoutAddressPolicy: ADDRESS_POLICY, checkoutAddressHash: 'a'.repeat(64) } })).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_ADDRESS_MISMATCH' });
    expect(await Payment.countDocuments()).toBe(0);
  });

test('standard checkout freezes an owned guest contact, uses provider prefill and does not become a card setup', async () => {
  const contact = await Contact.create({ user: buyer, environment: 'sandbox', status: 'ready',
    customerId: 'cus_prefill-fixture', contactHash: 'a'.repeat(64) });
  const value = { ...input(), purpose: 'order', customerId: contact.customerId,
    terms: { checkoutContactPolicy: CHECKOUT_CONTACT_POLICY, checkoutContactHash: contact.contactHash } };
  const payment = await service.ensurePayment(value);
  expect(String((await service.ensurePayment(value))._id)).toBe(String(payment._id));
  expect(payment.customerId).toBeNull();
  expect(payment.checkoutContactId).toBe(contact.customerId);
  expect(payment.cardSetup.selectionPolicy).toBe('');
  expect(payment.providerEntryMode).toBe('');
  expect(await Customer.countDocuments()).toBe(0);
  const update = jest.spyOn(require('../../models/Order'), 'updateOne').mockResolvedValue({ matchedCount: 1 });
  try {
    const checkout = await service.prepareCheckout(payment._id);
    expect(checkout.checkoutPresentation).toBe('browser');
    const url = new URL(checkout.checkoutUrl);
    expect(url.pathname).toBe('/embedded/');
    expect(url.searchParams.get('user_id')).toBe(contact.customerId);
    expect(url.searchParams.has('is_implicit')).toBe(false);
    expect(client.createTracker.mock.calls[0][0].customerId).toBeNull();
    expect(client.createTracker.mock.calls[0][0].checkoutContactId).toBe(contact.customerId);
    expect((await service.prepareCheckout(payment._id)).paymentId).toBe(checkout.paymentId);
    expect(client.createTracker).toHaveBeenCalledTimes(1);
  } finally { update.mockRestore(); }
});

test('legacy merchant-bound prefill cannot silently replace its tracker or bypass authentication', async () => {
  const value = { ...input(), purpose: 'order', customerId: 'cus_prefill-fixture',
    terms: { checkoutContactPolicy: CHECKOUT_CONTACT_POLICY, checkoutContactHash: 'a'.repeat(64) } };
  const terms = { user: String(buyer), purpose: value.purpose, reference: value.reference,
    amountMinor: value.amountMinor, currency: value.currency, order: '', store: '', returnRequest: '',
    terms: value.terms, customerId: value.customerId };
  const legacy = await Payment.create({ ...value, environment: 'sandbox', fingerprint: fingerprint(terms),
    providerMode: 'payment', status: 'ready', tracker: 'track_fixture-owned-payment' });
  expect(String((await service.ensurePayment(value))._id)).toBe(String(legacy._id));
  await expect(service.prepareCheckout(legacy._id)).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_RESTART_REQUIRED' });
  expect(client.createTracker).not.toHaveBeenCalled(); expect(client.createAuthToken).not.toHaveBeenCalled();
  const same = await Payment.findById(legacy._id);
  expect(same.tracker).toBe(legacy.tracker); expect(same.customerId).toBe(value.customerId);
  expect(same.checkoutContactId).toBeNull(); expect(same.capturedMinor).toBe(0);
  expect(await Payment.countDocuments()).toBe(1);
  // An old attempt that later really settles must still be reconciled once;
  // the presentation guard must not hide or undo a verified payment.
  providerState = 'TRACKER_ENDED';
  expect((await service.prepareCheckout(legacy._id)).status).toBe('paid');
  expect((await Payment.findById(legacy._id)).capturedMinor).toBe(value.amountMinor);
  expect(client.createTracker).not.toHaveBeenCalled();
});

test.each([
  { user: new mongoose.Types.ObjectId() }, { environment: 'production' }, { status: 'creating' }, { contactHash: 'b'.repeat(64) },
])('cannot bind a contact from another account, environment, state or shipping tuple: %j', async patch => {
  await Contact.create({ user: buyer, environment: 'sandbox', status: 'ready', customerId: 'cus_prefill-fixture', contactHash: 'a'.repeat(64), ...patch });
  await expect(service.ensurePayment({ ...input(), purpose: 'order', customerId: 'cus_prefill-fixture',
    terms: { checkoutContactPolicy: CHECKOUT_CONTACT_POLICY, checkoutContactHash: 'a'.repeat(64) } })).rejects.toMatchObject({ code: 'SAFEPAY_CUSTOMER_MISMATCH' });
  expect(await Payment.countDocuments()).toBe(0);
});

test('new contact prefill cannot retrofit a legacy null-bound attempt or be used as a saved card', async () => {
  const original = await service.ensurePayment({ ...input(), purpose: 'order' });
  await Contact.create({ user: buyer, environment: 'sandbox', status: 'ready', customerId: 'cus_prefill-fixture', contactHash: 'a'.repeat(64) });
  const proposed = { ...input(), purpose: 'order', customerId: 'cus_prefill-fixture',
    terms: { checkoutContactPolicy: CHECKOUT_CONTACT_POLICY, checkoutContactHash: 'a'.repeat(64) } };
  await expect(service.ensurePayment(proposed)).rejects.toMatchObject({ code: 'SAFEPAY_CUSTOMER_MISMATCH' });
  await expect(service.ensurePayment({ ...proposed, cardId: 'pm_owned-fixture' })).rejects.toMatchObject({ code: 'SAFEPAY_CARD_SELECTION_INVALID' });
  expect((await Payment.findById(original._id)).customerId).toBeNull();
  expect(await Payment.countDocuments()).toBe(1);
});

test.each(['order', 'wallet_top_up', 'subdomain', 'return_settlement'])('authenticated new-card %s checkout does not auto-attach a saved-card profile', async purpose => {
  await Customer.create({ user: buyer, environment: 'sandbox', customerId: 'cus_owned-fixture',
    status: 'ready', createdForCardConsentAt: clock });
  await Customer.create({ user: new mongoose.Types.ObjectId(), environment: 'sandbox', customerId: 'cus_other-fixture',
    status: 'ready', createdForCardConsentAt: clock });
  const payment = await service.ensurePayment({ ...input(), purpose });
  expect(payment.customerId).toBeNull();
  // This unit fixture has no catalog order; test its binding separately from
  // the real-order inventory/settlement suites.
  const orderUpdate = purpose === 'order' ? jest.spyOn(require('../../models/Order'), 'updateOne')
    .mockResolvedValue({ matchedCount: 1 }) : null;
  let checkout;
  try { checkout = await service.prepareCheckout(payment._id); }
  finally { orderUpdate?.mockRestore(); }
  expect(client.createTracker.mock.calls[0][0].customerId).toBeNull();
  expect(new URL(checkout.checkoutUrl).searchParams.has('user_id')).toBe(false);
  expect(payment.providerEntryMode).toBe('');
  expect(payment.providerMode).toBe('payment');
  expect(payment.chargeStartedAt).toBeNull();
});

test.each(['new', 'creating', 'deleted'])('a %s profile is never attached to a new purchase', async status => {
  await Customer.create({ user: buyer, environment: 'sandbox', customerId: 'cus_owned-fixture', status,
    createdForCardConsentAt: clock });
  expect((await service.ensurePayment(input())).customerId).toBeNull();
});

async function legacyMerchantCard(currency = 'PKR', patch = {}) {
  await Customer.create({ user: buyer, environment: 'sandbox', customerId: 'cus_owned-fixture', status: 'ready' });
  client.listCards = jest.fn().mockResolvedValue([]);
  const tracker = () => ({ token: 'track_fixture-owned-payment', state: 'TRACKER_STARTED',
    next_actions: { CYBERSOURCE: { kind: 'GENERATE_CAPTURE_CONTEXT' } } });
  client.createTracker.mockImplementation(async () => tracker());
  client.getTracker.mockImplementation(async () => tracker());
  const payment = await service.ensurePayment({ ...input(), purpose: 'order', currency,
    terms: { checkoutCardPolicy: require('../../services/safepayCheckoutCardService').POLICY } });
  if (Object.keys(patch).length) await Payment.updateOne({ _id: payment._id }, { $set: patch });
  return payment;
}

test.each(['PKR', 'USD', 'EUR', 'GBP'])('untouched legacy %s new-card attempts open standard checkout directly with the same frozen payment', async currency => {
  const payment = await legacyMerchantCard(currency);
  const updateOrder = jest.spyOn(require('../../models/Order'), 'updateOne').mockResolvedValue({ matchedCount: 1 });
  try {
    const first = await service.prepareCheckout(payment._id, { clientSurface: 'web' });
    const second = await service.prepareCheckout(payment._id, { clientSurface: 'mobile' });
    expect(first.checkoutPresentation).toBe('embedded');
    expect(second.paymentId).toBe(first.paymentId);
    const url = new URL(first.checkoutUrl);
    expect(url.hostname).toBe('sandbox.api.getsafepay.com');
    expect(url.pathname).toBe('/embedded/');
    expect(url.searchParams.get('user_id')).toBe('cus_owned-fixture');
    expect(url.searchParams.has('is_implicit')).toBe(false);
    expect(client.createTracker).toHaveBeenCalledTimes(1);
    const stored = await Payment.findById(payment._id);
    expect(stored.checkoutCard.hostedCheckoutAt).toBeInstanceOf(Date);
    expect(stored.checkoutCard.consentToSave).toBe(false);
    expect(stored.customerId).toBe(payment.customerId);
    expect(stored.fingerprint).toBe(payment.fingerprint);
    expect(stored.capturedMinor).toBe(0);
    expect(stored.chargeStartedAt).toBeNull();
    expect(await Payment.countDocuments()).toBe(1);
  } finally { updateOrder.mockRestore(); }
});

test.each([
  { 'checkoutCard.approvalStartedAt': new Date() },
  { 'savedCardAuthentication.setupStartedAt': new Date() },
  { 'savedCardAuthentication.encryptedContext': 'existing-bank-session' },
  { 'savedCardAuthentication.resetStartedAt': new Date() },
  { 'savedCardAuthentication.operationLeaseUntil': new Date('2030-01-01') },
])('an in-progress legacy bank verification is never reset to change its presentation: %j', async patch => {
  const payment = await legacyMerchantCard('PKR', patch);
  const updateOrder = jest.spyOn(require('../../models/Order'), 'updateOne').mockResolvedValue({ matchedCount: 1 });
  try {
    const result = await service.prepareCheckout(payment._id);
    expect(result.checkoutPresentation).toBe('saved-card');
    expect((await Payment.findById(payment._id)).checkoutCard.hostedCheckoutAt).toBeNull();
    expect(client.createAuthToken).not.toHaveBeenCalled();
    expect(client.createTracker).toHaveBeenCalledTimes(1);
  } finally { updateOrder.mockRestore(); }
});

test('losing the legacy presentation fence returns a controlled retry and never another payment', async () => {
  const payment = await legacyMerchantCard();
  const updateOrder = jest.spyOn(require('../../models/Order'), 'updateOne').mockResolvedValue({ matchedCount: 1 });
  const original = Payment.findOneAndUpdate;
  const fence = jest.spyOn(Payment, 'findOneAndUpdate').mockImplementation(function (filter, update, options) {
    if (update.$set?.['checkoutCard.hostedCheckoutAt']) return { select: async () => null };
    return original.call(this, filter, update, options);
  });
  try {
    await expect(service.prepareCheckout(payment._id)).rejects.toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS' });
    expect(await Payment.countDocuments()).toBe(1);
    expect(client.createTracker).toHaveBeenCalledTimes(1);
  } finally { fence.mockRestore(); updateOrder.mockRestore(); }
});

test('guest, unconsented and other-environment profiles never expose stored cards', async () => {
  await Customer.create({ user: buyer, environment: 'sandbox', customerId: 'cus_unconsented-fixture', status: 'ready' });
  await Customer.create({ user: buyer, environment: 'production', customerId: 'cus_live-fixture', status: 'ready', createdForCardConsentAt: clock });
  expect((await service.ensurePayment(input())).customerId).toBeNull();
  expect((await service.ensurePayment({ ...input(), user: null, purpose: 'order', reference: 'order:guest-fixture' })).customerId).toBeNull();
});

test('an existing checkout retains its profile after profile changes and cannot be rebound to another customer', async () => {
  await Customer.create({ user: buyer, environment: 'sandbox', customerId: 'cus_owned-fixture', status: 'ready', createdForCardConsentAt: clock });
  // Existing pre-fix hosted attempts keep their immutable identity. This
  // local fixture deliberately models that old binding, not a new purchase.
  const legacy = input();
  const payment = await Payment.create({ ...legacy, environment: 'sandbox', providerMode: 'payment',
    customerId: 'cus_owned-fixture', fingerprint: fingerprint({ user: String(buyer), purpose: legacy.purpose,
      reference: legacy.reference, amountMinor: legacy.amountMinor, currency: legacy.currency,
      order: '', store: '', returnRequest: '', terms: {}, customerId: 'cus_owned-fixture' }) });
  await Customer.updateOne({ user: buyer }, { $set: { customerId: 'cus_replacement-fixture' } });
  expect(String((await service.ensurePayment(input()))._id)).toBe(String(payment._id));
  await expect(service.ensurePayment({ ...input(), customerId: 'cus_replacement-fixture' })).rejects.toMatchObject({ code: 'SAFEPAY_CUSTOMER_MISMATCH' });
  client.getCard = jest.fn().mockRejectedValue(Object.assign(new Error('Not owned'), { code: 'SAFEPAY_CARD_MISMATCH' }));
  await expect(service.ensurePayment({ ...input(), cardId: 'pm_unapproved-fixture' })).rejects.toMatchObject({ code: 'SAFEPAY_CARD_SELECTION_INVALID' });
});

test.each(['order', 'wallet_top_up', 'subdomain', 'return_settlement'])('an explicitly selected reusable owned card creates a CIT %s tracker, not a subscription charge', async purpose => {
  await Customer.create({ user: buyer, environment: 'sandbox', customerId: 'cus_owned-fixture', status: 'ready', createdForCardConsentAt: clock });
  client.getCard = jest.fn().mockResolvedValue({ max_usage: -1, cybersource: { token: 'tms_test-fixture', last_four: '1111' }, expires_at: { seconds: 2100000000 } });
  const payment = await service.ensurePayment({ ...input(), purpose, cardId: 'pm_owned-fixture' });
  expect(payment.providerMode).toBe('payment');
  expect(payment.providerEntryMode).toBe('tms');
  expect(payment.cardId).toBe('pm_owned-fixture');
  expect(client.getCard).toHaveBeenCalledWith('cus_owned-fixture', 'pm_owned-fixture');
  const orderUpdate = purpose === 'order' ? jest.spyOn(require('../../models/Order'), 'updateOne')
    .mockResolvedValue({ matchedCount: 1 }) : null;
  try { await service.prepareCheckout(payment._id); }
  finally { orderUpdate?.mockRestore(); }
  expect(client.createTracker.mock.calls[0][0].providerEntryMode).toBe('tms');
  expect(payment.chargeStartedAt).toBeNull();
});

test('a new-card purchase cannot inject either an owned or another customer profile without selecting a card', async () => {
  await Customer.create({ user: buyer, environment: 'sandbox', customerId: 'cus_owned-fixture', status: 'ready', createdForCardConsentAt: clock });
  for (const customerId of ['cus_owned-fixture', 'cus_other-fixture']) {
    await expect(service.ensurePayment({ ...input(), customerId })).rejects.toMatchObject({ code: 'SAFEPAY_CUSTOMER_MISMATCH' });
  }
  expect(await Payment.countDocuments()).toBe(0);
});

test('adding a saved-card profile does not alter an older guest-style payment binding', async () => {
  const payment = await service.ensurePayment(input());
  await Customer.create({ user: buyer, environment: 'sandbox', customerId: 'cus_owned-fixture', status: 'ready', createdForCardConsentAt: clock });
  expect(String((await service.ensurePayment(input()))._id)).toBe(String(payment._id));
  expect((await Payment.findById(payment._id)).customerId).toBeNull();
});
test('simultaneous setup creates only one payable tracker', async () => {
  const payment = await service.ensurePayment(input());
  const results = await Promise.allSettled([service.prepareCheckout(payment._id), service.prepareCheckout(payment._id)]);
  expect(client.createTracker).toHaveBeenCalledTimes(1);
  expect(client.createTracker.mock.calls[0][1]).toEqual({ clientSurface: 'mobile' });
  expect(results.some(row => row.status === 'fulfilled' && row.value.checkoutUrl)).toBe(true);
  expect((await Payment.findById(payment._id)).status).toBe('ready');
});
test('web checkout uses the hosted source and fixed web bridge without creating a second tracker on reopen', async () => {
  const payment = await service.ensurePayment(input());
  const mobile = await service.prepareCheckout(payment._id);
  const web = await service.prepareCheckout(payment._id, { clientSurface: 'web' });
  expect(mobile.paymentId).toBe(web.paymentId);
  expect(client.createTracker).toHaveBeenCalledTimes(1);
  const url = new URL(web.checkoutUrl);
  expect(url.searchParams.get('source')).toBe('hosted');
  const redirect = new URL(url.searchParams.get('redirect_url'));
  expect(redirect.hostname).toBe('rozare.up.railway.app');
  expect(redirect.pathname).toBe(`/api/safepay/return/web/wallet_top_up/${payment._id}/return`);
  expect(redirect.search).toBe('');
  expect(new URL(url.searchParams.get('cancel_url')).pathname).toBe(`/api/safepay/return/web/wallet_top_up/${payment._id}/cancel`);
  const mobileReturn = new URL(new URL(mobile.checkoutUrl).searchParams.get('redirect_url'));
  expect(mobileReturn.pathname).toBe('/api/safepay/return');
  expect(mobileReturn.searchParams.get('attempt')).toBe(String(payment._id));
  expect(mobileReturn.searchParams.get('purpose')).toBe('wallet_top_up');
  expect(mobileReturn.searchParams.get('surface')).toBe('mobile');
  expect(mobileReturn.searchParams.get('outcome')).toBe('return');
  expect(new URL(mobile.checkoutUrl).searchParams.get('source')).toBe('hosted');
  expect(mobile.checkoutPresentation).toBe('browser');
  expect(mobileReturn.searchParams.get('browser')).toBe('1');
});

test('initial web tracker creation carries web provenance and reopening never creates another tracker', async () => {
  const payment = await service.ensurePayment(input());
  await service.prepareCheckout(payment._id, { clientSurface: 'web' });
  expect(client.createTracker.mock.calls[0][1]).toEqual({ clientSurface: 'web' });
  await service.prepareCheckout(payment._id, { clientSurface: 'mobile' });
  expect(client.createTracker).toHaveBeenCalledTimes(1);
});
test('unknown create outcome is recovered by reference without another mutation', async () => {
  const payment = await service.ensurePayment(input());
  client.createTracker.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'SAFEPAY_REQUEST_UNCERTAIN' }));
  await expect(service.prepareCheckout(payment._id)).rejects.toMatchObject({ code: 'SAFEPAY_REQUEST_UNCERTAIN' });
  expect((await Payment.findById(payment._id)).status).toBe('creating');
  clock = new Date(clock.getTime() + 30000);
  expect((await service.prepareCheckout(payment._id)).status).toBe('pending');
  expect(client.createTracker).toHaveBeenCalledTimes(1);
  expect(client.findTrackerByReference).toHaveBeenCalledTimes(1);
});
test('concurrent and repeated completion has exactly one transactional financial effect', async () => {
  const payment = await service.ensurePayment(input());
  await service.prepareCheckout(payment._id);
  providerState = 'TRACKER_ENDED';
  await Promise.all([service.reconcilePayment(payment._id), service.reconcilePayment(payment._id)]);
  await service.reconcilePayment(payment._id);
  expect(await mongoose.connection.collection('safepay_test_effects').countDocuments()).toBe(1);
  expect((await Payment.findById(payment._id)).status).toBe('paid');
  expect(settle).toHaveBeenCalledTimes(1);
});
test('failed local settlement rolls back financial effects and remains retryable', async () => {
  const payment = await service.ensurePayment(input());
  await service.prepareCheckout(payment._id);
  providerState = 'TRACKER_ENDED';
  settle.mockImplementationOnce(async (p, t, session) => {
    await mongoose.connection.collection('safepay_test_effects').insertOne({ _id: p._id }, { session });
    throw Object.assign(new Error('notification persistence failed'), { code: 'OUTBOX_FAILED' });
  });
  await expect(service.reconcilePayment(payment._id)).rejects.toMatchObject({ code: 'OUTBOX_FAILED' });
  expect(await mongoose.connection.collection('safepay_test_effects').countDocuments()).toBe(0);
  expect((await Payment.findById(payment._id)).appliedAt).toBeNull();
  await service.reconcilePayment(payment._id);
  expect(await mongoose.connection.collection('safepay_test_effects').countDocuments()).toBe(1);
});
test('refund before completion and a later stale paid event do not grant funds', async () => {
  const payment = await service.ensurePayment(input());
  await service.prepareCheckout(payment._id);
  providerState = 'TRACKER_REFUNDED';
  await service.reconcilePayment(payment._id);
  providerState = 'TRACKER_ENDED';
  await service.reconcilePayment(payment._id);
  expect(settle).not.toHaveBeenCalled();
  expect(quarantine).toHaveBeenCalled();
  expect((await Payment.findById(payment._id)).status).toBe('manual_review');
});
test('sandbox payment cannot be replayed against production credentials', async () => {
  const payment = await service.ensurePayment(input());
  const production = createSafepayPaymentService({ configFor: () => ({ ...config, environment: 'production' }), clientFor: () => client });
  await expect(production.prepareCheckout(payment._id)).rejects.toMatchObject({ code: 'SAFEPAY_ENVIRONMENT_MISMATCH' });
  expect(client.createTracker).not.toHaveBeenCalled();
});
