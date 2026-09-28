'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { safepayWorkersEnabled } = require('../../services/safepayFeatureFlags');
test.each([
  [{}, false],
  [{ SAFEPAY_MOBILE_ENABLED: 'false', SAFEPAY_WEB_ENABLED: 'false' }, false],
  [{ SAFEPAY_MOBILE_ENABLED: 'true', SAFEPAY_WEB_ENABLED: 'false' }, true],
  [{ SAFEPAY_MOBILE_ENABLED: 'false', SAFEPAY_WEB_ENABLED: 'true' }, true],
  [{ SAFEPAY_MOBILE_ENABLED: 'true', SAFEPAY_WEB_ENABLED: 'true' }, true],
  [{ SAFEPAY_WEB_ENABLED: true }, false],
])('shared financial workers honor exact web/mobile configuration %j', (env, expected) => {
  expect(safepayWorkersEnabled(env)).toBe(expected);
});
test.each(['safepayWebhookWorker.js', 'safepayBillingLifecycleService.js'])('%s uses the shared predicate at startup and during processing', file => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../services', file), 'utf8');
  expect(source).toContain("require('./safepayFeatureFlags')");
  expect(source.match(/!safepayWorkersEnabled\(\)/g)).toHaveLength(2);
  expect(source).not.toContain('process.env.SAFEPAY_MOBILE_ENABLED');
});
