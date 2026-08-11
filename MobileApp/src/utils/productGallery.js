export function normalizeProductGalleryImages(product) {
  const entries = Array.isArray(product?.images) && product.images.length
    ? product.images
    : [product?.image];
  const seen = new Set();

  const images = entries
    .map((entry) => (typeof entry === 'string' ? entry : entry?.url))
    .map((url) => (typeof url === 'string' ? url.trim() : ''))
    .filter((url) => /^(https?:|data:|file:)/i.test(url))
    .filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .map((url) => ({ url }));

  return images.length ? images : [{ url: null }];
}

export function clampGalleryIndex(index, imageCount) {
  const lastIndex = Math.max(0, Number(imageCount || 0) - 1);
  return Math.max(0, Math.min(lastIndex, Number.isFinite(index) ? Math.round(index) : 0));
}

export function galleryIndexFromOffset(offsetX, galleryWidth, imageCount) {
  if (!Number.isFinite(galleryWidth) || galleryWidth <= 0) return 0;
  return clampGalleryIndex(Number(offsetX || 0) / galleryWidth, imageCount);
}

export function gallerySwipeTarget({
  currentIndex,
  imageCount,
  translationX,
  velocityX = 0,
  galleryWidth,
}) {
  const safeIndex = clampGalleryIndex(currentIndex, imageCount);
  const distanceThreshold = Math.min(64, Math.max(36, Number(galleryWidth || 0) * 0.14));
  const velocityThreshold = 520;

  if (translationX <= -distanceThreshold || velocityX <= -velocityThreshold) {
    return clampGalleryIndex(safeIndex + 1, imageCount);
  }
  if (translationX >= distanceThreshold || velocityX >= velocityThreshold) {
    return clampGalleryIndex(safeIndex - 1, imageCount);
  }
  return safeIndex;
}
