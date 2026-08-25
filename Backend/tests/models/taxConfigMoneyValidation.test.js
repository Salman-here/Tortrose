'use strict';

const TaxConfig = require('../../models/TaxConfig');

describe('tax configuration money schema integrity', () => {
  test('validates atomic tax updates against the final query type', () => {
    const validator = TaxConfig.schema.path('value').validators.find(
      entry => String(entry.message).startsWith('Tax value must match its type'),
    ).validator;
    const queryFor = type => ({ get: path => (path === 'type' ? type : undefined) });

    expect(validator.call(queryFor('fixed'), 2800)).toBe(true);
    expect(validator.call(queryFor('fixed'), 0.001)).toBe(false);
    expect(validator.call(queryFor('percentage'), 7.123456)).toBe(true);
    expect(validator.call(queryFor('percentage'), 7.1234567)).toBe(false);
    expect(validator.call(queryFor('none'), 0)).toBe(true);
    expect(validator.call(queryFor('none'), 0.01)).toBe(false);
    expect(validator.call(queryFor(undefined), 10)).toBe(false);
  });

  test.each([
    { type: 'none', value: 0, currency: 'USD' },
    { type: 'percentage', value: 7.125, currency: 'USD' },
    { type: 'percentage', value: 7.123456, currency: 'USD' },
    { type: 'fixed', value: 1.01, currency: 'PKR' },
  ])('accepts a valid tax configuration %#', config => {
    expect(new TaxConfig(config).validateSync()).toBeUndefined();
  });

  test.each([
    [{ type: 'none', value: 0.01, currency: 'USD' }, 'value'],
    [{ type: 'percentage', value: 100.01, currency: 'USD' }, 'value'],
    [{ type: 'percentage', value: 7.1234567, currency: 'USD' }, 'value'],
    [{ type: 'fixed', value: 0.004, currency: 'USD' }, 'value'],
    [{ type: 'fixed', value: 1.005, currency: 'USD' }, 'value'],
    [{ type: 'fixed', value: Number.POSITIVE_INFINITY, currency: 'USD' }, 'value'],
    [{ type: 'fixed', value: '1.00', currency: 'USD' }, 'value'],
    [{ type: 'fixed', value: '', currency: 'USD' }, 'value'],
    [{ type: 'fixed', value: true, currency: 'USD' }, 'value'],
    [{ type: 'fixed', value: Number.MAX_SAFE_INTEGER, currency: 'USD' }, 'value'],
    [{ type: 'percentage', value: '7.5', currency: 'USD' }, 'value'],
    [{ type: 'percentage', value: false, currency: 'USD' }, 'value'],
    [{ type: 'fixed', value: 1, currency: 'usd' }, 'currency'],
    [{ type: 'fixed', value: 1, currency: null }, 'currency'],
  ])('rejects corrupt persisted tax configuration %#', (config, expectedPath) => {
    const error = new TaxConfig(config).validateSync();
    expect(error?.errors?.[expectedPath]).toBeDefined();
  });
});
