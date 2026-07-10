const {
  STORE_PAYMENT_POLICIES,
  normalizeStorePaymentPolicy,
  storeAllowsCashOnDelivery,
} = require('../../services/storePaymentPolicyService');

describe('storePaymentPolicyService', () => {
  test('defaults missing or unknown values to online plus COD', () => {
    expect(normalizeStorePaymentPolicy(undefined)).toBe(STORE_PAYMENT_POLICIES.ONLINE_AND_COD);
    expect(normalizeStorePaymentPolicy('unexpected')).toBe(STORE_PAYMENT_POLICIES.ONLINE_AND_COD);
    expect(storeAllowsCashOnDelivery({})).toBe(true);
  });

  test('normalizes advance-only aliases and blocks COD', () => {
    expect(normalizeStorePaymentPolicy('advance_only')).toBe(STORE_PAYMENT_POLICIES.ADVANCE_ONLY);
    expect(normalizeStorePaymentPolicy('online_only')).toBe(STORE_PAYMENT_POLICIES.ADVANCE_ONLY);
    expect(normalizeStorePaymentPolicy('card_only')).toBe(STORE_PAYMENT_POLICIES.ADVANCE_ONLY);
    expect(storeAllowsCashOnDelivery({ paymentPolicy: 'advance_only' })).toBe(false);
  });
});
