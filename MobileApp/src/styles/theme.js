// Comprehensive Theme System matching the website's design
// Design tokens for consistent styling across the app

// =============================================================================
// COLORS
// =============================================================================
export const colors = {
  // Primary palette (matching website indigo/purple)
  primary: '#6366f1',
  primaryDark: '#4f46e5',
  primaryLight: '#818cf8',
  primaryLighter: '#c7d2fe',
  primarySubtle: '#eef2ff',

  // Secondary/accent
  secondary: '#8b5cf6',
  secondaryDark: '#7c3aed',
  secondaryLight: '#a78bfa',
  secondaryLighter: '#ddd6fe',
  secondarySubtle: '#f5f3ff',
  accent: '#a855f7',

  // Semantic colors - Success
  success: '#10b981',
  successDark: '#059669',
  successLight: '#34d399',
  successLighter: '#d1fae5',
  successSubtle: '#ecfdf5',

  // Semantic colors - Warning
  warning: '#f59e0b',
  warningDark: '#d97706',
  warningLight: '#fbbf24',
  warningLighter: '#fef3c7',
  warningSubtle: '#fffbeb',

  // Semantic colors - Error
  error: '#ef4444',
  errorDark: '#dc2626',
  errorLight: '#f87171',
  errorLighter: '#fee2e2',
  errorSubtle: '#fef2f2',

  // Semantic colors - Info
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

  // Background
  background: '#f9fafb',
  backgroundDark: '#f3f4f6',
  surface: '#ffffff',
  surfaceHover: '#f9fafb',

  // Text
  text: '#1f2937',
  textSecondary: '#6b7280',
  textLight: '#9ca3af',
  textInverse: '#ffffff',

  // Special purpose
  star: '#fbbf24',
  heart: '#ef4444',
  verified: '#3b82f6',
  featured: '#8b5cf6',
  discount: '#ef4444',

  // Navbar gradient colors (matching website)
  navbarStart: '#374151',
  navbarMiddle: '#1f2937',
  navbarEnd: '#6b7280',

  // Overlay/backdrop
  overlay: 'rgba(0, 0, 0, 0.5)',
  overlayLight: 'rgba(0, 0, 0, 0.3)',
  overlayDark: 'rgba(0, 0, 0, 0.7)',

  // Card shadows
  shadow: 'rgba(0, 0, 0, 0.1)',
  shadowLight: 'rgba(0, 0, 0, 0.05)',
  shadowDark: 'rgba(0, 0, 0, 0.15)',

  // Gradients (for LinearGradient components)
  gradientPrimary: ['#6366f1', '#8b5cf6'],
  gradientPrimaryDark: ['#4f46e5', '#7c3aed'],
  gradientSuccess: ['#10b981', '#34d399'],
  gradientWarning: ['#f59e0b', '#fbbf24'],
  gradientError: ['#ef4444', '#f87171'],
  gradientInfo: ['#3b82f6', '#60a5fa'],
  gradientDark: ['#374151', '#1f2937'],

  // Status colors for orders
  statusPending: '#f59e0b',
  statusProcessing: '#3b82f6',
  statusShipped: '#8b5cf6',
  statusDelivered: '#10b981',
  statusCancelled: '#ef4444',
};

// =============================================================================
// SPACING
// =============================================================================
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  xxxxl: 40,
  xxxxxl: 48,
};

// =============================================================================
// TYPOGRAPHY - Font Sizes
// =============================================================================
export const fontSize = {
  xs: 10,
  sm: 12,
  md: 14,
  lg: 16,
  xl: 18,
  xxl: 20,
  xxxl: 24,
  title: 28,
  hero: 32,
  display: 36,
};

// =============================================================================
// TYPOGRAPHY - Font Weights
// =============================================================================
export const fontWeight = {
  normal: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  extrabold: '800',
};

// =============================================================================
// TYPOGRAPHY - Line Heights
// =============================================================================
export const lineHeight = {
  tight: 1.2,
  normal: 1.5,
  relaxed: 1.75,
};

// =============================================================================
// BORDER RADIUS
// =============================================================================
export const borderRadius = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 20,
  xxxl: 24,
  full: 9999,
};

// =============================================================================
// SHADOWS
// =============================================================================
export const shadows = {
  none: {
    shadowColor: 'transparent',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 5,
  },
  xl: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
    elevation: 8,
  },
  xxl: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.25,
    shadowRadius: 24,
    elevation: 12,
  },
  // Colored shadows
  primarySm: {
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 3,
  },
  primaryMd: {
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 5,
  },
};

// =============================================================================
// ANIMATION DURATIONS
// =============================================================================
export const animation = {
  fast: 150,
  normal: 300,
  slow: 500,
  verySlow: 800,
};

// =============================================================================
// Z-INDEX SCALE
// =============================================================================
export const zIndex = {
  base: 0,
  dropdown: 10,
  sticky: 20,
  fixed: 30,
  modalBackdrop: 40,
  modal: 50,
  popover: 60,
  tooltip: 70,
  toast: 80,
};

// =============================================================================
// BUTTON STYLES
// =============================================================================
export const buttonStyles = {
  // Primary button
  primary: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: borderRadius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.primarySm,
  },
  primaryText: {
    color: colors.white,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  primaryDisabled: {
    backgroundColor: colors.primaryLight,
    opacity: 0.6,
  },

  // Secondary button
  secondary: {
    backgroundColor: colors.light,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: borderRadius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: {
    color: colors.dark,
    fontSize: fontSize.md,
    fontWeight: fontWeight.medium,
  },

  // Outline button
  outline: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: colors.primary,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: borderRadius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  outlineText: {
    color: colors.primary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.medium,
  },

  // Ghost button
  ghost: {
    backgroundColor: 'transparent',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: borderRadius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghostText: {
    color: colors.primary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.medium,
  },

  // Danger button
  danger: {
    backgroundColor: colors.error,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: borderRadius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerText: {
    color: colors.white,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },

  // Success button
  success: {
    backgroundColor: colors.success,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: borderRadius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  successText: {
    color: colors.white,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },

  // Small button variant
  small: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.md,
  },
  smallText: {
    fontSize: fontSize.sm,
  },

  // Large button variant
  large: {
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xxl,
    borderRadius: borderRadius.xl,
  },
  largeText: {
    fontSize: fontSize.lg,
  },

  // Icon button
  icon: {
    width: 44,
    height: 44,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.light,
  },
  iconSmall: {
    width: 36,
    height: 36,
  },
  iconLarge: {
    width: 52,
    height: 52,
  },
};

// =============================================================================
// CARD STYLES
// =============================================================================
export const cardStyles = {
  // Base card
  container: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    ...shadows.md,
    borderWidth: 1,
    borderColor: colors.light,
  },

  // Elevated card
  elevated: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    ...shadows.lg,
  },

  // Flat card (no shadow)
  flat: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.light,
  },

  // Interactive card (for touchables)
  interactive: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    ...shadows.md,
    borderWidth: 1,
    borderColor: colors.light,
  },

  // Compact card
  compact: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    ...shadows.sm,
    borderWidth: 1,
    borderColor: colors.light,
  },

  // Stat card (for dashboards)
  stat: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    ...shadows.md,
    minWidth: 150,
  },

  // Action card (for dashboard actions)
  action: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    ...shadows.sm,
    borderLeftWidth: 4,
    flexDirection: 'row',
    alignItems: 'center',
  },
};

// =============================================================================
// INPUT STYLES
// =============================================================================
export const inputStyles = {
  // Base input container
  container: {
    backgroundColor: colors.lighter,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderWidth: 1.5,
    borderColor: colors.light,
    flexDirection: 'row',
    alignItems: 'center',
  },

  // Focused state
  focused: {
    borderColor: colors.primary,
    backgroundColor: colors.white,
  },

  // Error state
  error: {
    borderColor: colors.error,
    backgroundColor: colors.errorSubtle,
  },

  // Success state
  success: {
    borderColor: colors.success,
    backgroundColor: colors.successSubtle,
  },

  // Input text
  text: {
    fontSize: fontSize.md,
    color: colors.text,
    flex: 1,
  },

  // Placeholder
  placeholder: {
    color: colors.grayLight,
  },

  // Label
  label: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: colors.text,
    marginBottom: spacing.sm,
  },

  // Helper text
  helper: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },

  // Error text
  errorText: {
    fontSize: fontSize.sm,
    color: colors.error,
    marginTop: spacing.xs,
  },

  // Icon
  icon: {
    marginRight: spacing.sm,
  },

  // Multiline/textarea
  multiline: {
    minHeight: 100,
    textAlignVertical: 'top',
    paddingTop: spacing.md,
  },
};

// =============================================================================
// BADGE STYLES
// =============================================================================
export const badgeStyles = {
  // Base badge
  base: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
    alignSelf: 'flex-start',
  },
  baseText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },

  // Primary badge
  primary: {
    backgroundColor: colors.primaryLighter,
  },
  primaryText: {
    color: colors.primaryDark,
  },

  // Success badge
  success: {
    backgroundColor: colors.successLighter,
  },
  successText: {
    color: colors.successDark,
  },

  // Warning badge
  warning: {
    backgroundColor: colors.warningLighter,
  },
  warningText: {
    color: colors.warningDark,
  },

  // Error badge
  error: {
    backgroundColor: colors.errorLighter,
  },
  errorText: {
    color: colors.errorDark,
  },

  // Info badge
  info: {
    backgroundColor: colors.infoLighter,
  },
  infoText: {
    color: colors.infoDark,
  },

  // Neutral badge
  neutral: {
    backgroundColor: colors.light,
  },
  neutralText: {
    color: colors.gray,
  },

  // Solid variants
  primarySolid: {
    backgroundColor: colors.primary,
  },
  primarySolidText: {
    color: colors.white,
  },
  successSolid: {
    backgroundColor: colors.success,
  },
  successSolidText: {
    color: colors.white,
  },
  errorSolid: {
    backgroundColor: colors.error,
  },
  errorSolidText: {
    color: colors.white,
  },
};

// =============================================================================
// STATUS BADGE COLORS (for orders)
// =============================================================================
export const statusColors = {
  pending: {
    bg: colors.warningLighter,
    text: colors.warningDark,
    solid: colors.warning,
  },
  processing: {
    bg: colors.infoLighter,
    text: colors.infoDark,
    solid: colors.info,
  },
  shipped: {
    bg: colors.primaryLighter,
    text: colors.primaryDark,
    solid: colors.secondary,
  },
  delivered: {
    bg: colors.successLighter,
    text: colors.successDark,
    solid: colors.success,
  },
  cancelled: {
    bg: colors.errorLighter,
    text: colors.errorDark,
    solid: colors.error,
  },
};

// =============================================================================
// LAYOUT HELPERS
// =============================================================================
export const layout = {
  // Flex helpers
  row: {
    flexDirection: 'row',
  },
  rowCenter: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowAround: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  column: {
    flexDirection: 'column',
  },
  columnCenter: {
    flexDirection: 'column',
    alignItems: 'center',
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  flex1: {
    flex: 1,
  },

  // Screen container
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  screenPadded: {
    flex: 1,
    backgroundColor: colors.background,
    padding: spacing.lg,
  },

  // Section
  section: {
    marginBottom: spacing.xxl,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },

  // Divider
  divider: {
    height: 1,
    backgroundColor: colors.light,
    marginVertical: spacing.md,
  },
  dividerThick: {
    height: 8,
    backgroundColor: colors.light,
  },
};

// =============================================================================
// TYPOGRAPHY PRESETS
// =============================================================================
export const typography = {
  // Headings
  hero: {
    fontSize: fontSize.hero,
    fontWeight: fontWeight.bold,
    color: colors.text,
    lineHeight: fontSize.hero * lineHeight.tight,
  },
  title: {
    fontSize: fontSize.title,
    fontWeight: fontWeight.bold,
    color: colors.text,
    lineHeight: fontSize.title * lineHeight.tight,
  },
  h1: {
    fontSize: fontSize.xxxl,
    fontWeight: fontWeight.bold,
    color: colors.text,
    lineHeight: fontSize.xxxl * lineHeight.tight,
  },
  h2: {
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.semibold,
    color: colors.text,
    lineHeight: fontSize.xxl * lineHeight.tight,
  },
  h3: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.semibold,
    color: colors.text,
    lineHeight: fontSize.xl * lineHeight.normal,
  },
  h4: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    color: colors.text,
    lineHeight: fontSize.lg * lineHeight.normal,
  },

  // Body text
  body: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.normal,
    color: colors.text,
    lineHeight: fontSize.md * lineHeight.normal,
  },
  bodyMedium: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.medium,
    color: colors.text,
    lineHeight: fontSize.md * lineHeight.normal,
  },
  bodySemibold: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    color: colors.text,
    lineHeight: fontSize.md * lineHeight.normal,
  },
  bodySmall: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.normal,
    color: colors.textSecondary,
    lineHeight: fontSize.sm * lineHeight.normal,
  },

  // Caption/small text
  caption: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.normal,
    color: colors.textLight,
    lineHeight: fontSize.xs * lineHeight.normal,
  },
  captionMedium: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
    color: colors.textSecondary,
    lineHeight: fontSize.xs * lineHeight.normal,
  },

  // Labels
  label: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: colors.text,
    lineHeight: fontSize.sm * lineHeight.normal,
  },
  labelSmall: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  // Links
  link: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.medium,
    color: colors.primary,
  },
  linkSmall: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: colors.primary,
  },

  // Price
  price: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  priceLarge: {
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  priceOriginal: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.normal,
    color: colors.textLight,
    textDecorationLine: 'line-through',
  },
  priceDiscount: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.error,
  },
};

// =============================================================================
// LOADER RING COLORS (matching website)
// =============================================================================
export const loaderColors = {
  ringA: '#f42f25', // Red
  ringB: '#ffdd00', // Yellow
  ringC: '#255ff4', // Blue
  ringD: '#2cf425', // Green
};

// =============================================================================
// DEFAULT EXPORT
// =============================================================================
export default {
  colors,
  spacing,
  fontSize,
  fontWeight,
  lineHeight,
  borderRadius,
  shadows,
  animation,
  zIndex,
  buttonStyles,
  cardStyles,
  inputStyles,
  badgeStyles,
  statusColors,
  layout,
  typography,
  loaderColors,
};
