import { readFileSync } from 'fs';
import {
  exactCurrencyCode,
  isExactNonNegativeJsonMoney,
  parseExactMoneyInput,
  selectWithdrawalHistoryMoney,
  shouldRetainWithdrawalAttempt,
  validateDeliveryDaysInput,
  validateShippingCostInput,
  withdrawalNeedsLiveFx,
} from '../../src/utils/sellerMoneySafety';

describe('seller client money safety', () => {
  test('accepts exact cents and rejects lossy or unsafe inputs', () => {
    expect(parseExactMoneyInput('000200.10')).toEqual({ amount: 200.1, minorUnits: 20010 });
    expect(parseExactMoneyInput('0')).toEqual({ amount: 0, minorUnits: 0 });
    expect(parseExactMoneyInput('0', { allowZero: false })).toBeNull();
    ['', ' ', '-1', '+1', '1.', '.5', '1.001', '1e2', true, null, undefined].forEach((value) => {
      expect(parseExactMoneyInput(value)).toBeNull();
    });
    expect(parseExactMoneyInput('90071992547409.92')).toBeNull();
    expect(isExactNonNegativeJsonMoney(10.25)).toBe(true);
    expect(isExactNonNegativeJsonMoney(10.251)).toBe(false);
    expect(isExactNonNegativeJsonMoney('10.25')).toBe(false);
  });

  test('keeps inactive paid shipping blank and validates exact costs/days', () => {
    expect(validateShippingCostInput('standard', '', false)).toEqual({ valid: true, amount: 0, error: '' });
    expect(validateShippingCostInput('standard', '', true).valid).toBe(false);
    expect(validateShippingCostInput('standard', '0', true).valid).toBe(false);
    expect(validateShippingCostInput('standard', '280.50', true)).toEqual({ valid: true, amount: 280.5, error: '' });
    expect(validateShippingCostInput('standard', '280.501', true).valid).toBe(false);
    expect(validateShippingCostInput('free', '0', true).valid).toBe(true);
    expect(validateDeliveryDaysInput('1').valid).toBe(true);
    expect(validateDeliveryDaysInput('1.5').valid).toBe(false);
    expect(validateDeliveryDaysInput('0').valid).toBe(false);

    const source = readFileSync(require.resolve('../../src/screens/seller/SellerShippingConfigurationScreen.js'), 'utf8');
    expect(source).not.toMatch(/cost:\s*(?:5\.99|12\.99)/);
    expect(source).toMatch(/type: 'standard', cost: ''/);
    expect(source).toMatch(/formatPrice\(costValidation\.amount/);
  });

  test('blocks fallback only for real conversion legs and clears every HTTP response', () => {
    expect(exactCurrencyCode('USD')).toBe('USD');
    expect(exactCurrencyCode('usd')).toBeNull();
    expect(withdrawalNeedsLiveFx('USD', 'USD')).toBe(false);
    expect(withdrawalNeedsLiveFx('PKR', 'USD')).toBe(true);
    expect(withdrawalNeedsLiveFx('USD', 'PKR')).toBe(true);
    expect(withdrawalNeedsLiveFx('USD', undefined)).toBe(true);
    expect(shouldRetainWithdrawalAttempt(new Error('network unavailable'))).toBe(true);
    [400, 408, 409, 429, 500, 503].forEach((status) => {
      expect(shouldRetainWithdrawalAttempt({ response: { status } })).toBe(false);
    });
  });

  test('payment screen clears stale authority and wires terminal-attempt retirement', () => {
    const source = readFileSync(require.resolve('../../src/screens/seller/SellerPaymentsScreen.js'), 'utf8');
    expect(source).toMatch(/summaryRef\.current = null;\s*setSummary\(null\);/);
    expect(source).toMatch(/isExactNonNegativeJsonMoney\(displayRevenue\[field\]\)/);
    expect(source).toMatch(/withdrawalBlockedByFallback = exchangeRatesAreFallback && withdrawalRequiresLiveFx/);
    expect(source).toMatch(/if \(value !== withdrawAmount\) void retireActiveWithdrawalAttempt\(\)/);
    expect(source).toMatch(/if \(!shouldRetainWithdrawalAttempt\(error\) && attemptKey\)/);
    expect(source).not.toMatch(/Number\(request\.(?:requestedAmount|payoutAmount)\)/);
  });

  test('fails closed for malformed versioned history and hides identical payout copies', () => {
    const same = selectWithdrawalHistoryMoney({
      payoutWorkflow: { version: 1 },
      requestedAmount: 100,
      requestedCurrency: 'USD',
      payoutAmount: 100,
      payoutCurrency: 'USD',
    });
    expect(same.status).toBe('complete');
    expect(same.showPayout).toBe(false);

    const converted = selectWithdrawalHistoryMoney({
      payoutWorkflow: { version: 1 },
      requestedAmount: 100,
      requestedCurrency: 'USD',
      payoutAmount: 28000,
      payoutCurrency: 'PKR',
    });
    expect(converted.showPayout).toBe(true);
    expect(converted.payout).toEqual({ amount: 28000, currency: 'PKR' });

    [
      { requestedAmount: 10.001, requestedCurrency: 'USD', payoutAmount: 10, payoutCurrency: 'USD' },
      { requestedAmount: 10, requestedCurrency: 'usd', payoutAmount: 10, payoutCurrency: 'USD' },
      { requestedAmount: 10, requestedCurrency: 'USD', payoutAmount: '10', payoutCurrency: 'USD' },
      { requestedAmount: 10, requestedCurrency: 'USD', payoutAmount: 10, payoutCurrency: 'JPY' },
    ].forEach((malformed) => {
      const result = selectWithdrawalHistoryMoney({
        payoutWorkflow: { version: 1 },
        amount: 999,
        currency: 'USD',
        ...malformed,
      });
      expect(result).toEqual({ requested: null, payout: null, showPayout: false, status: 'unavailable' });
    });

    expect(selectWithdrawalHistoryMoney({
      payoutWorkflow: { version: 0 },
      amount: 25,
      currency: 'USD',
    })).toEqual({
      requested: { amount: 25, currency: 'USD' },
      payout: null,
      showPayout: false,
      status: 'legacy',
    });
  });
});
