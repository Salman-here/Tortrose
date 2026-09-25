'use strict';
const { safepayPaymentFacts, assertSafepayOrderBinding } = require('../../services/safepayPaymentFacts');

test.each(['TRACKER_STARTED', 'TRACKER_ENROLLED', 'TRACKER_AUTHORIZED'])('%s is not paid or safe to release', state => {
  expect(safepayPaymentFacts({ state }).outcome).toBe('pending');
});
test.each(['TRACKER_CANCELLED', 'TRACKER_EXPIRED'])('%s authoritatively closes an unpaid attempt', state => {
  expect(safepayPaymentFacts({ state }).outcome).toBe('closed');
});
test('only ended means paid; reversals and unrecognized statuses never silently credit money', () => {
  expect(safepayPaymentFacts({ state: 'TRACKER_ENDED' }).outcome).toBe('paid');
  for (const state of ['TRACKER_DISPUTED', 'TRACKER_REVERSED', 'TRACKER_VOIDED', 'TRACKER_REFUNDED', 'TRACKER_PARTIAL_REFUND']) {
    expect(safepayPaymentFacts({ state }).outcome).toBe('risk');
  }
  for (const state of ['success', '', null, undefined]) expect(() => safepayPaymentFacts({ state })).toThrow();
});
test('order binding covers buyer, provider, environment, exact amount, currency and stored references', () => {
  const payment = { _id: 'payment', order: 'order', purpose: 'order', user: 'buyer', environment: 'sandbox', amountMinor: 12345, currency: 'PKR', tracker: 'track_owned' };
  const order = { _id: 'order', user: 'buyer', paymentMethod: 'safepay', safepayPaymentId: 'payment', safepayEnvironment: 'sandbox', currency: 'PKR', safepayTrackerId: 'track_owned' };
  expect(() => assertSafepayOrderBinding(order, payment, 12345)).not.toThrow();
  for (const patch of [{ user: 'other' }, { safepayEnvironment: 'production' }, { paymentMethod: 'stripe' }, { safepayPaymentId: 'another' }, { currency: 'USD' }, { safepayTrackerId: 'track_other' }]) {
    expect(() => assertSafepayOrderBinding({ ...order, ...patch }, payment, 12345)).toThrow();
  }
  expect(() => assertSafepayOrderBinding(order, payment, 12346)).toThrow();
});
