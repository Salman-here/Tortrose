import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getOrderPaymentLabel, getOriginalPaymentLabel, getOriginalPaymentRefundCopy, getSafepayCheckoutLabel, getSafepayPaymentRail } from '../src/utils/paymentPresentation.js';

test('only server rail evidence distinguishes card and PKR Raast from neutral Safepay', () => {
  const order = { paymentMethod: 'safepay', currency: 'PKR' };
  assert.equal(getOrderPaymentLabel(order), 'Safepay');
  assert.equal(getOrderPaymentLabel({ ...order, savedCardId: 'pm_fixture', checkoutPresentation: 'saved-card' }), 'Safepay');
  assert.equal(getOrderPaymentLabel({ ...order, safepayPaymentRail: 'card' }), 'Card (Safepay)');
  assert.equal(getOrderPaymentLabel({ ...order, safepayPaymentRail: 'raast' }), 'Raast (Safepay)');
  for (const changed of [{ safepayPaymentRail: 'stripe' }, { safepayPaymentRail: 'raast', currency: 'USD' },
    { safepayPaymentRail: 'card', paymentRail: 'raast' }]) assert.equal(getOrderPaymentLabel({ ...order, ...changed }), 'Safepay');
  assert.equal(getSafepayPaymentRail(null), 'unknown');
  assert.equal(getOrderPaymentLabel({ paymentMethod: 'wallet' }), 'Rozare Wallet');
  assert.equal(getOrderPaymentLabel({ paymentMethod: 'cash_on_delivery' }), 'Cash on Delivery');
});

test('checkout advertises Raast only for PKR and refunds do not promise an unsupported bank route', () => {
  assert.match(getSafepayCheckoutLabel('PKR'), /Raast/);
  for (const currency of ['USD', 'EUR', 'GBP', undefined]) assert.doesNotMatch(getSafepayCheckoutLabel(currency), /Raast/);
  assert.equal(getOriginalPaymentLabel({ paymentRail: 'raast', currency: 'PKR' }), 'Original Raast payment');
  assert.equal(getOriginalPaymentLabel({}), 'Original payment method');
  for (const paymentRail of ['raast', 'unknown']) {
    const source = { paymentRail, currency: 'PKR' };
    assert.match(getOriginalPaymentRefundCopy(source, 'manual_review'), /support review.*no bank refund has been confirmed/);
    assert.doesNotMatch(getOriginalPaymentRefundCopy(source, 'refund_pending'), /original card|being verified|bank may/);
    assert.match(getOriginalPaymentRefundCopy(source, 'refunded'), /has been confirmed/);
  }
  assert.match(getOriginalPaymentRefundCopy({ paymentRail: 'card' }, 'refunded'), /original card/);
  assert.match(getOriginalPaymentRefundCopy({ paymentRail: 'card' }, 'manual_review'), /no refund has been confirmed/);
});

test('web and native share the same payment-rail presentation source', () => {
  assert.equal(readFileSync(new URL('../src/utils/paymentPresentation.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../MobileApp/src/utils/paymentPresentation.js', import.meta.url), 'utf8'));
});
