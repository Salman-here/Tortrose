export function getBottomTabTheme(palette, isDark) {
  if (isDark) {
    return {
      surfaceColor: 'rgba(8,12,26,0.96)',
      borderColor: 'rgba(148,163,184,0.24)',
      auroraColors: [
        'rgba(20,184,166,0.12)',
        'rgba(14,165,233,0.08)',
        'rgba(99,102,241,0.16)',
      ],
      prismColors: [
        'rgba(45,212,191,0.14)',
        'rgba(56,189,248,0.10)',
        'rgba(129,140,248,0.16)',
      ],
      finishColors: ['rgba(8,12,26,0.62)', 'rgba(15,23,42,0.78)'],
      blurTint: 'dark',
      inactiveIconColor: palette.colors.textSecondary,
      shadowColor: '#000000',
      shadowOpacity: 0.42,
    };
  }

  return {
    surfaceColor: 'rgba(248,250,255,0.94)',
    borderColor: palette.glass.border,
    auroraColors: [
      'rgba(153,246,228,0.46)',
      'rgba(186,230,253,0.30)',
      'rgba(199,210,254,0.48)',
    ],
    prismColors: [
      'rgba(45,212,191,0.52)',
      'rgba(56,189,248,0.44)',
      'rgba(129,140,248,0.50)',
    ],
    finishColors: ['rgba(255,255,255,0.30)', 'rgba(255,255,255,0.035)'],
    blurTint: 'default',
    inactiveIconColor: palette.colors.textLight,
    shadowColor: '#000000',
    shadowOpacity: 0.12,
  };
}
