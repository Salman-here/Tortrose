import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkoutDraftStorageKey, createCheckoutCartIdentity, markGuestCheckoutHandoff, readCheckoutDraft, reconcileCheckoutProgress, GUEST_CHECKOUT_HANDOFF_MAX_AGE_MS } from '../src/utils/checkoutDraft.js';

const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
const draft = name => ({ currentStep: 1, formValues: { fullName: name, address: `${name} test address` }, appliedCoupons: {} });
const cart = () => [{ _id: 'cart-line-a', qty: 1, selectedColor: 'green', selectedOptions: { size: 'large', material: 'steel' },
  product: { _id: 'product-a', seller: 'seller-a', price: 100, discountedPrice: 0, currency: 'PKR' } }];
const reviewDraft = (items = cart(), currency = 'PKR') => ({ ...draft('Buyer A'), currentStep: 2,
  cartIdentity: createCheckoutCartIdentity(items, currency), selectedShippingPerSeller: { 'seller-a': { type: 'free' } } });

test('same-cart payment progress resumes after leaving checkout and reopening', () => {
  const s = storage(); const saved = reviewDraft();
  s.setItem(checkoutDraftStorageKey('buyer-a'), JSON.stringify(saved));
  const restored = readCheckoutDraft(s, 'buyer-a');
  const currentIdentity = createCheckoutCartIdentity(cart(), 'PKR');
  assert.equal(reconcileCheckoutProgress(restored, currentIdentity), restored);
  assert.equal(restored.currentStep, 2);
});

test('cart changes require review without dropping delivery details or pending payment records', () => {
  for (const mutate of [
    items => items.push({ qty: 1, product: { _id: 'product-b', seller: 'seller-b', price: 200, currency: 'PKR' } }),
    items => { items[0].product._id = 'product-b'; },
    items => { items[0].qty = 2; },
    items => { items[0].selectedColor = 'blue'; },
    items => { items[0].selectedOptions.size = 'small'; },
    items => { items[0].product.price = 150; },
    items => { items[0].product.discountedPrice = 80; },
    items => { items[0].product.currency = 'USD'; },
    items => { items[0].product.seller = 'seller-b'; },
    items => items.pop(),
  ]) {
    const s = storage(); const saved = reviewDraft(); const changed = cart(); mutate(changed);
    const paymentKey = 'rozare_checkout_attempt_v1:buyer-a:attempt-v2:pending';
    s.setItem(paymentKey, 'pending original payment');
    s.setItem(checkoutDraftStorageKey('buyer-a'), JSON.stringify(saved));
    const restored = readCheckoutDraft(s, 'buyer-a');
    const progress = reconcileCheckoutProgress(restored, createCheckoutCartIdentity(changed, 'PKR'));
    assert.equal(progress.currentStep, 0);
    assert.equal(restored.formValues.address, saved.formValues.address);
    assert.deepEqual(restored.selectedShippingPerSeller, saved.selectedShippingPerSeller);
    assert.equal(s.getItem(paymentKey), 'pending original payment');
    // Persist the reviewed identity, then reopen before advancing again.
    s.setItem(checkoutDraftStorageKey('buyer-a'), JSON.stringify({ ...restored, ...progress }));
    assert.equal(readCheckoutDraft(s, 'buyer-a').currentStep, 0);
  }
  const saved = reviewDraft();
  assert.equal(reconcileCheckoutProgress(saved, createCheckoutCartIdentity(cart(), 'USD')).currentStep, 0);
});

test('cart identity ignores object replacement, line ordering and option property ordering', () => {
  const first = cart(); first.push({ qty: 2, product: { _id: 'product-b', seller: { _id: 'seller-b' }, price: 200, currency: 'PKR' } });
  const second = structuredClone(first).reverse();
  second[1].selectedOptions = { material: 'steel', size: 'large' };
  second[1]._id = 'new-line-id-after-guest-merge';
  assert.equal(createCheckoutCartIdentity(first, 'PKR'), createCheckoutCartIdentity(second, 'PKR'));
});

test('hydration cannot baseline restored payment progress against an interim cart', () => {
  const saved = reviewDraft();
  assert.equal(reconcileCheckoutProgress(saved, null), saved);
  assert.equal(reconcileCheckoutProgress(saved, null).currentStep, 2);
  const changed = cart(); changed[0].qty = 2;
  const reconciled = reconcileCheckoutProgress(saved, createCheckoutCartIdentity(changed, 'PKR'));
  assert.equal(reconciled.currentStep, 0);
  assert.equal(reconcileCheckoutProgress(reconciled, reconciled.cartIdentity), reconciled);
  assert.equal(saved.cartIdentity, createCheckoutCartIdentity(cart(), 'PKR'));
});

test('legacy drafts without a cart identity keep the address but restart at cart review', () => {
  const s = storage(); s.setItem(checkoutDraftStorageKey('buyer-a'), JSON.stringify({ ...draft('Legacy'), currentStep: 2 }));
  const restored = readCheckoutDraft(s, 'buyer-a');
  assert.equal(restored.currentStep, 0);
  assert.equal(restored.formValues.address, 'Legacy test address');
});

test('explicit guest handoff preserves same-cart review identity and delivery details', () => {
  const s = storage(); const saved = reviewDraft();
  s.setItem(checkoutDraftStorageKey('guest'), JSON.stringify(saved));
  markGuestCheckoutHandoff(s, 'guest', 1000);
  const restored = readCheckoutDraft(s, 'buyer-a', 2000);
  assert.equal(reconcileCheckoutProgress(restored, createCheckoutCartIdentity(cart(), 'PKR')).currentStep, 2);
  assert.equal(restored.formValues.address, saved.formValues.address);
  assert.equal(readCheckoutDraft(s, 'buyer-b', 2000), null);
});
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
  assert.match(source, /const checkoutCartIdentity = isCartReady \? createCheckoutCartIdentity/);
  assert.match(source, /const \{ currentStep \} = reconcileCheckoutProgress\(checkoutProgress, checkoutCartIdentity\)/);
  assert.match(source, /useEffect\(\(\) => \{\s*if \(!isCartReady\) return;/);
  assert.equal((source.match(/cartIdentity: checkoutCartIdentity/g) || []).length, 3);
});
