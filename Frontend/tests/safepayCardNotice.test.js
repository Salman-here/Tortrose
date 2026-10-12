import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { safepayCardSetupNotice } from '../src/utils/safepayCardNotice.js';

const result = { status: 'authorized', savedPaymentMethodId: 'pm_new-card' };
const card = { id: 'pm_new-card', usable: true };
test('success and default notices rely on the exact saved card and refreshed default', () => {
  assert.match(safepayCardSetupNotice(result, { cards: [card], defaultPaymentMethodId: card.id }), /saved and set as your default/);
  assert.match(safepayCardSetupNotice(result, { cards: [card], defaultPaymentMethodId: 'pm_other-card' }), /current default card is unchanged/);
  for (const cards of [[], [{ ...card, usable: false }], [{ id: 'pm_other-card', usable: true }], [null]]) {
    assert.match(safepayCardSetupNotice(result, { cards }), /not available yet/);
  }
  assert.match(safepayCardSetupNotice(result, null), /could not be refreshed/);
});
test('pending/closed setup and older setup responses do not claim a new default', () => {
  for (const status of ['pending', 'paid', 'failed', 'cancelled']) {
    assert.match(safepayCardSetupNotice({ ...result, status }, { cards: [card] }), /not complete/);
  }
  const legacy = safepayCardSetupNotice({ status: 'authorized' }, { cards: [card], defaultPaymentMethodId: card.id });
  assert.match(legacy, /saved cards are listed/);
  assert.doesNotMatch(legacy, /set as your default|new card/);
});
test('web form uses short consent and refreshes before showing the saved-card result', () => {
  const source = readFileSync(new URL('../src/components/layout/PaymentMethods.jsx', import.meta.url), 'utf8');
  assert.match(source, /Save this card for future payments\./);
  assert.match(source, /const refreshed = await load\(\);\s+setNotice\(safepayCardSetupNotice\(result, refreshed\)\)/);
  assert.match(source, /result.status === 'authorized'\) setConsent\(false\)/);
  const provider = readFileSync(new URL('../src/components/common/SafepayCheckoutProvider.jsx', import.meta.url), 'utf8');
  assert.match(provider, /payment.purpose === 'card_setup'.*Complete Safepay/);
  assert.doesNotMatch(source + provider, /I authorize Safepay|select.*Securely save this card/i);
});
