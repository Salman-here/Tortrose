export const THEME_MODES = Object.freeze(['light', 'dark', 'system']);

export function isThemeMode(value) {
  return THEME_MODES.includes(value);
}
export function normalizeSystemColorScheme(colorScheme) {
  return colorScheme === 'dark' ? 'dark' : 'light';
}

export function resolveThemeMode(mode, systemColorScheme) {
  if (mode === 'dark') return 'dark';
  if (mode === 'system') return normalizeSystemColorScheme(systemColorScheme);
  return 'light';
}
