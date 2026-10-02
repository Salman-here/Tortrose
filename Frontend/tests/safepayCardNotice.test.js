import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { safepayCardSetupNotice } from '../src/utils/safepayCardNotice.js';

test('authorization with no reusable card explains the provider opt-in', () => {
  for (const rows of [[], [{ usable: false }], [{}], [null]]) {
    const message = safepayCardSetupNotice('authorized', rows);
    assert.match(message, /no reusable card was saved/);
    assert.match(message, /select.*Securely save this card/);
  }
});
test('the success notice relies on refreshed usable cards, not authorization alone', () => {
  assert.match(safepayCardSetupNotice('authorized', [{ usable: true }]), /reusable cards are listed/);
  assert.doesNotMatch(safepayCardSetupNotice('authorized', [{ usable: true }]), /new card|Card saved securely/);
  assert.match(safepayCardSetupNotice('authorized', null), /could not be refreshed/);
  for (const state of ['pending', 'paid', 'failed', 'cancelled']) assert.match(safepayCardSetupNotice(state, [{ usable: true }]), /not complete/);
});
test('web form refreshes before its outcome notice and clears completed consent', () => {
  const source = readFileSync(new URL('../src/components/layout/PaymentMethods.jsx', import.meta.url), 'utf8');
  assert.match(source, /const refreshedCards = await load\(\);\s+setNotice\(safepayCardSetupNotice\(result.status, refreshedCards\)\)/);
  assert.match(source, /result.status === 'authorized'\) setConsent\(false\)/);
  const provider = readFileSync(new URL('../src/components/common/SafepayCheckoutProvider.jsx', import.meta.url), 'utf8');
  assert.match(provider, /payment.purpose === 'card_setup'.*Securely save this card/);
});
