import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (relativePath) => readFileSync(
  new URL(relativePath, import.meta.url),
  'utf8',
);

test('web cart hydration spans guest merge and a separate authoritative fetch', () => {
  const source = readSource('../src/contexts/GlobalContext.jsx');
  const mergeIndex = source.indexOf('api/cart/merge');
  const clearIndex = source.indexOf('clearGuestCart()', mergeIndex);
  const fetchIndex = source.indexOf('await fetchAuthoritativeCart(owner, false)', clearIndex);
  const readyIndex = source.indexOf("setCartHydrationStatus('ready')", fetchIndex);

  assert.ok(mergeIndex > -1);
  assert.ok(clearIndex > mergeIndex);
  assert.ok(fetchIndex > clearIndex);
  assert.ok(readyIndex > fetchIndex);
  assert.match(source, /hydratedCartOwner === cartOwner/);
  assert.match(source, /cartHydrationStatusRef\.current !== 'ready'/);
  assert.match(source, /cartHydrationOwnerRef\.current === owner[\s\S]*?return cartHydrationPromiseRef\.current/);
  assert.match(source, /return retryCartHydration\(\)/);
});

test('web cart and checkout surfaces block until the owner-correlated cart is ready', () => {
  const dropdown = readSource('../src/components/common/CartDropdown.jsx');
  const checkout = readSource('../src/components/layout/Checkout.jsx');

  assert.match(dropdown, /if \(!isCartReady\)/);
  assert.match(dropdown, /disabled=\{isCartLoading \|\| !isCartReady \|\| cartRatesUnavailable\}/);
  assert.match(checkout, /const checkoutBlocked = !isCartReady \|\| taxUnavailable \|\| !shippingReady \|\| checkoutRatesUnavailable/);
  assert.ok((checkout.match(/if \(!isCartReady\)/g) || []).length >= 2);
  assert.match(checkout, /retryCartHydration/);
});
