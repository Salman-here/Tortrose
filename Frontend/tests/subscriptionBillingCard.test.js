import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectSubscriptionBillingCard as select } from '../src/utils/subscriptionBillingCard.js';
const data = { cards: [{ id: 'pm_shopping', last4: '1111', usable: true }, { id: 'pm_billing', last4: '1111', usable: true }],
  defaultPaymentMethodId: 'pm_shopping', billingPaymentMethodId: 'pm_billing' };
test('renewal retry selects the current billing reference, not shopping default or matching last four', () => {
  assert.equal(select(data, { preferBilling: true }), 'pm_billing');
  assert.equal(select({ ...data, billingPaymentMethodId: 'pm_shopping' }, { preferBilling: true }), 'pm_shopping');
});
test('missing, unavailable and expired billing references require explicit selection', () => {
  for (const id of [null, undefined, 'pm_foreign']) assert.equal(select({ ...data, billingPaymentMethodId: id }, { preferBilling: true }), '');
  assert.equal(select({ ...data, cards: data.cards.map(c => ({ ...c, usable: c.id !== 'pm_billing' })) }, { preferBilling: true }), '');
});
test('new enrollment preserves the normal owned shopping default and empty list stays empty', () => {
  assert.equal(select(data), 'pm_shopping');
  assert.equal(select({ cards: data.cards }), 'pm_shopping');
  assert.equal(select({ cards: [] }), '');
});
test('web and Android use the same card-selection contract', () => {
  assert.equal(readFileSync(new URL('../src/utils/subscriptionBillingCard.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../MobileApp/src/utils/subscriptionBillingCard.js', import.meta.url), 'utf8'));
});
test('the web review passes its actual operation kind and includes an explicit empty option', () => {
  const source = readFileSync(new URL('../src/components/subscription/SafepayBillingReview.jsx', import.meta.url), 'utf8');
  assert.match(source, /getCards\(kind\)/); assert.match(source, /getCards\('card_change'\)/);
  assert.match(source, /preferBilling: kind !== 'enrollment'/);
  assert.match(source, /<option value="" disabled>Choose a saved card<\/option>/);
});
test('an unpaid renewal retains its agreement and never advertises new enrollment as the recovery action', () => {
  const source = readFileSync(new URL('../src/components/layout/SellerSubscription.jsx', import.meta.url), 'utf8');
  assert.match(source, /Your existing billing agreement is retained/);
  assert.equal((source.match(/Resolve unpaid renewal above/g) || []).length, 2);
  assert.match(source, /disabled=\{isPastDue \|\| checkoutLoading === 'elite'\}/);
  assert.match(source, /disabled=\{isPastDue \|\| checkoutLoading === 'starter' \|\| hasPendingDowngrade\}/);
});
