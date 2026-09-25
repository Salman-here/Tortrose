'use strict';
const { monthlyBoundary, proratedPlanChange, renewalPeriod, applyBillingCredit } = require('../../services/safepayBillingMath');
test('month-end anchor survives February, leap years and subsequent March', () => {
  const anchor = '2028-01-31T12:30:45.123Z';
  expect(monthlyBoundary(anchor, 1).toISOString()).toBe('2028-02-29T12:30:45.123Z');
  expect(monthlyBoundary(anchor, 2).toISOString()).toBe('2028-03-31T12:30:45.123Z');
  expect(monthlyBoundary(anchor, 13).toISOString()).toBe('2029-02-28T12:30:45.123Z');
});
test('upgrades and add-on removals retain exact auditable cent line items', () => {
  const period = { periodStart: '2026-09-01T00:00:00Z', periodEnd: '2026-10-01T00:00:00Z', at: '2026-09-16T00:00:00Z' };
  expect(proratedPlanChange({ ...period, sourceMinor: 999, targetMinor: 2165 })).toMatchObject({ unusedCreditMinor: 500, remainingChargeMinor: 1083, dueMinor: 583, creditMinor: 0 });
  expect(proratedPlanChange({ ...period, sourceMinor: 2565, targetMinor: 2165 })).toMatchObject({ unusedCreditMinor: 1283, remainingChargeMinor: 1083, dueMinor: 0, creditMinor: 200 });
});
test('full-period change equals the exact price difference', () => {
  expect(proratedPlanChange({ sourceMinor: 599, targetMinor: 1299, periodStart: '2026-09-01', periodEnd: '2026-10-01', at: '2026-09-01' }).dueMinor).toBe(700);
});
test.each([NaN, Infinity, -1, 1.1, '999', null])('invalid stored price %s is rejected', sourceMinor => {
  expect(() => proratedPlanChange({ sourceMinor, targetMinor: 1000, periodStart: '2026-09-01', periodEnd: '2026-10-01', at: '2026-09-10' })).toThrow();
});
test('a stale period does not create an automatic catch-up charge', () => {
  expect(renewalPeriod({ anchorAt: '2026-08-01', cycle: 0, now: new Date('2026-09-15') })).toMatchObject({ due: false, missed: true });
  expect(() => proratedPlanChange({ sourceMinor: 999, targetMinor: 2165, periodStart: '2026-08-01', periodEnd: '2026-09-01', at: '2026-09-15' })).toThrow();
});
test('invoice credits reduce the charged amount without becoming seller earnings or a negative charge', () => {
  expect(applyBillingCredit(999, 200)).toEqual({ grossMinor: 999, appliedCreditMinor: 200, chargeMinor: 799, remainingCreditMinor: 0 });
  expect(applyBillingCredit(999, 1500)).toEqual({ grossMinor: 999, appliedCreditMinor: 999, chargeMinor: 0, remainingCreditMinor: 501 });
});
