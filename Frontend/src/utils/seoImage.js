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

// Match the public server renderer's preview-only rule. Original product
// photos, store logos, and structured-data images retain their source URL.
export function socialPreviewImage(value) {
  const image = publicImageUrl(value);
  if (!image) return { url: '' };
  const url = new URL(image);
  const asset = url.pathname.match(/^\/([a-z\d_-]+)\/image\/upload\/(v\d+\/.+\.(?:avif|gif|jpe?g|png|webp|bmp|tiff?|svg))$/i);
  if (url.protocol !== 'https:' || url.hostname !== 'res.cloudinary.com' || url.port || url.search || !asset) return { url: image };
  url.pathname = `/${asset[1]}/image/upload/c_pad,w_1200,h_630,b_white/f_jpg/q_auto:good/${asset[2].replace(/\.[^./]+$/, '.jpg')}`;
  return { url: url.href, mimeType: 'image/jpeg', width: 1200, height: 630 };
}

export function productShareImage(product) {
  return [product?.image, ...(Array.isArray(product?.images) ? product.images.map(image => typeof image === 'string' ? image : image?.url) : [])]
    .map(publicImageUrl).find(Boolean) || false;
}

export function storeShareImage(store) {
  return publicImageUrl(store?.logo) || false;
}
