'use strict';

const {
  addUtcCalendarMonths,
  addUtcCalendarYears,
} = require('../../services/utcCalendarService');

describe('UTC end-of-month-clamped calendar arithmetic', () => {
  test.each([
    ['2026-01-31T12:34:56.789Z', 1, '2026-02-28T12:34:56.789Z'],
    ['2024-01-31T12:34:56.789Z', 1, '2024-02-29T12:34:56.789Z'],
    ['2026-01-31T12:34:56.789Z', 6, '2026-07-31T12:34:56.789Z'],
    ['2026-08-31T12:34:56.789Z', 6, '2027-02-28T12:34:56.789Z'],
    ['2023-08-28T12:34:56.789Z', 6, '2024-02-28T12:34:56.789Z'],
    ['2023-08-29T12:34:56.789Z', 6, '2024-02-29T12:34:56.789Z'],
    ['2023-08-31T12:34:56.789Z', 6, '2024-02-29T12:34:56.789Z'],
    ['2024-08-29T12:34:56.789Z', 6, '2025-02-28T12:34:56.789Z'],
    ['0100-01-31T12:34:56.789Z', -1, '0099-12-31T12:34:56.789Z'],
  ])('adds %i months to %s without local-time or overflow drift', (start, months, end) => {
    expect(addUtcCalendarMonths(new Date(start), months).toISOString()).toBe(end);
  });

  test.each([
    ['2024-02-29T23:59:59.999Z', 3, '2027-02-28T23:59:59.999Z'],
    ['2023-01-31T00:00:00.000Z', 3, '2026-01-31T00:00:00.000Z'],
    ['2023-03-01T00:00:00.000Z', 3, '2026-03-01T00:00:00.000Z'],
  ])('adds %i calendar years to %s with leap-day clamping', (start, years, end) => {
    expect(addUtcCalendarYears(new Date(start), years).toISOString()).toBe(end);
  });

  test.each([
    [null, 6],
    [new Date('invalid'), 6],
    [new Date(), 0.5],
    [new Date(), Number.MAX_VALUE],
  ])('rejects invalid inputs %p and %p', (date, offset) => {
    expect(() => addUtcCalendarMonths(date, offset)).toThrow(expect.objectContaining({
      code: 'UTC_CALENDAR_DATE_INVALID',
    }));
  });
});
