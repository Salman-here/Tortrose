import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkoutDraftStorageKey, markGuestCheckoutHandoff, readCheckoutDraft, GUEST_CHECKOUT_HANDOFF_MAX_AGE_MS } from '../src/utils/checkoutDraft.js';

const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
const draft = name => ({ currentStep: 1, formValues: { fullName: name, address: `${name} test address` }, appliedCoupons: {} });
test('authenticated checkout drafts are isolated per account and reload correctly', () => {
  const s = storage();
  s.setItem(checkoutDraftStorageKey('buyer-a'), JSON.stringify(draft('Buyer A')));
  assert.equal(readCheckoutDraft(s, 'buyer-b'), null);
  assert.equal(readCheckoutDraft(s, 'guest'), null);
  assert.equal(readCheckoutDraft(s, 'buyer-a').formValues.fullName, 'Buyer A');
  s.setItem(checkoutDraftStorageKey('buyer-b'), JSON.stringify(draft('Buyer B')));
  assert.equal(readCheckoutDraft(s, 'buyer-a').formValues.fullName, 'Buyer A');
});
test('unowned v1 checkout data is never imported into an account or guest checkout', () => {
  const s = storage(); s.setItem('checkoutProgress_v1', JSON.stringify(draft('Previous account')));
  assert.equal(readCheckoutDraft(s, 'buyer-a'), null);
  assert.equal(readCheckoutDraft(s, 'guest'), null);
});
test('a guest draft does not transfer merely because an account signs in', () => {
  const s = storage(); s.setItem(checkoutDraftStorageKey('guest'), JSON.stringify(draft('Guest')));
  assert.equal(readCheckoutDraft(s, 'buyer-a'), null);
});
test('an explicit guest checkout handoff is consumed once by its next sign-in', () => {
  const s = storage(); s.setItem(checkoutDraftStorageKey('guest'), JSON.stringify(draft('Guest')));
  assert.equal(markGuestCheckoutHandoff(s, 'guest', 1000), true);
  assert.equal(readCheckoutDraft(s, 'buyer-a', 2000).formValues.fullName, 'Guest');
  assert.equal(readCheckoutDraft(s, 'buyer-b', 2000), null);
  assert.equal(readCheckoutDraft(s, 'guest', 2000), null);
  assert.equal(readCheckoutDraft(s, 'buyer-a', 3000).formValues.fullName, 'Guest');
});
test('an explicit current guest checkout supersedes that account’s previous checkout draft', () => {
  const s = storage(); s.setItem(checkoutDraftStorageKey('buyer-a'), JSON.stringify(draft('Old A')));
  s.setItem(checkoutDraftStorageKey('guest'), JSON.stringify(draft('Current guest')));
  markGuestCheckoutHandoff(s, 'guest', 1000);
  assert.equal(readCheckoutDraft(s, 'buyer-a', 2000).formValues.fullName, 'Current guest');
});
test('an authenticated or expired-auth checkout can never authorise a cross-account handoff', () => {
  const s = storage(); s.setItem(checkoutDraftStorageKey('buyer-a'), JSON.stringify(draft('Buyer A')));
  assert.equal(markGuestCheckoutHandoff(s, 'buyer-a', 1000), false);
  assert.equal(readCheckoutDraft(s, 'buyer-b', 2000), null);
});
test('expired or future-dated guest handoffs do not transfer delivery details', () => {
  for (const at of [999, 1001 + GUEST_CHECKOUT_HANDOFF_MAX_AGE_MS]) {
    const s = storage(); s.setItem(checkoutDraftStorageKey('guest'), JSON.stringify(draft('Guest')));
    markGuestCheckoutHandoff(s, 'guest', 1000);
    assert.equal(readCheckoutDraft(s, 'buyer-a', at), null);
  }
});
test('malformed drafts, out-of-range steps and denied storage fail safely', () => {
  const s = storage(); const key = checkoutDraftStorageKey('buyer-a');
  for (const bad of ['invalid', '[]', 'null', '42']) { s.setItem(key, bad); assert.equal(readCheckoutDraft(s, 'buyer-a'), null); }
  s.setItem(key, JSON.stringify({ currentStep: 999 })); assert.equal(readCheckoutDraft(s, 'buyer-a').currentStep, 0);
  const denied = { getItem() { throw new Error('denied'); } };
  assert.equal(readCheckoutDraft(denied, 'buyer-a'), null);
  assert.equal(markGuestCheckoutHandoff(denied, 'guest'), false);
});
test('checkout remounts in-memory form state by owner and uses only scoped draft reads', () => {
  const source = readFileSync(new URL('../src/components/layout/Checkout.jsx', import.meta.url), 'utf8');
  assert.match(source, /<OwnedCheckout key=\{owner\} owner=\{owner\}/);
  assert.match(source, /const CHECKOUT_STORAGE_KEY = checkoutDraftStorageKey\(owner\)/);
  assert.doesNotMatch(source, /getItem\(CHECKOUT_STORAGE_KEY\)/);
  assert.match(source, /markGuestCheckoutHandoff\(sessionStorage, owner\)/);
});
