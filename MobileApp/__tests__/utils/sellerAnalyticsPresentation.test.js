import {
  analyticsDayLabel, buildAnalyticsPlot, categoryBarPercent, nearestAnalyticsDay,
  revenueCardColumns, sellerAnalyticsPeriodIsValid, sortSellerStatuses,
} from '../../src/utils/sellerAnalyticsPresentation';

const report = days => ({
  currency: 'PKR', summary: { totalRevenue: 100, avgOrderValue: 100, paidOrders: 1, totalUnitsSold: 1 },
  revenueByDay: Array.from({ length: days }, (_, index) => ({
    date: new Date(Date.UTC(2026, 9, 14 - days + index)).toISOString().slice(0, 10), revenue: index === 0 ? 100 : 0, orders: index === 0 ? 1 : 0,
  })),
  topProducts: [{ name: 'Product', revenue: 100, sold: 1 }], categoryBreakdown: [{ name: 'Category', count: 1 }],
  statusBreakdown: [{ name: 'delivered', value: 1 }],
});

test.each([7, 30, 90])('retains every verified day in a %i-day period without changing stored values', days => {
  const source = report(days), before = JSON.stringify(source);
  expect(sellerAnalyticsPeriodIsValid(source, 'PKR', String(days))).toBe(true);
  const plot = buildAnalyticsPlot(source.revenueByDay, 'revenue', 300);
  expect(plot.points).toHaveLength(days);
  expect(plot.points[0].value).toBe(100);
  expect(plot.points[days - 1].value).toBe(0);
  expect(plot.points[days - 1].y).toBe(plot.baseline);
  expect(plot.linePath).not.toMatch(/NaN|Infinity/);
  expect(JSON.stringify(source)).toBe(before);
});

test.each(['wrong-length', 'duplicate', 'gap', 'invalid-date', 'wrong-currency', 'corrupt-money', 'unsafe-count'])('rejects %s reporting data', reason => {
  const value = report(30);
  if (reason === 'wrong-length') value.revenueByDay = value.revenueByDay.slice(-14);
  if (reason === 'duplicate') value.revenueByDay[1].date = value.revenueByDay[0].date;
  if (reason === 'gap') value.revenueByDay[1].date = '2026-09-20';
  if (reason === 'invalid-date') value.revenueByDay[1].date = '2026-02-30';
  if (reason === 'wrong-currency') value.currency = 'USD';
  if (reason === 'corrupt-money') value.revenueByDay[0].revenue = 0.001;
  if (reason === 'unsafe-count') value.statusBreakdown.push({ name: 'pending', value: Number.MAX_SAFE_INTEGER });
  expect(sellerAnalyticsPeriodIsValid(value, 'PKR', '30')).toBe(false);
});

test('category bars use the same largest-category scale as the website', () => {
  const categories = [{ name: 'First', count: 100 }, { name: 'Second', count: 50 }, { name: 'Empty', count: 0 }];
  expect(categoryBarPercent(categories[0], categories)).toBe(100);
  expect(categoryBarPercent(categories[1], categories)).toBe(50);
  expect(categoryBarPercent(categories[2], categories)).toBe(0);
  expect(categoryBarPercent({ count: 0 }, [{ count: 0 }])).toBe(0);
});

test('status order, UTC date labels and touch selection are stable at chart boundaries', () => {
  expect(sortSellerStatuses([{ name: 'cancelled' }, { name: 'delivered' }, { name: 'pending' }]).map(row => row.name)).toEqual(['pending', 'delivered', 'cancelled']);
  expect(analyticsDayLabel('2026-10-13', true)).toBe('13 Oct 2026');
  expect(nearestAnalyticsDay(-50, 300, 90)).toBe(0);
  expect(nearestAnalyticsDay(400, 300, 90)).toBe(89);
  expect(nearestAnalyticsDay(150, 300, 90)).toBe(45);
  expect(buildAnalyticsPlot([], 'orders', 300).ticks).toEqual([]);
});

test('phone and large-font revenue cards remain full width; tablets use two columns', () => {
  expect(revenueCardColumns(320)).toBe(1);
  expect(revenueCardColumns(390)).toBe(1);
  expect(revenueCardColumns(768)).toBe(2);
  expect(revenueCardColumns(768, 1.5)).toBe(1);
});
