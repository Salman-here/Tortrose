// Window-based, not device-model-based: split-screen tablets can use the
// unchanged compact layout, while a wide tablet window gets the larger canvas.
export const TABLET_MIN_WIDTH = 600;
export const TABLET_CONTENT_MAX_WIDTH = 1120;

export function getResponsiveLayout(width, { left = 0, right = 0, fontScale = 1, maxWidth = TABLET_CONTENT_MAX_WIDTH } = {}) {
  const available = Math.max(0, Number.isFinite(width) ? width - Math.max(0, left) - Math.max(0, right) : 0);
  const isTablet = available >= TABLET_MIN_WIDTH;
  const contentWidth = isTablet ? Math.min(available, maxWidth) : available;
  // Preserve the exact two-column phone card geometry and existing 16px
  // gutters/8px gap. Tablets add columns, never giant stretched phone cards.
  const minimumCardWidth = 190 * Math.max(1, Number.isFinite(fontScale) ? fontScale : 1);
  const catalogColumns = isTablet ? Math.max(2, Math.min(5, Math.floor((contentWidth - 24) / minimumCardWidth))) : 2;
  const catalogCardWidth = Math.max(0, (contentWidth - 32 - 8 * (catalogColumns - 1)) / catalogColumns);
  return { isTablet, contentWidth, catalogColumns, catalogCardWidth, maxWidth };
}
