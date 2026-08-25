import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  exactCurrencyCode,
  isExactNonNegativeJsonMoney,
  parseExactMoneyInput,
  selectWithdrawalHistoryMoney,
  shouldRetainWithdrawalAttempt,
  validateDeliveryDaysInput,
  validateShippingCostInput,
  withdrawalNeedsLiveFx,
} from '../src/utils/sellerMoneySafety.js';

test('seller money input accepts exact cents and rejects lossy or unsafe values', () => {
  assert.deepEqual(parseExactMoneyInput('000200.10'), { amount: 200.1, minorUnits: 20010 });
  assert.deepEqual(parseExactMoneyInput('0'), { amount: 0, minorUnits: 0 });
  assert.equal(parseExactMoneyInput('0', { allowZero: false }), null);
  for (const value of ['', ' ', '-1', '+1', '1.', '.5', '1.001', '1e2', true, null, undefined]) {
    assert.equal(parseExactMoneyInput(value), null);
  }
  assert.equal(parseExactMoneyInput('90071992547409.92'), null);
  assert.equal(isExactNonNegativeJsonMoney(10.25), true);
  assert.equal(isExactNonNegativeJsonMoney(10.251), false);
  assert.equal(isExactNonNegativeJsonMoney('10.25'), false);
});

test('shipping cost and delivery contracts keep inactive paid defaults blank and exact', () => {
  assert.deepEqual(validateShippingCostInput('standard', '', false), { valid: true, amount: 0, error: '' });
  assert.equal(validateShippingCostInput('standard', '', true).valid, false);
  assert.equal(validateShippingCostInput('standard', '0', true).valid, false);
  assert.deepEqual(validateShippingCostInput('standard', '280.50', true), { valid: true, amount: 280.5, error: '' });
  assert.equal(validateShippingCostInput('standard', '280.501', true).valid, false);
  assert.equal(validateShippingCostInput('free', '0', true).valid, true);
  assert.equal(validateDeliveryDaysInput('1').valid, true);
  assert.equal(validateDeliveryDaysInput('1.5').valid, false);
  assert.equal(validateDeliveryDaysInput('0').valid, false);

  const source = readFileSync(new URL('../src/components/layout/ShippingConfiguration.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /cost:\s*(?:5\.99|12\.99)/);
  assert.match(source, /type: 'standard', cost: ''/);
  assert.match(source, /formatPrice\(costValidation\.amount/);
});

test('fallback rates block only withdrawals with a real conversion leg', () => {
  assert.equal(exactCurrencyCode('USD'), 'USD');
  assert.equal(exactCurrencyCode('usd'), null);
  assert.equal(withdrawalNeedsLiveFx('USD', 'USD'), false);
  assert.equal(withdrawalNeedsLiveFx('PKR', 'USD'), true);
  assert.equal(withdrawalNeedsLiveFx('USD', 'PKR'), true);
  assert.equal(withdrawalNeedsLiveFx('USD', undefined), true);
});

test('withdrawal retry key is retained only when no HTTP response exists', () => {
  assert.equal(shouldRetainWithdrawalAttempt(new Error('network unavailable')), true);
  for (const status of [400, 408, 409, 429, 500, 503]) {
    assert.equal(shouldRetainWithdrawalAttempt({ response: { status } }), false);
  }
});

test('seller payment screen clears stale authority and wires terminal-attempt retirement', () => {
  const source = readFileSync(new URL('../src/components/layout/SellerPayments.jsx', import.meta.url), 'utf8');
  assert.match(source, /summaryRef\.current = null;\s*setSummary\(null\);/);
  assert.match(source, /isExactNonNegativeJsonMoney\(displayRevenue\[field\]\)/);
  assert.match(source, /withdrawalBlockedByFallback = exchangeRatesAreFallback && withdrawalRequiresLiveFx/);
  assert.match(source, /if \(value !== withdrawAmount\) void retireActiveWithdrawalAttempt\(\)/);
  assert.match(source, /if \(!shouldRetainWithdrawalAttempt\(error\) && attemptKey\)/);
  assert.doesNotMatch(source, /Showing the last successfully loaded balances/);
  assert.doesNotMatch(source, /Number\(request\.(?:requestedAmount|payoutAmount)\)/);
});

test('versioned withdrawal history fails closed and only shows a materially different payout', () => {
  const same = selectWithdrawalHistoryMoney({
    payoutWorkflow: { version: 1 },
    requestedAmount: 100,
    requestedCurrency: 'USD',
    payoutAmount: 100,
    payoutCurrency: 'USD',
  });
  assert.equal(same.status, 'complete');
  assert.equal(same.showPayout, false);

  const converted = selectWithdrawalHistoryMoney({
    payoutWorkflow: { version: 1 },
    requestedAmount: 100,
    requestedCurrency: 'USD',
    payoutAmount: 28000,
    payoutCurrency: 'PKR',
  });
  assert.equal(converted.showPayout, true);
  assert.deepEqual(converted.payout, { amount: 28000, currency: 'PKR' });

  for (const malformed of [
    { requestedAmount: 10.001, requestedCurrency: 'USD', payoutAmount: 10, payoutCurrency: 'USD' },
    { requestedAmount: 10, requestedCurrency: 'usd', payoutAmount: 10, payoutCurrency: 'USD' },
    { requestedAmount: 10, requestedCurrency: 'USD', payoutAmount: '10', payoutCurrency: 'USD' },
    { requestedAmount: 10, requestedCurrency: 'USD', payoutAmount: 10, payoutCurrency: 'JPY' },
  ]) {
    const result = selectWithdrawalHistoryMoney({
      payoutWorkflow: { version: 1 },
      amount: 999,
      currency: 'USD',
      ...malformed,
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.requested, null);
    assert.equal(result.payout, null);
  }

  assert.deepEqual(selectWithdrawalHistoryMoney({
    payoutWorkflow: { version: 0 },
    amount: 25,
    currency: 'USD',
  }), {
    requested: { amount: 25, currency: 'USD' },
    payout: null,
    showPayout: false,
    status: 'legacy',
  });
});
