import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidCurrencyChangeLimit, inspectSellerProductCurrencyState } from '../src/utils/productFormCurrency.js';
const limit = { cooldownDays: 60, canChange: false, daysRemaining: 60, lastChangedAt: '2026-09-09T00:00:00.000Z', nextAllowedAt: '2026-11-08T00:00:00.000Z' };
test('web accepts exact sixty-day policy and optional legacy omission', () => {
  assert.equal(isValidCurrencyChangeLimit(limit), true);
  assert.equal(isValidCurrencyChangeLimit(undefined), true);
  assert.equal(isValidCurrencyChangeLimit({ cooldownDays: 60, canChange: true, daysRemaining: 0, lastChangedAt: null, nextAllowedAt: null }), true);
});
test('web rejects malformed or contradictory waiting-period metadata', () => {
  for (const invalid of [null, {}, { ...limit, cooldownDays: '60' }, { ...limit, cooldownDays: 0 }, { ...limit, daysRemaining: -1 }, { ...limit, canChange: true }, { ...limit, nextAllowedAt: 'invalid' }, { ...limit, nextAllowedAt: '2026-11-09T00:00:00.000Z' }]) assert.equal(isValidCurrencyChangeLimit(invalid), false);
  assert.equal(inspectSellerProductCurrencyState({ hasStore: true, canAddProduct: true, changeLimit: null }).valid, false);
});
