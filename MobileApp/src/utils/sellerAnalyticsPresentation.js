import { sellerAnalyticsMoneyIsValid } from './currencySafety';

export const SELLER_ANALYTICS_STATUS_ORDER = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];

// The native charts must show the same complete, consecutive UTC-day series
// as the website. Never truncate a 30/90-day response to the last 14 days.
export const sellerAnalyticsPeriodIsValid = (analytics, currency, days) => {
  if (!sellerAnalyticsMoneyIsValid(analytics, currency)
    || !['7', '30', '90'].includes(String(days))
    || analytics.revenueByDay.length !== Number(days)) return false;
  let previous = null;
  for (const row of analytics.revenueByDay) {
    if (typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return false;
    const stamp = Date.parse(`${row.date}T00:00:00.000Z`);
    if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== row.date
      || (previous !== null && stamp - previous !== 86400000)) return false;
    previous = stamp;
  }
  return Number.isSafeInteger(analytics.statusBreakdown.reduce((sum, row) => sum + row.value, 0));
};

export const analyticsDayLabel = (date, long = false) => new Date(`${date}T00:00:00.000Z`)
  .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(long ? { year: 'numeric' } : {}), timeZone: 'UTC' });

export const revenueCardColumns = (width, fontScale = 1) => width >= 600 && fontScale < 1.4 ? 2 : 1;

export const categoryBarPercent = (category, categories) => {
  const maximum = Math.max(0, ...categories.map(row => row.count));
  return maximum > 0 ? (category.count / maximum) * 100 : 0;
};

export const sortSellerStatuses = rows => [...rows].sort((left, right) => {
  const rank = name => {
    const position = SELLER_ANALYTICS_STATUS_ORDER.indexOf(name);
    return position < 0 ? SELLER_ANALYTICS_STATUS_ORDER.length : position;
  };
  return rank(left.name) - rank(right.name);
});

// Geometry changes only drawing coordinates, never the stored money/counts.
export const buildAnalyticsPlot = (rows, field, width, height = 160) => {
  const inset = 8;
  const baseline = height - 12;
  const maximum = Math.max(1, ...rows.map(row => row[field]));
  const usableWidth = Math.max(1, width - inset * 2);
  const points = rows.map((row, index) => ({
    index, date: row.date, value: row[field],
    x: inset + (rows.length > 1 ? index / (rows.length - 1) : 0.5) * usableWidth,
    y: baseline - (row[field] / maximum) * (baseline - 12),
  }));
  const linePath = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
  const areaPath = points.length ? `${linePath} L ${points[points.length - 1].x} ${baseline} L ${points[0].x} ${baseline} Z` : '';
  const ticks = rows.length ? [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])] : [];
  return { points, maximum, baseline, inset, usableWidth, linePath, areaPath, ticks };
};

export const nearestAnalyticsDay = (position, width, count) => {
  if (count <= 1) return 0;
  const fraction = (position - 8) / Math.max(1, width - 16);
  return Math.max(0, Math.min(count - 1, Math.round(fraction * (count - 1))));
};
