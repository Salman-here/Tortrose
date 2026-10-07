import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { toCurrencyMinorUnits } from '../src/utils/currencySafety.js';
import { parseExactMoneyInput } from '../src/utils/sellerMoneySafety.js';

const source = readFileSync(new URL('../src/components/layout/SellerPayments.jsx', import.meta.url), 'utf8');
const start = source.indexOf('const requestWithdrawal =');
const end = source.indexOf('\n    if (loading', start);
assert.ok(start >= 0 && end > start);
const handler = source.slice(start, end) + '\nrequestWithdrawal;';

function fixture({ currency, available, minimum, amount, pending = 0 }) {
  const calls = { errors: [], posts: 0, mutations: 0, attemptKeys: 0 };
  const formatAmount = (value, { targetCurrency }) => `${targetCurrency} ${value.toFixed(2)}`;
  const context = { activeSummary: { onlinePendingRevenue: pending }, refreshingSummary: false,
    withdrawalIsBlocked: false, paymentAccount: { currency }, availableInCurrentCurrency: available,
    minimumWithdrawalInCurrentCurrency: minimum, withdrawalInput: parseExactMoneyInput(amount), balanceCurrency: currency,
    toCurrencyMinorUnits, formatAmount, formatBalanceMoney: value => formatAmount(value, { targetCurrency: currency }),
    toast: { error: message => calls.errors.push(message) }, setRequesting: () => { calls.mutations++; },
    axios: { post: () => { calls.posts++; } }, getOrCreatePersistedMutationAttemptInLedger: () => { calls.attemptKeys++; },
  };
  return { request: vm.runInNewContext(handler, context), calls };
}

test('web identifies available PKR 1999.90 below the minimum despite entering exactly PKR 2000', async () => {
  const f = fixture({ currency: 'PKR', available: 1999.90, minimum: 2000, amount: '2000.00', pending: 2784 });
  await f.request({ preventDefault() {} });
  assert.deepEqual(f.calls.errors, ['Balance below minimum. Your available balance is PKR 1999.90. The minimum withdrawal is PKR 2000.00. Pending and reserved funds are not withdrawable.']);
  assert.deepEqual([f.calls.posts, f.calls.mutations, f.calls.attemptKeys], [0, 0, 0]);
});

test('web retains the entered-amount minimum message for USD 4.99 with USD 96.75 available', async () => {
  const f = fixture({ currency: 'USD', available: 96.75, minimum: 5, amount: '4.99' });
  await f.request({ preventDefault() {} });
  assert.deepEqual(f.calls.errors, ['Minimum withdrawal amount is USD 5.00']);
  assert.deepEqual([f.calls.posts, f.calls.mutations, f.calls.attemptKeys], [0, 0, 0]);
});

test('web retains its maximum-available message when an otherwise eligible withdrawal overspends', async () => {
  const f = fixture({ currency: 'USD', available: 96.75, minimum: 5, amount: '96.76' });
  await f.request({ preventDefault() {} });
  assert.deepEqual(f.calls.errors, ['You can withdraw up to USD 96.75']);
  assert.deepEqual([f.calls.posts, f.calls.mutations, f.calls.attemptKeys], [0, 0, 0]);
});
