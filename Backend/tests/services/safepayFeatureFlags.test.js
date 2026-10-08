'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { safepayWorkersEnabled } = require('../../services/safepayFeatureFlags');
const credentials = environment => ({ SAFEPAY_ENV: environment,
  [`SAFEPAY_${environment.toUpperCase()}_PUBLIC_KEY`]: 'sec_worker-fixture',
  [`SAFEPAY_${environment.toUpperCase()}_SECRET_KEY`]: 'private-worker-fixture-secret',
  [`SAFEPAY_${environment.toUpperCase()}_WEBHOOK_SECRET`]: 'private-worker-fixture-webhook',
  [`SAFEPAY_${environment.toUpperCase()}_WEBHOOK_SCHEME`]: 'sha512-raw' });

test.each(['sandbox', 'production'])('configured %s workers drain liabilities regardless of checkout switches', environment => {
  for (const web of [undefined, 'false', 'true', false, true, 'invalid']) {
    for (const mobile of [undefined, 'false', 'true', false, true, 'invalid']) {
      expect(safepayWorkersEnabled({ ...credentials(environment), SAFEPAY_WEB_ENABLED: web, SAFEPAY_MOBILE_ENABLED: mobile })).toBe(true);
    }
  }
});

test('unconfigured, incomplete, invalid and wrong-environment credentials never start workers', () => {
  expect(safepayWorkersEnabled({})).toBe(false);
  expect(safepayWorkersEnabled({ SAFEPAY_WEB_ENABLED: 'true', SAFEPAY_MOBILE_ENABLED: 'true' })).toBe(false);
  expect(safepayWorkersEnabled({ ...credentials('sandbox'), SAFEPAY_ENV: 'production' })).toBe(false);
  expect(safepayWorkersEnabled({ ...credentials('production'), SAFEPAY_ENV: 'sandbox' })).toBe(false);
  expect(safepayWorkersEnabled({ ...credentials('sandbox'), SAFEPAY_ENV: 'invalid' })).toBe(false);
  for (const key of ['PUBLIC_KEY', 'SECRET_KEY', 'WEBHOOK_SECRET', 'WEBHOOK_SCHEME']) {
    const env = credentials('sandbox'); delete env[`SAFEPAY_SANDBOX_${key}`];
    expect(safepayWorkersEnabled(env)).toBe(false);
  }
});
test.each(['safepayWebhookWorker.js', 'safepayBillingLifecycleService.js'])('%s uses the shared predicate at startup and during processing', file => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../services', file), 'utf8');
  expect(source).toContain("require('./safepayFeatureFlags')");
  expect(source.match(/!safepayWorkersEnabled\(\)/g)).toHaveLength(2);
  expect(source).not.toContain('process.env.SAFEPAY_MOBILE_ENABLED');
});
