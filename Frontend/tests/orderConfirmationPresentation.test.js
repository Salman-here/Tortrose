import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldShowGenericConfirmedBanner,
  getAutomaticPaymentConfirmationLabel,
  getBuyerConfirmationMessage,
  getCancellationPaymentMessage,
  getConfirmationViaLabel,
} from '../src/utils/orderConfirmationPresentation.js';

test('shows the generic success banner only for a currently confirmed order without a more specific banner', () => {
  assert.equal(shouldShowGenericConfirmedBanner({
    actionDone: 'confirmed',
    orderStatus: 'confirmed',
  }), true);

  assert.equal(shouldShowGenericConfirmedBanner({
    actionDone: 'confirmed',
    orderStatus: 'confirmed',
    hasSpecificConfirmationState: true,
  }), false);
});

test('payment-based confirmation names the verified method without claiming a manual buyer decision', () => {
  for (const [source, method] of [
    ['safepay_payment', 'Safepay payment'],
    ['wallet_payment', 'Rozare Wallet payment'],
    ['stripe_payment', 'card payment'],
  ]) {
    assert.equal(getAutomaticPaymentConfirmationLabel(source), `Confirmed after verified ${method}`);
    const message = getBuyerConfirmationMessage({
      confirmation: { confirmedAt: '2026-10-02T06:42:57Z', confirmedVia: source },
    });
    assert.ok(message.includes(method));
    assert.ok(!message.includes(source));
    assert.ok(!message.includes('you confirmed'));
    assert.ok(!message.includes('has been notified'));
  }
});

test('a source code without a recorded confirmation cannot produce a success notice', () => {
  assert.equal(getBuyerConfirmationMessage({ confirmation: { confirmedVia: 'safepay_payment' } }), '');
  assert.equal(getBuyerConfirmationMessage(null), '');
});

test('known human channels are readable and unknown source values are not echoed', () => {
  assert.equal(getConfirmationViaLabel('whatsapp'), 'WhatsApp');
  assert.equal(getConfirmationViaLabel('email'), 'email');
  for (const source of ['unknown_internal_code', '__proto__', {}, null]) {
    assert.equal(getConfirmationViaLabel(source), 'Rozare');
    assert.equal(getAutomaticPaymentConfirmationLabel(source), '');
  }
});

test('cancellation copy does not promise that no charge happened or that a refund was completed', () => {
  const message = getCancellationPaymentMessage();
  assert.match(message, /payment and refund details/);
  assert.doesNotMatch(message, /nothing has been charged|refund.*completed|refunded successfully/i);
});

test('dashboard cancellation source remains explicit even when no free-text note was saved', () => {
  assert.equal(getConfirmationViaLabel('dashboard'), 'your Rozare account');
});

test('never shows confirmed success after an administrator, seller, or system cancellation', () => {
  for (const hasCancellationState of [false, true]) {
    assert.equal(shouldShowGenericConfirmedBanner({
      actionDone: 'confirmed',
      orderStatus: 'cancelled',
      hasCancellationState,
    }), false);
  }
});
