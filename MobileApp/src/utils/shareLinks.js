import { getStorefrontUrl } from './storefrontUrl';

export function getProductShareUrl(productOrId) {
  const id = typeof productOrId === 'object' ? productOrId?._id || productOrId?.id : productOrId;
  return typeof id === 'string' && /^[a-f\d]{24}$/i.test(id)
    ? `https://rozare.com/single-product/${id.toLowerCase()}` : '';
}

export function productShareContent(product, priceLabel = '') {
  const url = getProductShareUrl(product);
  if (!url) return null;
  const title = String(product?.name || 'Product on Rozare').trim();
  return { title, message: [title, priceLabel, url].filter(Boolean).join('\n') };
}

export function storeShareContent(store) {
  const url = getStorefrontUrl(store?.storeSlug || store?.slug);
  if (!url) return null;
  const title = String(store?.storeName || store?.name || 'Store on Rozare').trim();
  return { title, message: `${title} on Rozare\n${url}/` };
}
