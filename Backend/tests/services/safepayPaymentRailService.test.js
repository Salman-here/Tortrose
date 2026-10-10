'use strict';
const { safepayPaymentRailFacts, safepayPaymentRailObservation, normalizeSafepayPaymentRail,
  RAAST_ATTEMPT_STATUSES } = require('../../services/safepayPaymentRailService');
const { safepayPaymentFacts } = require('../../services/safepayPaymentFacts');
const { requireTracker, createSafepayClient } = require('../../services/safepayClient');
const { paymentResponse } = require('../../services/safepayPaymentService');
const config = { environment: 'sandbox', publicKey: 'sec_owned-fixture', secretKey: 'only-a-test-secret', apiHost: 'https://example.invalid' };
const expected = { tracker: 'track_owned-rail', reference: 'order:owned-rail', amountMinor: 10000, currency: 'PKR', providerMode: 'payment', purpose: 'order' };
const tracker = () => ({ token: expected.tracker, environment: config.environment, client: config.publicKey,
  metadata: { order_id: expected.reference }, mode: 'payment', intent: 'RAAST', state: 'TRACKER_ENDED',
  purchase_totals: { quote_amount: { amount: 10000, currency: 'PKR' } } });

test('owned paid Raast reporter with no detail or card charge has a trusted rail but no invented attempt state', () => {
  const value = requireTracker(tracker(), expected, config);
  expect(safepayPaymentRailFacts(value, expected)).toEqual({ paymentRail: 'raast', providerIntent: 'RAAST', raastAttemptStatus: null });
  expect(safepayPaymentFacts(value).outcome).toBe('paid');
});

test.each(RAAST_ATTEMPT_STATUSES)('recognizes canonical Raast attempt %s independently from tracker settlement', status => {
  const value = { ...tracker(), state: 'TRACKER_STARTED', raast_payment: { status } };
  expect(safepayPaymentRailFacts(value, expected).raastAttemptStatus).toBe(status);
  expect(safepayPaymentFacts(value).outcome).toBe('pending');
});

test('legacy missing or unknown intent remains unknown; unrelated wrappers and browser hints supply no rail evidence', () => {
  const value = tracker(); delete value.intent;
  expect(safepayPaymentRailFacts({ ...value, raast_payment: { status: 'CAPTURED' } }, { ...expected, paymentRail: 'raast' })).toEqual({
    paymentRail: 'unknown', providerIntent: '', raastAttemptStatus: null });
  expect(safepayPaymentRailFacts({ ...value, intent: 'unknown-provider' }, expected).paymentRail).toBe('unknown');
  expect(safepayPaymentRailFacts({ ...tracker(), raast_payment: { status: 'made-up' } }, expected).raastAttemptStatus).toBeNull();
  expect(safepayPaymentRailFacts(value, { ...expected, providerMode: 'subscription' }).paymentRail).toBe('unknown');
});

test.each([
  { currency: 'USD' }, { providerMode: 'instrument' }, { providerMode: 'subscription' },
  { purpose: 'card_setup' }, { purpose: 'subscription' }, { providerEntryMode: 'tms' },
])('Raast rejects incompatible frozen terms %j', patch => {
  expect(() => safepayPaymentRailFacts(tracker(), { ...expected, ...patch })).toThrow('payment rail');
});

test.each(['tms', 'mit'])('Raast rejects card-only tracker entry mode %s', entry_mode => {
  expect(() => safepayPaymentRailFacts({ ...tracker(), entry_mode }, expected)).toThrow('payment rail');
});

test('fresh GET validates identity and money before returning rail evidence, including non-PKR Raast rejection', async () => {
  for (const patch of [{ client: 'sec_another-merchant' }, { token: 'track_another-order' },
    { metadata: { order_id: 'order:another-order' } },
    { purchase_totals: { quote_amount: { amount: 10001, currency: 'PKR' } } }]) {
    const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ data: { ...tracker(), ...patch } }) }));
    await expect(createSafepayClient({ config, fetchImpl }).getTracker(expected.tracker, expected)).rejects.toMatchObject({ code: 'SAFEPAY_PAYMENT_MISMATCH' });
    expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
  }
  const usd = { ...tracker(), purchase_totals: { quote_amount: { amount: 10000, currency: 'USD' } } };
  expect(() => requireTracker(usd, { ...expected, currency: 'USD' }, config)).toThrow('payment rail');
});

test('hosted intent switches before settlement, but a confirmed paid rail is pinned', () => {
  const at = new Date('2026-10-10T00:00:00Z');
  const payment = { ...expected, paymentRail: 'card', providerIntent: 'CYBERSOURCE' };
  expect(safepayPaymentRailObservation(payment, tracker(), at).paymentRail).toBe('raast');
  expect(() => safepayPaymentRailObservation({ ...payment, appliedAt: at }, tracker(), at)).toThrow('rail changed');
  const sparse = tracker(); delete sparse.intent;
  expect(safepayPaymentRailObservation({ ...payment, appliedAt: at, paymentRailObservedAt: at }, sparse, at)).toMatchObject({
    paymentRail: 'card', providerIntent: 'CYBERSOURCE', paymentRailObservedAt: at });
  expect(safepayPaymentRailObservation({ ...expected, paymentRail: 'unknown', appliedAt: at }, tracker(), at).paymentRail).toBe('raast');
});

test('capture pins a known rail before fulfillment, including sparse later reads and legacy safety records', () => {
  const capturedAt = new Date('2026-10-10T00:00:00Z'), later = new Date('2026-10-10T00:01:00Z');
  const pending = { ...expected, paymentRail: 'card', providerIntent: 'CYBERSOURCE', appliedAt: null, capturedMinor: 0 };
  const captured = { ...pending, ...safepayPaymentRailObservation(pending, tracker(), capturedAt) };
  expect(captured).toMatchObject({ paymentRail: 'raast', paymentRailCapturedAt: capturedAt });
  const sparse = tracker(); delete sparse.intent;
  expect(safepayPaymentRailObservation(captured, sparse, later)).toMatchObject({ paymentRail: 'raast', providerIntent: 'RAAST', paymentRailCapturedAt: capturedAt });
  expect(() => safepayPaymentRailObservation(captured, { ...tracker(), intent: 'CYBERSOURCE' }, later)).toThrow('rail changed after capture');
  const legacy = { ...expected, paymentRail: 'raast', providerIntent: 'RAAST', capturedMinor: 10000, paidAt: capturedAt, appliedAt: null };
  expect(() => safepayPaymentRailObservation(legacy, { ...tracker(), intent: 'CYBERSOURCE' }, later)).toThrow('rail changed');
  expect(safepayPaymentRailObservation(legacy, sparse, later).paymentRail).toBe('raast');
});

test('Raast gating uses the exact currency and mode, not customer geography', () => {
  expect(safepayPaymentRailFacts(tracker(), { ...expected, country: 'Canada', countryCode: 'CA', ipCountry: 'US' }).paymentRail).toBe('raast');
});

test('API response returns only sanitized rail and canonical attempt states', () => {
  const base = { _id: 'payment', purpose: 'order', status: 'paid', appliedAt: new Date(), amountMinor: 10000,
    currency: 'PKR', environment: 'sandbox', riskPending: false };
  expect(paymentResponse({ ...base, paymentRail: 'raast', raastAttemptStatus: 'SETTLED' })).toMatchObject({ paymentRail: 'raast', raastAttemptStatus: 'SETTLED', isPaid: true });
  expect(paymentResponse({ ...base, paymentRail: 'card', raastAttemptStatus: 'SETTLED' }).raastAttemptStatus).toBeNull();
  expect(paymentResponse({ ...base, paymentRail: 'malicious', raastAttemptStatus: 'arbitrary' })).toMatchObject({ paymentRail: 'unknown', raastAttemptStatus: null });
  expect(normalizeSafepayPaymentRail(undefined)).toBe('unknown');
});
