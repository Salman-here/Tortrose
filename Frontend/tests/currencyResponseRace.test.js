import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { responseCurrencyMatchesRequest } from '../src/utils/currencySafety.js';

test('money responses must match the exact supported captured currency', () => {
  assert.equal(responseCurrencyMatchesRequest('PKR', 'pkr'), true);
  assert.equal(responseCurrencyMatchesRequest('USD', 'PKR'), false);
  assert.equal(responseCurrencyMatchesRequest('JPY', 'JPY'), false);
  assert.equal(responseCurrencyMatchesRequest('', 'USD'), false);
  assert.equal(responseCurrencyMatchesRequest('USD', ''), false);
});

test('admin and coupon analytics abort stale requests and validate captured currencies', () => {
  const adminSource = readFileSync(
    new URL('../src/components/layout/AdminAnalytics.jsx', import.meta.url),
    'utf8',
  );
  const couponSource = readFileSync(
    new URL('../src/components/layout/CouponManagement.jsx', import.meta.url),
    'utf8',
  );

  for (const source of [adminSource, couponSource]) {
    assert.match(source, /new AbortController\(\)/);
    assert.match(source, /signal: controller\.signal/);
    assert.match(source, /analyticsRequestRef\.current\.id === requestId/);
    assert.match(source, /controller\.signal\.aborted/);
  }
  assert.match(adminSource, /adminAnalyticsResponseIsValid\(nextAnalytics, requestedCurrency\)/);
  assert.match(couponSource, /couponAnalyticsResponseIsValid\(res\.data, requestedCurrency\)/);
});
