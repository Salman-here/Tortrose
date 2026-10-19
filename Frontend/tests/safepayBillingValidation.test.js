import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getSafepayCheckoutNameError, getSafepayBillingFieldErrors } from '../src/utils/safepayBillingValidation.js';

test('web and mobile share the exact billing-validation contract', () => {
  const web = readFileSync(new URL('../src/utils/safepayBillingValidation.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const mobile = readFileSync(new URL('../../MobileApp/src/utils/safepayBillingValidation.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(web, mobile);
});

test('first-time Safepay accepts complete names and highlights incomplete names, not COD/Wallet recipients', () => {
  const context = { paymentMethod: 'safepay', billingProfileReady: false };
  assert.equal(getSafepayCheckoutNameError('Salman', context), 'Enter your first name and last name.');
  assert.equal(getSafepayCheckoutNameError('  محمد   علی  ', context), null);
  for (const override of [{ paymentMethod: 'wallet' }, { paymentMethod: 'cash_on_delivery' },
    { billingProfileReady: true }, { billingProfileReady: null }, { selectedCardId: 'pm_owned-fixture' }, { paymentRequired: false }]) {
    assert.equal(getSafepayCheckoutNameError('Salman', { ...context, ...override }), null);
  }
  assert.deepEqual(Object.keys(getSafepayBillingFieldErrors({ response: { data: {
    code: 'SAFEPAY_BILLING_PROFILE_REQUIRED', fields: ['fullName', 'card_number'],
  } } })), ['fullName']);
});

test('web uses standard checkout without requiring a merchant billing profile and retains field correction recovery', () => {
  const source = readFileSync(new URL('../src/components/layout/Checkout.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /billingNameError|getSafepayCheckoutNameError|as shown on your card/);
  assert.match(source, /required: "Enter your first name and last name\."/);
  assert.match(source, /showShippingFieldErrors\(billingErrors\)/);
  assert.match(source, /onAnimationComplete={[\s\S]*?setFocus\(field\)/);
  assert.match(source, /handleSubmit\(onPlaceOrder, invalid =>/);
  assert.match(source, /shouldFocus: true/);
});
