const SITE_URL = 'https://rozare.com';
export const DEFAULT_SHARE_IMAGE = `${SITE_URL}/og-image.png?v=4`;

export function publicImageUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim(), SITE_URL);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

export function productShareImage(product) {
  return [product?.image, ...(Array.isArray(product?.images) ? product.images.map(image => typeof image === 'string' ? image : image?.url) : [])]
    .map(publicImageUrl).find(Boolean) || DEFAULT_SHARE_IMAGE;
}

export function storeShareImage(store) {
  return [store?.logo, store?.banner].map(publicImageUrl).find(Boolean) || DEFAULT_SHARE_IMAGE;
}
