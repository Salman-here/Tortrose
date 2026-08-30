'use strict';

const {
  calculateTrialPeriod,
  normalizeTrialGrantInput,
} = require('../../services/sellerTrialGrantService');

describe('seller trial grant input and calendar arithmetic', () => {
  test('accepts explicit days/months and preserves the legacy extensionDays request', () => {
    expect(normalizeTrialGrantInput({ amount: 2, unit: 'months', mode: 'extend' }))
      .toEqual({ amount: 2, unit: 'months', mode: 'extend' });
    expect(normalizeTrialGrantInput({ extensionDays: 15 }))
      .toEqual({ amount: 15, unit: 'days', mode: 'reset' });
  });

  test.each([
    [{ amount: '2', unit: 'months', mode: 'reset' }, 'ADMIN_TRIAL_DURATION_INVALID'],
    [{ amount: true, unit: 'days', mode: 'reset' }, 'ADMIN_TRIAL_DURATION_INVALID'],
    [{ amount: 0, unit: 'days', mode: 'reset' }, 'ADMIN_TRIAL_DURATION_INVALID'],
    [{ amount: 1.5, unit: 'days', mode: 'reset' }, 'ADMIN_TRIAL_DURATION_INVALID'],
    [{ amount: 1, unit: 'weeks', mode: 'reset' }, 'ADMIN_TRIAL_UNIT_INVALID'],
    [{ amount: 1, unit: 'days', mode: 'replace' }, 'ADMIN_TRIAL_MODE_INVALID'],
    [{ amount: 121, unit: 'months', mode: 'reset' }, 'ADMIN_TRIAL_DURATION_TOO_LARGE'],
  ])('rejects malformed or unsafe trial input %#', (input, code) => {
    expect(() => normalizeTrialGrantInput(input)).toThrow(expect.objectContaining({ code }));
  });

  test('one calendar month clips January 31 to the last February day', () => {
    const now = new Date('2028-01-31T12:34:56.000Z');
    const period = calculateTrialPeriod({
      amount: 1,
      unit: 'months',
      mode: 'reset',
      now,
    });
    expect(period.startsAt).toEqual(now);
    expect(period.endsAt).toEqual(new Date('2028-02-29T12:34:56.000Z'));
  });

  test('extend starts after a future trial end but an expired trial restarts now', () => {
    const now = new Date('2026-08-30T10:00:00.000Z');
    const future = calculateTrialPeriod({
      currentTrialEndDate: new Date('2026-09-05T10:00:00.000Z'),
      amount: 10,
      unit: 'days',
      mode: 'extend',
      now,
    });
    expect(future.extendedExistingTrial).toBe(true);
    expect(future.endsAt).toEqual(new Date('2026-09-15T10:00:00.000Z'));

    const expired = calculateTrialPeriod({
      currentTrialEndDate: new Date('2026-08-01T10:00:00.000Z'),
      amount: 10,
      unit: 'days',
      mode: 'extend',
      now,
    });
    expect(expired.extendedExistingTrial).toBe(false);
    expect(expired.endsAt).toEqual(new Date('2026-09-09T10:00:00.000Z'));
  });
});
