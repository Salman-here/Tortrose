'use strict';

const mongoose = require('mongoose');
const Product = require('../models/Product');
const Store = require('../models/Store');
const { publicProductFilter } = require('../services/productModerationService');
const {
  activeStoreQuery,
  applyActiveSellerProductFilter,
  findActiveStore,
  getActiveSellerIds,
} = require('../services/publicCatalogService');
const {
  renderCatalogPage,
  renderMarketplacePage,
  renderProductPage,
  renderStorePage,
  renderUnavailablePage,
} = require('../services/seoPageService');
const { isProtectedStoreSlug, normalizeStoreSlug } = require('../utils/storeSlug');

const HTML_SECURITY_POLICY = [
  "default-src 'none'",
  "img-src https: data:",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const setSharedHeaders = res => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Content-Security-Policy', HTML_SECURITY_POLICY);
  res.set('Vary', 'User-Agent, Accept-Encoding');
};

const sendIndexableHtml = (res, html) => {
  setSharedHeaders(res);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('X-Robots-Tag', 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1');
  res.set('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600');
  return res.status(200).send(html);
};

const sendUnavailableHtml = (res, { canonical, kind }) => {
  setSharedHeaders(res);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  res.set('Cache-Control', 'no-store');
  return res.status(404).send(renderUnavailablePage({ canonical, kind }));
};

const sendTemporaryUnavailable = (res, message) => {
  setSharedHeaders(res);
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  res.set('Cache-Control', 'no-store');
  res.set('Retry-After', '60');
  return res.status(503).send(message);
};

const publicSeoStores = async ({ limit = 24 } = {}) => {
  const activeSellerIds = await getActiveSellerIds();
  if (!activeSellerIds.length) return [];
  const stores = await Store.find(activeStoreQuery({ seller: { $in: activeSellerIds } }))
    .select('_id seller storeName storeSlug description logo banner address updatedAt')
    .sort({ updatedAt: -1, _id: -1 })
    .limit(limit)
    .lean();
  return stores.filter(store => (
    store.storeName
    && store.storeSlug
    && !isProtectedStoreSlug(store.storeSlug)
  ));
};

const publicSeoProducts = async ({ stores, limit = 24 } = {}) => {
  const publicStores = stores || await publicSeoStores({ limit: 50000 });
  const sellerIds = publicStores.map(store => store.seller).filter(Boolean);
  const filter = applyActiveSellerProductFilter(
    publicProductFilter({
      stock: { $gt: 0 },
      name: { $type: 'string', $ne: '' },
    }),
    sellerIds,
  );
  return Product.find(filter)
    .select('_id seller name description brand category price discountedPrice currency priceCurrency stock image images rating numReviews updatedAt')
    .sort({ isFeatured: -1, updatedAt: -1, _id: -1 })
    .limit(limit)
    .lean();
};

exports.getStoreIndexStatus = async (req, res) => {
  const slug = normalizeStoreSlug(req.params.slug);
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  if (!slug || isProtectedStoreSlug(slug)) {
    return res.status(404).json({ indexable: false });
  }

  try {
    const store = await findActiveStore({ storeSlug: slug }, { select: '_id storeSlug seller' });
    if (!store) return res.status(404).json({ indexable: false });
    return res.status(200).json({ indexable: true });
  } catch (error) {
    console.error('SEO store-status error:', error.message);
    return res.status(503).json({ indexable: null });
  }
};

exports.renderHome = async (req, res) => {
  try {
    const stores = await publicSeoStores({ limit: 12 });
    const products = await publicSeoProducts({ limit: 24 });
    return sendIndexableHtml(res, renderCatalogPage({ products, stores }));
  } catch (error) {
    console.error('SEO home render error:', error.message);
    return sendTemporaryUnavailable(res, 'Marketplace temporarily unavailable');
  }
};

exports.renderProducts = async (req, res) => {
  try {
    const products = await publicSeoProducts({ limit: 36 });
    return sendIndexableHtml(res, renderCatalogPage({
      products,
      productsOnly: true,
      canonical: 'https://rozare.com/products',
    }));
  } catch (error) {
    console.error('SEO products render error:', error.message);
    return sendTemporaryUnavailable(res, 'Product catalog temporarily unavailable');
  }
};

exports.renderMarketplace = async (req, res) => {
  try {
    const stores = await publicSeoStores({ limit: 48 });
    return sendIndexableHtml(res, renderMarketplacePage({ stores }));
  } catch (error) {
    console.error('SEO marketplace render error:', error.message);
    return sendTemporaryUnavailable(res, 'Store directory temporarily unavailable');
  }
};

exports.renderStore = async (req, res) => {
  const slug = normalizeStoreSlug(req.params.slug);
  const canonical = slug ? `https://${slug}.rozare.com/` : 'https://rozare.com/marketplace';
  if (!slug || isProtectedStoreSlug(slug)) {
    return sendUnavailableHtml(res, { canonical, kind: 'store' });
  }

  try {
    const store = await findActiveStore({ storeSlug: slug }, {
      select: '_id seller storeName storeSlug description logo banner address updatedAt',
    });
    if (!store) return sendUnavailableHtml(res, { canonical, kind: 'store' });

    const products = await Product.find(publicProductFilter({
      seller: store.seller,
      stock: { $gt: 0 },
      name: { $type: 'string', $ne: '' },
    }))
      .select('_id seller name description brand category price discountedPrice currency priceCurrency stock image images updatedAt')
      .sort({ isFeatured: -1, updatedAt: -1, _id: -1 })
      .limit(36)
      .lean();
    return sendIndexableHtml(res, renderStorePage({ store, products }));
  } catch (error) {
    console.error('SEO store render error:', error.message);
    return sendTemporaryUnavailable(res, 'Store temporarily unavailable');
  }
};

exports.renderProduct = async (req, res) => {
  const id = String(req.params.id || '').trim();
  const canonical = `https://rozare.com/single-product/${encodeURIComponent(id)}`;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return sendUnavailableHtml(res, { canonical, kind: 'product' });
  }

  try {
    const product = await Product.findOne(publicProductFilter({ _id: id }))
      .select('_id seller name description brand category price discountedPrice currency priceCurrency stock image images rating numReviews updatedAt')
      .lean();
    if (!product?.name) return sendUnavailableHtml(res, { canonical, kind: 'product' });

    let store = null;
    if (product.seller) {
      store = await findActiveStore({ seller: product.seller }, {
        select: '_id seller storeName storeSlug description logo banner address',
      });
      if (!store || isProtectedStoreSlug(store.storeSlug)) {
        return sendUnavailableHtml(res, { canonical, kind: 'product' });
      }
    }

    const html = renderProductPage({ product, store });
    if (!html) return sendUnavailableHtml(res, { canonical, kind: 'product' });
    return sendIndexableHtml(res, html);
  } catch (error) {
    console.error('SEO product render error:', error.message);
    return sendTemporaryUnavailable(res, 'Product temporarily unavailable');
  }
};

exports._test = {
  publicSeoProducts,
  publicSeoStores,
  sendIndexableHtml,
  sendTemporaryUnavailable,
  sendUnavailableHtml,
};
