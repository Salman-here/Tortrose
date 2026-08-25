import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTaxConfigurationValue,
  taxConfigurationResponseIsValid,
} from '../src/utils/taxConfigurationSafety.js';

test('tax inputs preserve exact fixed cents and six-decimal percentages', () => {
  assert.deepEqual(parseTaxConfigurationValue('fixed', '1250.05'), { valid: true, value: 1250.05, error: '' });
  assert.deepEqual(parseTaxConfigurationValue('percentage', '7.123456'), { valid: true, value: 7.123456, error: '' });
  assert.equal(parseTaxConfigurationValue('fixed', '1.001').valid, false);
  assert.equal(parseTaxConfigurationValue('percentage', '7.1234567').valid, false);
  assert.equal(parseTaxConfigurationValue('percentage', '').valid, false);
  assert.equal(parseTaxConfigurationValue('percentage', true).valid, false);
});

test('stored tax responses require canonical currency and exact type-specific values', () => {
  assert.equal(taxConfigurationResponseIsValid({ type: 'fixed', value: 200, currency: 'PKR' }), true);
  assert.equal(taxConfigurationResponseIsValid({ type: 'percentage', value: 7.5, currency: 'USD' }), true);
  assert.equal(taxConfigurationResponseIsValid({ type: 'none', value: 0, currency: 'USD' }), true);
  assert.equal(taxConfigurationResponseIsValid({ type: 'fixed', value: 200.001, currency: 'PKR' }), false);
  assert.equal(taxConfigurationResponseIsValid({ type: 'fixed', value: 200, currency: 'pkr' }), false);
  assert.equal(taxConfigurationResponseIsValid({ type: 'percentage', value: 7.5, currency: 'PKR' }), false);
});
