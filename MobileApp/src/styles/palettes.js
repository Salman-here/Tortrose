/**
 * Theme palettes for light and dark modes.
 *
 * Both palettes expose the same keys so any screen can swap them via useTheme().
 * Static (legacy) imports of `colors` and `glass` from theme.js still default
 * to the light palette — those screens are themable but not yet rethemed.
 */

// =============================================================================
// LIGHT PALETTE (matches existing theme.js defaults)
// =============================================================================
export const lightPalette = {
  mode: 'light',
  colors: {
    // Primary
    primary: '#6366f1',
    primaryDark: '#4f46e5',
    primaryLight: '#818cf8',
    primaryLighter: '#c7d2fe',
    primarySubtle: '#eef2ff',

    // Secondary
    secondary: '#8b5cf6',
    secondaryDark: '#7c3aed',
    secondaryLight: '#a78bfa',
    secondaryLighter: '#ddd6fe',
    secondarySubtle: '#f5f3ff',
    accent: '#a855f7',

    // Semantic
    success: '#10b981',
    successDark: '#059669',
    successLight: '#34d399',
    successLighter: '#d1fae5',
    successSubtle: '#ecfdf5',

    warning: '#f59e0b',
    warningDark: '#d97706',
    warningLight: '#fbbf24',
    warningLighter: '#fef3c7',
    warningSubtle: '#fffbeb',

    error: '#ef4444',
    errorDark: '#dc2626',
    errorLight: '#f87171',
    errorLighter: '#fee2e2',
    errorSubtle: '#fef2f2',

    info: '#3b82f6',
    infoDark: '#2563eb',
    infoLight: '#60a5fa',
    infoLighter: '#dbeafe',
    infoSubtle: '#eff6ff',

    // Neutrals
    dark: '#1f2937',
    darkLight: '#374151',
    gray: '#6b7280',
    grayLight: '#9ca3af',
    grayLighter: '#d1d5db',
    light: '#f3f4f6',
    lighter: '#f9fafb',
    white: '#ffffff',
    black: '#000000',

    // Surfaces
    background: '#f9fafb',
    backgroundDark: '#f3f4f6',
    surface: '#ffffff',
    surfaceHover: '#f9fafb',
    surfaceElevated: '#ffffff',

    // Text
    text: '#1f2937',
    textSecondary: '#6b7280',
    textLight: '#9ca3af',
    textInverse: '#ffffff',

    // Special
    star: '#fbbf24',
    heart: '#ef4444',
    verified: '#3b82f6',
    featured: '#8b5cf6',
    discount: '#ef4444',

    // Navbar
    navbarStart: '#374151',
    navbarMiddle: '#1f2937',
    navbarEnd: '#6b7280',

    // Overlays
    overlay: 'rgba(0,0,0,0.5)',
    overlayLight: 'rgba(0,0,0,0.3)',
    overlayDark: 'rgba(0,0,0,0.7)',

    // Shadows
    shadow: 'rgba(0,0,0,0.1)',
    shadowLight: 'rgba(0,0,0,0.05)',
    shadowDark: 'rgba(0,0,0,0.15)',

    // Borders
    border: 'rgba(0,0,0,0.08)',
    borderStrong: 'rgba(0,0,0,0.16)',

    // Status (orders)
    statusPending: '#f59e0b',
    statusProcessing: '#3b82f6',
    statusShipped: '#8b5cf6',
    statusDelivered: '#10b981',
    statusCancelled: '#ef4444',
  },
  gradients: {
    primary: ['#6366f1', '#8b5cf6'],
    // Website --logo-gradient — THE primary CTA gradient (teal → sky → indigo)
    cta: ['#14B8A6', '#0EA5E9', '#6366F1'],
    primaryDark: ['#4f46e5', '#7c3aed'],
    success: ['#10b981', '#34d399'],
    warning: ['#f59e0b', '#fbbf24'],
    error: ['#ef4444', '#f87171'],
    info: ['#3b82f6', '#60a5fa'],
    dark: ['#374151', '#1f2937'],
    background: ['#eef2ff', '#e0e7ff', '#dbeafe', '#ede9fe', '#e0e7ff'],
  },
  glass: {
    // Real blur renders on every platform now — one translucent set everywhere.
    background: 'rgba(255,255,255,0.45)',
    backgroundStrong: 'rgba(255,255,255,0.6)',
    backgroundInner: 'rgba(255,255,255,0.3)',
    border: 'rgba(255,255,255,0.5)',
    borderStrong: 'rgba(255,255,255,0.65)',
    borderSubtle: 'rgba(255,255,255,0.25)',
    innerGlow: 'rgba(255,255,255,0.2)',
    blur: 40,
    blurStrong: 60,
    bg: 'rgba(255,255,255,0.45)',
    bgSubtle: 'rgba(255,255,255,0.18)',
    bgStrong: 'rgba(255,255,255,0.6)',
  },
};

// =============================================================================
// DARK PALETTE — deep slate base, brand indigo intact, glass goes inky
// =============================================================================
export const darkPalette = {
  mode: 'dark',
  colors: {
    // Primary (slightly brighter for contrast on dark)
    primary: '#818cf8',
    primaryDark: '#6366f1',
    primaryLight: '#a5b4fc',
    primaryLighter: 'rgba(129,140,248,0.25)',
    primarySubtle: 'rgba(129,140,248,0.12)',

    // Secondary
    secondary: '#a78bfa',
    secondaryDark: '#8b5cf6',
    secondaryLight: '#c4b5fd',
    secondaryLighter: 'rgba(167,139,250,0.25)',
    secondarySubtle: 'rgba(167,139,250,0.12)',
    accent: '#c084fc',

    // Semantic
    success: '#34d399',
    successDark: '#10b981',
    successLight: '#6ee7b7',
    successLighter: 'rgba(52,211,153,0.25)',
    successSubtle: 'rgba(52,211,153,0.12)',

    warning: '#fbbf24',
    warningDark: '#f59e0b',
    warningLight: '#fcd34d',
    warningLighter: 'rgba(251,191,36,0.25)',
    warningSubtle: 'rgba(251,191,36,0.12)',

    error: '#f87171',
    errorDark: '#ef4444',
    errorLight: '#fca5a5',
    errorLighter: 'rgba(248,113,113,0.25)',
    errorSubtle: 'rgba(248,113,113,0.12)',

    info: '#60a5fa',
    infoDark: '#3b82f6',
    infoLight: '#93c5fd',
    infoLighter: 'rgba(96,165,250,0.25)',
    infoSubtle: 'rgba(96,165,250,0.12)',

    // Neutrals — inverted scale (for background-ish surfaces).
    // `white` and `black` remain literal colours so callers using them as
    // icon/text tints on coloured CTAs/gradients stay readable in both themes.
    dark: '#f9fafb',
    darkLight: '#e5e7eb',
    gray: '#9ca3af',
    grayLight: '#6b7280',
    grayLighter: '#374151',
    light: '#1f2937',
    lighter: '#111827',
    white: '#ffffff',
    black: '#000000',

    // Surfaces
    background: '#0b1020',
    backgroundDark: '#080c1a',
    surface: '#141a2e',
    surfaceHover: '#1a2138',
    surfaceElevated: '#1e2540',

    // Text
    text: '#f9fafb',
    textSecondary: '#cbd5e1',
    textLight: '#94a3b8',
    textInverse: '#0b1020',

    // Special
    star: '#fbbf24',
    heart: '#f87171',
    verified: '#60a5fa',
    featured: '#a78bfa',
    discount: '#f87171',

    // Navbar
    navbarStart: '#1e293b',
    navbarMiddle: '#0f172a',
    navbarEnd: '#1e293b',

    // Overlays
    overlay: 'rgba(0,0,0,0.7)',
    overlayLight: 'rgba(0,0,0,0.5)',
    overlayDark: 'rgba(0,0,0,0.85)',

    // Shadows
    shadow: 'rgba(0,0,0,0.4)',
    shadowLight: 'rgba(0,0,0,0.25)',
    shadowDark: 'rgba(0,0,0,0.55)',

    // Borders
    border: 'rgba(255,255,255,0.08)',
    borderStrong: 'rgba(255,255,255,0.18)',

    // Status (orders) — same hues, brand intact
    statusPending: '#fbbf24',
    statusProcessing: '#60a5fa',
    statusShipped: '#a78bfa',
    statusDelivered: '#34d399',
    statusCancelled: '#f87171',
  },
  gradients: {
    primary: ['#6366f1', '#8b5cf6'],
    // Website --logo-gradient — THE primary CTA gradient (teal → sky → indigo)
    cta: ['#14B8A6', '#0EA5E9', '#6366F1'],
    primaryDark: ['#4f46e5', '#7c3aed'],
    success: ['#10b981', '#34d399'],
    warning: ['#f59e0b', '#fbbf24'],
    error: ['#ef4444', '#f87171'],
    info: ['#3b82f6', '#60a5fa'],
    dark: ['#0b1020', '#141a2e'],
    // Inky aurora background for dark mode
    background: ['#0b1020', '#141a2e', '#1a1f3a', '#241a3a', '#141a2e'],
  },
  glass: {
    // Real blur renders on every platform now — one translucent set everywhere.
    background: 'rgba(20,26,46,0.55)',
    backgroundStrong: 'rgba(30,37,64,0.7)',
    backgroundInner: 'rgba(20,26,46,0.4)',
    border: 'rgba(255,255,255,0.12)',
    borderStrong: 'rgba(255,255,255,0.22)',
    borderSubtle: 'rgba(255,255,255,0.08)',
    innerGlow: 'rgba(129,140,248,0.12)',
    blur: 40,
    blurStrong: 60,
    bg: 'rgba(20,26,46,0.55)',
    bgSubtle: 'rgba(20,26,46,0.25)',
    bgStrong: 'rgba(30,37,64,0.7)',
  },
};

export const palettes = { light: lightPalette, dark: darkPalette };
