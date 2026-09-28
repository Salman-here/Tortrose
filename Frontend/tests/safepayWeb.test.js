import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSafepayCheckout, validateSafepayPayment } from '../src/utils/safepayContract.js';
import { isKnownAppPath, isPrivatePath } from '../middleware.js';
const payment = extra => ({ paymentMethod: 'safepay', paymentFlow: 'safepay_hosted', paymentId: '6ab6e12cba71edafe4fc6c5b',
  environment: 'sandbox', currency: 'PKR', purpose: 'order', amountMinor: 120000, status: 'pending', isPaid: false,
  checkoutUrl: 'https://sandbox.api.getsafepay.com/embedded/?environment=sandbox&tracker=track_fixture&token=fixture', ...extra });
test('web checkout accepts an exact Safepay sandbox host and safe integer money', () => {
  assert.equal(validateSafepayCheckout(payment()).status, 'pending');
  assert.equal(validateSafepayCheckout({ data: payment() }).amountMinor, 120000);
});
test('web checkout rejects lookalike, credential, non-https and cross-environment URLs', () => {
  for (const checkoutUrl of ['https://sandbox.api.getsafepay.com.evil.test/embedded/?environment=sandbox',
    'https://user:secret@sandbox.api.getsafepay.com/embedded/?environment=sandbox',
    'http://sandbox.api.getsafepay.com/embedded/?environment=sandbox',
    'https://sandbox.api.getsafepay.com:8443/embedded/?environment=sandbox',
    'https://getsafepay.com/embedded/?environment=sandbox',
    'https://sandbox.api.getsafepay.com/embedded/?environment=production',
    'https://sandbox.api.getsafepay.com/checkout/auth/login?environment=sandbox']) {
    assert.throws(() => validateSafepayCheckout(payment({ checkoutUrl })), { code: 'SAFEPAY_CHECKOUT_INVALID', retainMutationAttempt: true });
  }
});
test('unverified success never becomes a paid result; card setup is not a purchase', () => {
  assert.equal(validateSafepayPayment(payment({ status: 'paid', isPaid: true })).status, 'pending');
  assert.equal(validateSafepayPayment(payment({ status: 'paid', isPaid: true, webhookProcessed: true })).status, 'paid');
  const card = payment({ purpose: 'card_setup', amountMinor: 0, status: 'authorized', completed: true, cardSaved: true });
  assert.equal(validateSafepayPayment(card).status, 'authorized');
  assert.equal(validateSafepayPayment(card).isPaid, false);
  assert.equal(validateSafepayPayment({ ...card, cardSaved: false }).status, 'pending');
});
test('payment verification binds the exact reference, purpose, environment, amount and currency', () => {
  const original = payment();
  for (const extra of [{ paymentId: '6ab6e29eba71edafe4fc7596' }, { environment: 'production' }, { purpose: 'wallet_top_up' }, { amountMinor: 120001 }, { currency: 'USD' }]) {
    assert.throws(() => validateSafepayPayment(payment(extra), original), { code: 'SAFEPAY_CHECKOUT_INVALID' });
  }
  for (const extra of [{ amountMinor: -1 }, { amountMinor: 1.5 }, { amountMinor: '120000' }, { amountMinor: 0 }, { currency: 'ZZZ' }, { purpose: 'unknown' }, { paymentId: 'bad-id' }]) {
    assert.throws(() => validateSafepayPayment(payment(extra)), { code: 'SAFEPAY_CHECKOUT_INVALID' });
  }
});
test('refund, failure and review states never enable a paid purchase', () => {
  for (const status of ['cancelled', 'failed', 'refunded', 'refund_pending', 'manual_review']) {
    const result = validateSafepayPayment(payment({ status, isPaid: true, webhookProcessed: true }));
    assert.equal(result.status, status); assert.equal(result.isPaid, false);
  }
});
test('policy pages are public and payment return is private/noindex', () => {
  for (const path of ['/terms', '/privacy', '/shipping-policy', '/refund-policy', '/cancellation-policy']) {
    assert.equal(isKnownAppPath(path), true); assert.equal(isPrivatePath(path), false);
  }
  assert.equal(isKnownAppPath('/safepay/return'), true); assert.equal(isPrivatePath('/safepay/return'), true);
});
test('deployment frame and payment policies explicitly permit both Safepay environments', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url)));
  const headers = config.headers.find(entry => entry.source === '/(.*)').headers;
  const csp = headers.find(header => header.key === 'Content-Security-Policy').value;
  const frames = csp.match(/frame-src ([^;]+)/)[1];
  assert.match(frames, /https:\/\/sandbox\.api\.getsafepay\.com/);
  assert.match(frames, /https:\/\/getsafepay\.com/);
  assert.doesNotMatch(csp, /stripe\.com/);
  assert.match(config.buildCommand, /check:policy-publication/);
});
test('new website flows use Safepay with explicit web origin and durable attempts', () => {
  for (const file of ['Checkout.jsx', 'Wallet.jsx', 'SellerSubdomainManagement.jsx', 'ReturnOrdersPanel.jsx', 'PaymentMethods.jsx']) {
    const source = readFileSync(new URL(`../src/components/layout/${file}`, import.meta.url), 'utf8');
    assert.match(source, /openSafepayCheckout/); assert.match(source, /['"]web['"]/);
    assert.match(source, /PersistedMutationAttempt/);
  }
  const subscription = readFileSync(new URL('../src/components/layout/SellerSubscription.jsx', import.meta.url), 'utf8');
  assert.match(subscription, /useSafepaySubscriptionBilling/);
  assert.doesNotMatch(subscription, /loadStripe|subscription\/create-checkout/);
  const deps = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).dependencies;
  assert.equal(deps['@stripe/stripe-js'], undefined); assert.equal(deps['@stripe/react-stripe-js'], undefined);
});
