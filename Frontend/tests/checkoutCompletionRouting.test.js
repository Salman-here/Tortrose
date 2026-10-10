import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { checkoutDraftStorageKey } from '../src/utils/checkoutDraft.js';
import { validateSafepayPayment } from '../src/utils/safepayContract.js';

const checkout = readFileSync(new URL('../src/components/layout/Checkout.jsx', import.meta.url), 'utf8');
const returned = readFileSync(new URL('../src/pages/SafepayReturnPage.jsx', import.meta.url), 'utf8');
const declaration = checkout.match(/^  const finishConfirmedOrder = async[\s\S]+?^  };/m)?.[0];
const correlation = { orderReference: 'ORD-TEST-100', attemptFingerprint: 'buyer:original-cart', attemptKey: 'original-generation' };

function harness({ clearResult = true, denied = false, draftIdentity = 'original-cart', draftFingerprint = 'original-generation', refresh } = {}) {
  const events = [];
  const owner = 'buyer-1', draftKey = checkoutDraftStorageKey(owner);
  const values = new Map([[draftKey, JSON.stringify({ currentStep: 2, cartIdentity: draftIdentity, draftFingerprint, formValues: { address: 'Saved address' } })]]);
  const sessionStorage = { getItem(key) { if (denied) throw new Error('Storage unavailable'); return values.get(key) || null; },
    removeItem(key) { if (denied) throw new Error('Storage unavailable'); events.push(['draft', key]); values.delete(key); } };
  const localStorage = {};
  const finish = vm.runInNewContext(`${declaration}\nfinishConfirmedOrder;`, {
    owner, CHECKOUT_STORAGE_KEY: draftKey, checkoutAttemptStorageKey: 'buyer-1:attempt-ledger', localStorage, sessionStorage,
    clearPersistedMutationAttemptFromLedger: async (...args) => { events.push(['attempt', ...args]); if (denied) throw new Error('Storage unavailable'); return clearResult; },
    fetchCart: async () => { events.push(['refresh']); await refresh?.(values, draftKey); },
    navigate: (path, options) => events.push(['navigate', path, JSON.parse(JSON.stringify(options))]),
    console: { error() {} },
  });
  return { finish, events, values, draftKey, localStorage };
}

test('completed checkout opens the same durable receipt with exact original generation cleanup and safe history', async () => {
  const h = harness(); await h.finish(correlation);
  assert.deepEqual(h.events[0], ['attempt', h.localStorage, 'buyer-1:attempt-ledger', correlation.attemptFingerprint, correlation.attemptKey]);
  assert.equal(h.values.has(h.draftKey), true);
  assert.equal(h.events.some(row => row[0] === 'draft'), false);
  assert.deepEqual(h.events.at(-1), ['navigate', '/success?orderId=ORD-TEST-100', { replace: true }]);
});

test('missing/denied confirmation storage cannot prevent reading the completed server-owned receipt', async () => {
  const h = harness({ denied: true }); await h.finish(correlation);
  assert.deepEqual(h.events.at(-1), ['navigate', '/success?orderId=ORD-TEST-100', { replace: true }]);
  assert.equal(h.events.filter(row => row[0] === 'refresh').length, 1);
});

test('an older completed callback preserves different-cart AND identical-cart new drafts regardless of its retired generation', async () => {
  for (const options of [{ draftIdentity: 'new-cart' }, { draftIdentity: 'original-cart', draftFingerprint: 'new-identical-cart-before-payment' }, { clearResult: false }]) {
    const h = harness(options); const original = h.values.get(h.draftKey); await h.finish(correlation);
    assert.equal(h.values.get(h.draftKey), original);
  }
  const h = harness({ refresh: (values, key) => values.set(key, 'new-draft-after-cart-refresh') });
  await h.finish(correlation);
  assert.equal(h.values.get(h.draftKey), 'new-draft-after-cart-refresh');
});

test('uncorrelated completion cannot clear another attempt and a missing reference uses the owned orders fallback', async () => {
  const h = harness(); await h.finish({ orderReference: 'a'.repeat(24) });
  assert.equal(h.events.some(row => row[0] === 'attempt'), false);
  assert.equal(h.values.has(h.draftKey), true);
  assert.equal(h.events.at(-1)[1], `/success?orderId=${'a'.repeat(24)}`);
  const missing = harness(); await missing.finish({ ...correlation, orderReference: undefined });
  assert.equal(missing.events.at(-1)[1], '/user-dashboard/orders');
});

test('COD, Wallet, verified Safepay and both shipping prompt decisions share completion without payment query claims', () => {
  assert.equal((checkout.match(/await finishConfirmedOrder\(/g) || []).length, 4);
  assert.match(checkout, /if \(\['cash_on_delivery', 'wallet'\]\.includes\(order.paymentMethod\)\)/);
  assert.match(checkout, /if \(result.status === 'paid'\)[\s\S]*?await finishConfirmedOrder/);
  assert.match(checkout, /const onPlaceOrder = async \(data\) => \{\s*if \(isProcessing\) return;/);
  assert.match(checkout, /noPaymentRequired === true && res.data\?\.isPaid === true/);
  assert.match(checkout, /attemptFingerprint: fingerprint, attemptKey/);
  assert.equal((checkout.match(/attemptKey: pendingOrderData.attemptKey/g) || []).length, 2);
  assert.doesNotMatch(declaration, /sessionStorage|readCheckoutDraft|removeItem|CHECKOUT_STORAGE_KEY/);
  assert.doesNotMatch(checkout, /\/success\?payment=|rememberConfirmedOrder|sessionStorage.setItem\(ORDER_SUCCESS_STORAGE_KEY/);
});

function returnDestination(payment, { paymentId = 'a'.repeat(24), error = '' } = {}) {
  const routing = returned.match(/  const confirmedOrder = [\s\S]+?\n  if \(embedded\)/)[0].replace(/\n  if \(embedded\)$/, '');
  return vm.runInNewContext(`${routing}\n({ confirmedOrder, destination });`, { payment, paymentId, error });
}
const payment = extra => ({ paymentMethod: 'safepay', paymentFlow: 'safepay_hosted', paymentId: 'a'.repeat(24), environment: 'sandbox',
  currency: 'PKR', purpose: 'order', amountMinor: 10000, status: 'paid', isPaid: true, webhookProcessed: true, mongoOrderId: 'b'.repeat(24), ...extra });

test('standalone return offers the receipt only after verified paid order evidence, preserving non-order destinations', () => {
  assert.equal(returnDestination(validateSafepayPayment(payment())).destination, `/success?orderId=${'b'.repeat(24)}`);
  assert.equal(returnDestination(validateSafepayPayment(payment({ webhookProcessed: false }))).destination, '/user-dashboard/orders');
  assert.equal(returnDestination(validateSafepayPayment(payment({ mongoOrderId: '' }))).destination, '/user-dashboard/orders');
  assert.equal(returnDestination(validateSafepayPayment(payment()), { paymentId: 'c'.repeat(24) }).destination, '/user-dashboard/orders');
  assert.equal(returnDestination(validateSafepayPayment(payment()), { error: 'Verification is unavailable.' }).destination, '/user-dashboard/orders');
  for (const [purpose, path] of [['wallet_top_up', '/user-dashboard/wallet'], ['card_setup', '/user-dashboard/payment-methods'], ['subdomain', '/seller-dashboard/subdomain']]) {
    const source = purpose === 'card_setup' ? payment({ purpose, amountMinor: 0, status: 'authorized', cardSaved: true, completed: true }) : payment({ purpose });
    assert.equal(returnDestination(validateSafepayPayment(source)).destination, path);
  }
  assert.doesNotMatch(returned, /params\.get\('orderId'\)/);
});
