'use strict';

const STORE_PAYMENT_POLICIES = Object.freeze({
  ONLINE_AND_COD: 'online_and_cod',
  ADVANCE_ONLY: 'advance_only',
});

const PAYMENT_POLICY_LABELS = Object.freeze({
  [STORE_PAYMENT_POLICIES.ONLINE_AND_COD]: 'Online payment and Cash on Delivery',
  [STORE_PAYMENT_POLICIES.ADVANCE_ONLY]: 'Advance online payment only',
});

function normalizeStorePaymentPolicy(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['advance_only', 'online_only', 'stripe_only', 'card_only', 'advance', 'prepaid'].includes(raw)) {
    return STORE_PAYMENT_POLICIES.ADVANCE_ONLY;
  }
  return STORE_PAYMENT_POLICIES.ONLINE_AND_COD;
}

function storeAllowsCashOnDelivery(store) {
  return normalizeStorePaymentPolicy(store?.paymentPolicy) === STORE_PAYMENT_POLICIES.ONLINE_AND_COD;
}

module.exports = {
  STORE_PAYMENT_POLICIES,
  PAYMENT_POLICY_LABELS,
  normalizeStorePaymentPolicy,
  storeAllowsCashOnDelivery,
};
