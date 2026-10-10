import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canResumeSafepayPayment, resumeOwnedSafepayPayment } from '../src/utils/safepayResume.js';

const fixture = extra => ({ paymentMethod: 'safepay', paymentFlow: 'safepay_hosted',
  paymentId: '6abeccb088e4dda2b5e3b968', environment: 'sandbox', purpose: 'wallet_top_up',
  currency: 'PKR', amountMinor: 200000, status: 'pending', isPaid: false,
  checkoutUrl: 'https://sandbox.api.getsafepay.com/embedded/?environment=sandbox&tracker=track_fixture', ...extra });

test('resume uses the original attempt and only an authenticated verification can mark it paid', async () => {
  const calls = [];
  const result = await resumeOwnedSafepayPayment(fixture(), {
    reopen: async id => { calls.push(['reopen', id]); return fixture(); },
    present: async payment => { calls.push(['present', payment.paymentId]); return { status: 'paid', isPaid: true }; },
    verify: async expected => { calls.push(['verify', expected.paymentId]); return fixture(); },
  });
  assert.equal(result.status, 'pending'); assert.equal(result.isPaid, false);
  assert.deepEqual(calls, ['reopen', 'present', 'verify'].map(kind => [kind, fixture().paymentId]));
});

test('provider-complete reopen skips the form and rechecks the same reference', async () => {
  let presented = false;
  const paid = fixture({ status: 'paid', isPaid: true, webhookProcessed: true, checkoutUrl: undefined });
  const result = await resumeOwnedSafepayPayment(fixture(), {
    reopen: async () => paid, present: async () => { presented = true; }, verify: async () => paid,
  });
  assert.equal(presented, false); assert.equal(result.status, 'paid');
});

test('card verification resumes without pretending a zero-value authorization is a purchase', async () => {
  const pending = fixture({ purpose: 'card_setup', amountMinor: 0 });
  const authorized = { ...pending, status: 'authorized', cardSaved: true, completed: true };
  const result = await resumeOwnedSafepayPayment(pending, { reopen: async () => pending,
    present: async () => authorized, verify: async () => authorized });
  assert.equal(result.status, 'authorized'); assert.equal(result.isPaid, false);
});

test('changed identity or unsafe gateway URL stops before opening any form', async () => {
  for (const change of [{ paymentId: '6ab6e12cba71edafe4fc6c5b' }, { purpose: 'order' },
    { currency: 'USD' }, { amountMinor: 200001 }, { environment: 'production', checkoutUrl: 'https://getsafepay.com/embedded/?environment=production' },
    { checkoutUrl: 'https://sandbox.api.getsafepay.com.evil.test/embedded/?environment=sandbox' }]) {
    let presented = false;
    await assert.rejects(resumeOwnedSafepayPayment(fixture(), {
      reopen: async () => fixture(change), present: async () => { presented = true; }, verify: async () => fixture(),
    }), { code: 'SAFEPAY_CHECKOUT_INVALID' });
    assert.equal(presented, false);
  }
});

test('final verification cannot replace the original payment or claim success without proof', async () => {
  for (const change of [{ paymentId: '6ab6e12cba71edafe4fc6c5b' }, { amountMinor: 200001 }, { currency: 'USD' }]) {
    await assert.rejects(resumeOwnedSafepayPayment(fixture(), { reopen: async () => fixture(),
      present: async () => {}, verify: async () => fixture(change) }), { code: 'SAFEPAY_CHECKOUT_INVALID' });
  }
});

test('terminal, missing and unsupported attempts do not offer resume or call the provider', async () => {
  for (const payment of [null, fixture({ paymentId: 'invalid' }), fixture({ purpose: 'subscription' }),
    ...['cancelled', 'failed', 'refunded', 'refund_pending', 'manual_review'].map(status => fixture({ status })),
    fixture({ status: 'paid', isPaid: true, webhookProcessed: true })]) {
    assert.equal(canResumeSafepayPayment(payment), false);
    let called = false;
    await assert.rejects(resumeOwnedSafepayPayment(payment, { reopen: async () => { called = true; } }));
    assert.equal(called, false);
  }
});

test('return UI uses owner-scoped web reopen and pauses its polling while the secure presenter is active', () => {
  const source = readFileSync(new URL('../src/pages/SafepayReturnPage.jsx', import.meta.url), 'utf8');
  assert.match(source, /safepayApi\.post\(`\/payments\/\$\{id\}\/reopen`, \{ clientSurface: 'web' \}\)/);
  assert.match(source, /if \(embedded \|\| resuming \|\| !currentUser/);
  assert.match(source, /Resume secure payment/);
  assert.doesNotMatch(source, /\/create|ensurePayment|tracker=/);
});
