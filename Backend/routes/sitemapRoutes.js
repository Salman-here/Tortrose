const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const Store = require('../models/Store');
const { publicProductFilter } = require('../services/productModerationService');
const {
  activeStoreQuery,
  applyActiveSellerProductFilter,
  getActiveSellerIds,
} = require('../services/publicCatalogService');
const { isProtectedStoreSlug } = require('../utils/storeSlug');

// Search canonicals are intentionally independent from deployment/CORS env
// values. FRONTEND_URL was set to www in production and made every sitemap URL
// redirect before reaching its canonical apex URL.
const BASE_URL = 'https://rozare.com';

const escapeXml = (str = '') =>
  String(str).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[c]));

const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?>\n';

const lastmodElement = value => {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? `\n    <lastmod>${parsed.toISOString().slice(0, 10)}</lastmod>`
    : '';
};

const publicHttpUrl = value => {
  try {
    const parsed = new URL(String(value || ''));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch (_) {
    return '';
  }
};

// Dynamic products sitemap
router.get('/sitemap-products.xml', async (req, res) => {
  try {
    const activeSellerIds = await getActiveSellerIds();
    const activeStores = activeSellerIds.length
      ? await Store.find(activeStoreQuery({ seller: { $in: activeSellerIds } }))
        .select('seller storeSlug')
        .lean()
      : [];
    const publiclyIndexableSellerIds = activeStores
      .filter(store => store.storeSlug && !isProtectedStoreSlug(store.storeSlug))
      .map(store => store.seller);
    const products = await Product.find(applyActiveSellerProductFilter(
      publicProductFilter({
        stock: { $gt: 0 },
        name: { $type: 'string', $ne: '' },
      }),
      publiclyIndexableSellerIds,
    ))
      .select('_id updatedAt image name')
      .sort({ updatedAt: -1, _id: -1 })
      .lean()
      .limit(50000);

    const urls = products.map((p) => {
      const imageUrl = publicHttpUrl(p.image);
      return `  <url>
    <loc>${escapeXml(`${BASE_URL}/single-product/${p._id}`)}</loc>${lastmodElement(p.updatedAt)}
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>${imageUrl ? `
    <image:image>
      <image:loc>${escapeXml(imageUrl)}</image:loc>
      <image:title>${escapeXml(p.name || '')}</image:title>
    </image:image>` : ''}
  </url>`;
    }).join('\n');

    const xml = `${xmlHeader}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls}
</urlset>`;

    res.set('Content-Type', 'application/xml');
    res.set('Cache-Control', 'public, max-age=0, s-maxage=900, stale-while-revalidate=3600');
    res.set('X-Robots-Tag', 'noindex');
    res.send(xml);
  } catch (err) {
    console.error('sitemap-products error:', err.message);
    res.status(500).send('Error generating products sitemap');
  }
});

// Dynamic stores sitemap
router.get('/sitemap-stores.xml', async (req, res) => {
  try {
    const activeSellerIds = await getActiveSellerIds();
    const stores = activeSellerIds.length
      ? await Store.find(activeStoreQuery({ seller: { $in: activeSellerIds } }))
      .select('storeSlug updatedAt logo storeName')
      .sort({ updatedAt: -1, _id: -1 })
      .lean()
      .limit(50000)
      : [];

    const urls = stores.filter(s => (
      s.storeName && s.storeSlug && !isProtectedStoreSlug(s.storeSlug)
    )).map((s) => {
      const imageUrl = publicHttpUrl(s.logo);
      return `  <url>
    <loc>${escapeXml(`https://${s.storeSlug}.rozare.com/`)}</loc>${lastmodElement(s.updatedAt)}
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>${imageUrl ? `
    <image:image>
      <image:loc>${escapeXml(imageUrl)}</image:loc>
      <image:title>${escapeXml(s.storeName || '')}</image:title>
    </image:image>` : ''}
  </url>`;
    }).join('\n');

    const xml = `${xmlHeader}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls}
</urlset>`;

    res.set('Content-Type', 'application/xml');
    res.set('Cache-Control', 'public, max-age=0, s-maxage=900, stale-while-revalidate=3600');
    res.set('X-Robots-Tag', 'noindex');
    res.send(xml);
  } catch (err) {
    console.error('sitemap-stores error:', err.message);
    res.status(500).send('Error generating stores sitemap');
  }
});

module.exports = router;
