import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Execute the component's actual mutation handler with its service boundary
// mocked. This exercises persisted attempt behavior without a browser gateway.
const source = readFileSync(new URL('../src/components/layout/ReturnOrdersPanel.jsx', import.meta.url), 'utf8');
const start = source.indexOf('const acceptReturn = async');
const end = source.indexOf('\n  return (', start);
assert.ok(start >= 0 && end > start);
const handler = source.slice(start, end) + '\nacceptReturn;';

function fixture(status = 'pending', errorData) {
  const calls = { cleared: [], formats: [], errors: [], success: [], info: [], keys: [], refreshed: 0 };
  let retainedKey = 'first-attempt';
  let next = 1;
  const context = {
    inspectReturnPresentationSnapshot: () => ({ valid: true }),
    currentUser: { _id: 'seller-1' }, API: '/api/returns', localStorage: {},
    setSubmitting() {}, setDialog() {}, authHeaders: () => ({}),
    createScopedMutationStorageKey: (_, owner) => owner,
    getOrCreatePersistedMutationAttemptInLedger: async () => ({ key: retainedKey ??= `fresh-${next++}` }),
    clearPersistedMutationAttemptFromLedger: async (_, owner, fingerprint, key) => {
      calls.cleared.push({ owner, fingerprint, key }); retainedKey = null;
    },
    axios: { post: async (_, body) => {
      calls.keys.push(body.requestKey);
      if (errorData) throw { response: { data: errorData } };
      return { data: { requiresPayment: true } };
    } },
    openSafepayCheckout: async () => ({ status }),
    isExactNonNegativeJsonMoney: value => typeof value === 'number' && Number.isFinite(value) && value >= 0,
    formatPrice: (value, options) => { calls.formats.push({ value, ...options }); return `${options.targetCurrency} ${value}`; },
    toast: { error: value => calls.errors.push(value), success: value => calls.success.push(value), info: value => calls.info.push(value) },
    load: async () => { calls.refreshed++; },
  };
  const accept = vm.runInNewContext(handler, context);
  return { calls, accept: fundingSource => accept({ _id: 'return-1', status: 'under_review', policySnapshot: { refundType: 'full_refund' } }, fundingSource) };
}

for (const status of ['cancelled', 'failed', 'refunded']) {
  test(`confirmed ${status} return payment releases its key so the next attempt is fresh`, async () => {
    const f = fixture(status);
    await f.accept('card'); await f.accept('card');
    assert.deepEqual(f.calls.keys, ['first-attempt', 'fresh-1']);
    assert.equal(f.calls.cleared.length, 2);
    assert.equal(f.calls.cleared[0].owner, 'seller-1');
    assert.equal(f.calls.cleared[0].fingerprint, 'return:return-1');
    assert.equal(f.calls.success.length, 0);
  });
}
for (const status of ['pending', 'manual_review', 'refund_pending']) {
  test(`${status} funding preserves the same key and grants no success`, async () => {
    const f = fixture(status);
    await f.accept('card'); await f.accept('card');
    assert.deepEqual(f.calls.keys, ['first-attempt', 'first-attempt']);
    assert.equal(f.calls.cleared.length, 0);
    assert.equal(f.calls.success.length, 0);
  });
}
for (const currency of ['PKR', 'USD', 'EUR', 'GBP']) {
  test(`insufficient balance formats frozen ${currency} without a browsing conversion`, async () => {
    const f = fixture('pending', { msg: 'Insufficient funds', availableBalance: 1999.90, availableBalanceCurrency: currency });
    await f.accept('seller_balance');
    assert.deepEqual(f.calls.formats, [{ value: 1999.90, sourceCurrency: currency, targetCurrency: currency, showCode: true }]);
    assert.match(f.calls.errors[0], /Available balance/);
  });
}
test('legacy USD balance error remains readable', async () => {
  const f = fixture('pending', { msg: 'Insufficient funds', availableBalanceUSD: 96.75 });
  await f.accept('seller_balance');
  assert.deepEqual(f.calls.formats, [{ value: 96.75, sourceCurrency: 'USD', targetCurrency: 'USD', showCode: true }]);
});
