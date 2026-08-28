import {
  isThemeMode,
  normalizeSystemColorScheme,
  resolveThemeMode,
} from '../../src/utils/themeMode';

describe('theme mode resolution', () => {
  it.each(['light', 'dark', 'system'])('accepts the supported %s mode', (mode) => {
    expect(isThemeMode(mode)).toBe(true);
  });

  it.each([undefined, null, '', 'auto', 'LIGHT'])('rejects invalid persisted mode %p', (mode) => {
    expect(isThemeMode(mode)).toBe(false);
  });

  it('follows the device only while System is selected', () => {
    expect(resolveThemeMode('system', 'dark')).toBe('dark');
    expect(resolveThemeMode('system', 'light')).toBe('light');
    expect(resolveThemeMode('dark', 'light')).toBe('dark');
    expect(resolveThemeMode('light', 'dark')).toBe('light');
  });

  it('uses light as the safe fallback for unavailable system values', () => {
    expect(normalizeSystemColorScheme(null)).toBe('light');
    expect(resolveThemeMode('system', undefined)).toBe('light');
  });
});
