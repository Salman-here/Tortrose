const { externalRefundCapability, requireExternalRefundRail } = require('../../services/safepayRefundCapabilityService');

test('only a documented current card rail is externally refundable', () => {
  expect(externalRefundCapability('card')).toMatchObject({ available: true, label: 'Original card' });
  for (const rail of ['raast', 'unknown', undefined, 'browser-selected-card']) {
    expect(externalRefundCapability(rail)).toMatchObject({ available: false, reason: expect.any(String) });
  }
});

test('fresh Raast or unknown evidence is rejected before external mutation even with stale card labels', () => {
  const payment = { currency: 'PKR', providerMode: 'payment', amountMinor: 10000 };
  expect(() => requireExternalRefundRail({ intent: 'RAAST', mode: 'payment' }, payment)).toThrow(expect.objectContaining({
    code: 'SAFEPAY_RAAST_REFUND_UNAVAILABLE', definitiveNoMutation: true }));
  expect(() => requireExternalRefundRail({}, { ...payment, paymentRail: 'card', appliedAt: new Date() })).toThrow(expect.objectContaining({
    code: 'SAFEPAY_REFUND_RAIL_UNVERIFIED', definitiveNoMutation: true }));
  expect(requireExternalRefundRail({ intent: 'CYBERSOURCE' }, payment).available).toBe(true);
});

test('a conflicting rail or Raast outside PKR cannot authorize a refund', () => {
  expect(() => requireExternalRefundRail({ intent: 'RAAST', mode: 'payment' }, { currency: 'USD' })).toThrow();
  expect(() => requireExternalRefundRail({ intent: 'RAAST', mode: 'payment' }, {
    currency: 'PKR', amountMinor: 10000, paymentRail: 'card', appliedAt: new Date(), providerIntent: 'CYBERSOURCE' })).toThrow(expect.objectContaining({ code: 'SAFEPAY_PAYMENT_RAIL_CHANGED' }));
});
