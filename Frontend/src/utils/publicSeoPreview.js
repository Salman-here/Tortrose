import { publicImageUrl } from './seoImage.js';

// Only use the server-rendered public record for this exact canonical page.
// This is a read-only preview, never an authority for stock, shipping or checkout.
export function readPublicSeoPreview(kind, canonical, source = globalThis.document) {
  if (!source || !canonical) return null;
  try {
    const expected = new URL(canonical).href;
    const actual = source.querySelector('link[rel="canonical"]')?.getAttribute('href');
    if (!actual || new URL(actual).href !== expected) return null;
    for (const script of source.querySelectorAll('head script[type="application/ld+json"]')) {
      let records;
      try { const value = JSON.parse(script.textContent); records = Array.isArray(value) ? value : value['@graph'] || [value]; } catch { continue; }
      for (const record of records) {
        if (!record || typeof record.name !== 'string' || !record.name.trim()) continue;
        const type = kind === 'product' ? 'Product' : 'Store';
        if (record['@type'] !== type) continue;
        const url = kind === 'product' ? record.offers?.url : record.url;
        if (!url || new URL(url).href !== expected) continue;
        const images = kind === 'store' ? [record.logo, record.image] : Array.isArray(record.image) ? record.image : [record.image];
        return {
          name: record.name, description: typeof record.description === 'string' ? record.description : '',
          image: images.map(publicImageUrl).find(Boolean) || '',
          ...(kind === 'product' && typeof record.offers?.price === 'number' && Number.isFinite(record.offers.price) && record.offers.price >= 0 && /^[A-Z]{3}$/.test(record.offers?.priceCurrency || '')
            ? { price: Number(record.offers.price), currency: record.offers.priceCurrency } : {}),
        };
      }
    }
  } catch { /* Missing/stale metadata must not become a different product's preview. */ }
  return null;
}
