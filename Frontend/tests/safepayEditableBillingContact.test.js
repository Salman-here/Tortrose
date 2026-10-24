import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/components/layout/PaymentMethods.jsx', import.meta.url), 'utf8');
test('existing and new wallets always have an editable billing form with current validation', () => {
  assert.match(source, /Billing details for your next card/);
  assert.match(source, /fieldset disabled=\{busy \|\| loading\}/);
  assert.doesNotMatch(source, /!profileReady\s*&&|!profileReady\s*\?/);
  assert.match(source, /requestKey: attempt.key, billingContact: contact/);
  assert.match(source, /const nameError = getSafepayCheckoutNameError/);
  assert.match(source, /if \(!isValidPhoneNumber/);
});
test('edited contact has its own retry identity and refreshing does not overwrite user input', () => {
  assert.match(source, /safepay-card-storage-contact-v2/);
  assert.match(source, /contact.fullName.trim\(\).replace/);
  assert.match(source, /contact.phone.trim\(\)/);
  assert.match(source, /contact.countryCode.trim\(\).toUpperCase\(\)/);
  assert.match(source, /data.billingContact && !editedContact.current/);
  assert.match(source, /activeOwner.current !== actorId/);
});
