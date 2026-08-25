'use strict';

const calendarError = message => {
  const error = new Error(message);
  error.code = 'UTC_CALENDAR_DATE_INVALID';
  error.statusCode = 400;
  return error;
};

const requireUtcDate = (value, field = 'date') => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw calendarError(`${field} must be a valid Date.`);
  }
  return new Date(value.getTime());
};

const requireWholeOffset = (value, field) => {
  if (!Number.isSafeInteger(value)) {
    throw calendarError(`${field} must be a safe whole number.`);
  }
  return value;
};

const utcDaysInMonth = (year, zeroBasedMonth) => {
  // Date.UTC remaps years 0..99 to 1900..1999. setUTCFullYear does not, so it
  // keeps the helper correct across the complete JavaScript Date range.
  const boundary = new Date(0);
  boundary.setUTCHours(0, 0, 0, 0);
  boundary.setUTCFullYear(year, zeroBasedMonth + 1, 0);
  if (!Number.isFinite(boundary.getTime())) {
    throw calendarError('The target UTC calendar month is outside the supported range.');
  }
  return boundary.getUTCDate();
};

/**
 * Adds calendar months in UTC while preserving the time-of-day and clamping
 * the day to the target month's final day. This avoids JavaScript Date's
 * overflow behaviour (Jan 31 + one month becoming a date in March).
 */
const addUtcCalendarMonths = (value, months) => {
  const source = requireUtcDate(value);
  const offset = requireWholeOffset(months, 'Month offset');
  const absoluteMonth = source.getUTCFullYear() * 12 + source.getUTCMonth() + offset;
  if (!Number.isSafeInteger(absoluteMonth)) {
    throw calendarError('The calculated UTC calendar month is outside the safe integer range.');
  }
  const targetYear = Math.floor(absoluteMonth / 12);
  const targetMonth = ((absoluteMonth % 12) + 12) % 12;
  const targetDay = Math.min(
    source.getUTCDate(),
    utcDaysInMonth(targetYear, targetMonth),
  );
  const result = new Date(source.getTime());
  result.setUTCFullYear(targetYear, targetMonth, targetDay);
  if (!Number.isFinite(result.getTime())) {
    throw calendarError('The calculated UTC calendar date is outside the supported range.');
  }
  return result;
};

const addUtcCalendarYears = (value, years) => {
  const offset = requireWholeOffset(years, 'Year offset');
  if (
    offset > Math.floor(Number.MAX_SAFE_INTEGER / 12)
    || offset < Math.ceil(Number.MIN_SAFE_INTEGER / 12)
  ) {
    throw calendarError('The year offset is outside the supported range.');
  }
  return addUtcCalendarMonths(value, offset * 12);
};

module.exports = {
  addUtcCalendarMonths,
  addUtcCalendarYears,
  requireUtcDate,
};
