const LIGHT = Object.freeze({
  surface: '#F8FBFF', field: '#FFFFFF', inner: '#EDF3FB',
  text: '#1F2A44', muted: '#53617B', subtle: '#596981',
  border: 'rgba(123,145,180,0.36)', borderSubtle: 'rgba(123,145,180,0.22)',
  info: '#1D4ED8', success: '#047857', warning: '#92400E', error: '#B91C1C',
  glow: ['rgba(20,184,166,0.035)', 'rgba(99,102,241,0.035)'],
});
const DARK = Object.freeze({
  surface: '#182238', field: '#202D47', inner: '#24324D',
  text: '#F1F5FF', muted: '#BAC7DD', subtle: '#AABAD2',
  border: 'rgba(172,195,231,0.32)', borderSubtle: 'rgba(172,195,231,0.16)',
  info: '#93C5FD', success: '#6EE7B7', warning: '#FCD34D', error: '#FCA5A5',
  glow: ['rgba(129,140,248,0.025)', 'rgba(20,184,166,0.025)'],
});
export const getModalTokens = palette => palette?.mode === 'dark'
  || !palette?.mode && ['#0b1020', '#141a2e'].includes(String(palette?.colors?.background || palette?.background || palette?.surface || '').toLowerCase()) ? DARK : LIGHT;
const modalPalettes = new WeakMap();
export function getModalPalette(palette) {
  const tokens = getModalTokens(palette);
  if (palette?.modal === tokens) return palette;
  const cached = palette && typeof palette === 'object' ? modalPalettes.get(palette) : null;
  if (cached?.modal === tokens) return cached;
  const next = { ...palette, modal: tokens,
    colors: { ...palette?.colors, text: tokens.text, textSecondary: tokens.muted, textLight: tokens.subtle,
      gray: tokens.muted, grayLight: tokens.subtle,
      info: tokens.info, success: tokens.success, warning: tokens.warning, error: tokens.error },
    glass: { ...palette?.glass, bg: tokens.inner, background: tokens.inner,
      bgStrong: tokens.surface, backgroundStrong: tokens.surface,
      bgSubtle: palette?.mode === 'dark' ? 'rgba(141,163,201,0.10)' : 'rgba(115,132,168,0.08)',
      border: tokens.border, borderStrong: tokens.border, borderSubtle: tokens.borderSubtle },
  };
  if (palette && typeof palette === 'object') modalPalettes.set(palette, next);
  return next;
}
