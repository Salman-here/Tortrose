import { getBottomTabTheme } from '../../src/utils/bottomTabTheme';
import { lightPalette, darkPalette } from '../../src/styles/palettes';

describe('bottom tab theme', () => {
  it('uses a genuinely dark surface and readable inactive icons in dark mode', () => {
    const theme = getBottomTabTheme(darkPalette, true);

    expect(theme.surfaceColor).toBe('rgba(8,12,26,0.96)');
    expect(theme.blurTint).toBe('dark');
    expect(theme.inactiveIconColor).toBe(darkPalette.colors.textSecondary);
    expect(theme.finishColors).not.toEqual(getBottomTabTheme(lightPalette, false).finishColors);
  });

  it('preserves the existing bright premium glass treatment in light mode', () => {
    const theme = getBottomTabTheme(lightPalette, false);

    expect(theme.surfaceColor).toBe('rgba(248,250,255,0.94)');
    expect(theme.blurTint).toBe('default');
    expect(theme.inactiveIconColor).toBe(lightPalette.colors.textLight);
  });
});
