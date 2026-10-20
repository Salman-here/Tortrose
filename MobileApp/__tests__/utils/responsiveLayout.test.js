import { getResponsiveLayout } from '../../src/utils/responsiveLayout';
const { applyTabletOrientation } = require('../../plugins/with-tablet-orientation.cjs');

test.each([320, 360, 375, 390, 411, 430, 480, 599])('phone %s retains exactly the existing two-column geometry', width => {
  const layout = getResponsiveLayout(width);
  expect(layout.isTablet).toBe(false);
  expect(layout.catalogColumns).toBe(2);
  expect(layout.contentWidth).toBe(width);
  expect(layout.catalogCardWidth).toBe((width - 40) / 2);
});
test.each([600, 640, 768, 800, 960, 1024, 1280, 1600])('tablet %s stays inside a centered canvas', width => {
  const layout = getResponsiveLayout(width);
  expect(layout.isTablet).toBe(true);
  expect(layout.catalogColumns).toBeGreaterThanOrEqual(3);
  expect(layout.catalogColumns).toBeLessThanOrEqual(5);
  expect(layout.contentWidth).toBeLessThanOrEqual(1120);
  expect(layout.catalogCardWidth * layout.catalogColumns + 8 * (layout.catalogColumns - 1) + 32).toBeCloseTo(layout.contentWidth);
});
test('split screen, safe-area insets and form canvas sizes are calculated from the current window', () => {
  expect(getResponsiveLayout(800, { left: 30, right: 30, maxWidth: 700 }).contentWidth).toBe(700);
  expect(getResponsiveLayout(590).isTablet).toBe(false);
  expect(getResponsiveLayout(NaN).catalogCardWidth).toBe(0);
});
test('larger tablet text gets fewer, wider cards without changing phone geometry', () => {
  expect(getResponsiveLayout(800, { fontScale: 1.5 }).catalogColumns).toBe(2);
  expect(getResponsiveLayout(390, { fontScale: 1.5 }).catalogCardWidth).toBe((390 - 40) / 2);
});
test.each(['kt', 'java'])('native tablet orientation patch is scoped and idempotent (%s)', language => {
  const source = language === 'kt' ? 'override fun onCreate() { super.onCreate(null) }' : 'void onCreate() { super.onCreate(null); }';
  const result = applyTabletOrientation(source, language);
  expect(result).toContain('smallestScreenWidthDp >= 600');
  expect(result).toContain('SCREEN_ORIENTATION_FULL_USER');
  expect(applyTabletOrientation(result, language)).toBe(result);
});
test('native patch fails closed if the activity template changes', () => {
  expect(() => applyTabletOrientation('unknown', 'kt')).toThrow(/expected/);
});
