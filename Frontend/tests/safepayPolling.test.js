import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { safepayPollingDelay, safepayRetryAfterMs } from '../src/utils/safepayPolling.js';

test('long-running pending verification stays below the account polling limit', () => {
  assert.equal(safepayPollingDelay(0), 4000);
  assert.equal(safepayPollingDelay(60000), 10000);
  assert.equal(safepayPollingDelay(300000), 30000);
  let elapsed = 0, requests = 0;
  while (elapsed < 900000) { requests++; elapsed += safepayPollingDelay(elapsed); }
  assert.ok(requests < 90, `Only ${requests} automatic checks per 15 minutes.`);
});

test('429 honors numeric and HTTP-date retry-after without a zero-delay loop', () => {
  const response = headers => ({ response: { status: 429, headers } });
  assert.equal(safepayRetryAfterMs(response({ 'retry-after': '900' })), 900000);
  assert.equal(safepayRetryAfterMs(response({ get: () => '20' })), 20000);
  assert.equal(safepayRetryAfterMs(response({ 'retry-after': '0' })), 1000);
  assert.equal(safepayRetryAfterMs(response({ 'retry-after': 'Thu, 01 Oct 2026 00:00:30 GMT' }), Date.parse('2026-10-01T00:00:00Z')), 30000);
  for (const value of [undefined, '', 'not-a-delay', '-1']) {
    assert.equal(safepayRetryAfterMs(response({ 'retry-after': value })), 60000);
  }
  assert.equal(safepayRetryAfterMs({ response: { status: 503 } }), 0);
});

test('both web verification surfaces back off and preserve pending outcomes', () => {
  const provider = readFileSync(new URL('../src/components/common/SafepayCheckoutProvider.jsx', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../src/pages/SafepayReturnPage.jsx', import.meta.url), 'utf8');
  assert.match(provider, /await check\(\)/);
  assert.match(provider, /retryNotBefore\.current - Date\.now\(\)/);
  assert.doesNotMatch(provider, /setInterval/);
  assert.match(provider, /status: 'pending'.*isPaid: false/);
  assert.match(page, /setTimeout\(check, retryAfter\)/);
  assert.match(page, /disabled=\{coolingDown\}/);
  assert.match(page, /resuming \|\| coolingDown/);
});
