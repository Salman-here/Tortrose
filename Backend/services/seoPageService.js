'use strict';

const SITE_URL = 'https://rozare.com';
const SITE_NAME = 'Rozare';
const DEFAULT_IMAGE = `${SITE_URL}/og-image.png?v=4`;
const INDEX_ROBOTS = 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1';
const NOINDEX_ROBOTS = 'noindex, nofollow, noarchive, nosnippet';

const htmlEscape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[character]));

const jsonForHtml = value => JSON.stringify(value)
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

const cleanText = (value, fallback = '') => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || fallback;
};

const excerpt = (value, fallback, maxLength = 158) => {
  const text = cleanText(value, fallback);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
};

const absoluteImageUrl = value => {
  const candidate = cleanText(value);
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate, SITE_URL);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch (_) {
    return '';
  }
};

const productImages = product => [...new Set([
  absoluteImageUrl(product?.image),
  ...(Array.isArray(product?.images) ? product.images.map(image => absoluteImageUrl(image?.url)) : []),
].filter(Boolean))];

const formatMoney = (amount, currency) => {
  const numeric = Number(amount);
  const normalizedCurrency = cleanText(currency, 'USD').toUpperCase();
  if (!Number.isFinite(numeric)) return '';
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: normalizedCurrency,
      maximumFractionDigits: 2,
    }).format(numeric);
  } catch (_) {
    return `${numeric.toFixed(2)} ${normalizedCurrency}`;
  }
};

const breadcrumbSchema = entries => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: entries.map((entry, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    name: cleanText(entry.name, index === 0 ? 'Home' : 'Page'),
    item: entry.url,
  })),
});

const renderDocument = ({
  title,
  description,
  canonical,
  heading,
  lead,
  image = DEFAULT_IMAGE,
  ogType = 'website',
  robots = INDEX_ROBOTS,
  jsonLd = [],
  content = '',
}) => {
  const safeTitle = cleanText(title, SITE_NAME);
  const safeDescription = excerpt(description, 'Shop products from independent sellers and brands on Rozare.');
  const safeCanonical = cleanText(canonical, SITE_URL);
  const safeImage = absoluteImageUrl(image) || DEFAULT_IMAGE;
  const schemas = (Array.isArray(jsonLd) ? jsonLd : [jsonLd]).filter(Boolean);
  const schemaMarkup = schemas.map(schema => (
    `<script type="application/ld+json">${jsonForHtml(schema)}</script>`
  )).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${htmlEscape(safeTitle)}</title>
  <meta name="description" content="${htmlEscape(safeDescription)}">
  <meta name="robots" content="${htmlEscape(robots)}">
  <meta name="googlebot" content="${htmlEscape(robots)}">
  <link rel="canonical" href="${htmlEscape(safeCanonical)}">
  <meta property="og:site_name" content="${SITE_NAME}">
  <meta property="og:type" content="${htmlEscape(ogType)}">
  <meta property="og:title" content="${htmlEscape(safeTitle)}">
  <meta property="og:description" content="${htmlEscape(safeDescription)}">
  <meta property="og:url" content="${htmlEscape(safeCanonical)}">
  <meta property="og:image" content="${htmlEscape(safeImage)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${htmlEscape(safeTitle)}">
  <meta name="twitter:description" content="${htmlEscape(safeDescription)}">
  <meta name="twitter:image" content="${htmlEscape(safeImage)}">
  ${schemaMarkup}
  <style>
    :root{color-scheme:light dark;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    *{box-sizing:border-box}body{margin:0;background:#f5f7fb;color:#182033;line-height:1.55}
    header,main,footer{width:min(1120px,calc(100% - 32px));margin:auto}header{display:flex;align-items:center;justify-content:space-between;padding:22px 0;border-bottom:1px solid #dbe2ee}
    nav{display:flex;flex-wrap:wrap;gap:16px}a{color:#3157b7;text-decoration:none}a:hover{text-decoration:underline}
    main{padding:56px 0 72px}h1{font-size:clamp(2rem,6vw,4rem);line-height:1.08;margin:0 0 16px}h2{margin-top:38px}.lead{font-size:1.12rem;max-width:760px;color:#526078}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px;margin-top:28px}.card{display:block;padding:20px;border:1px solid #dbe2ee;border-radius:18px;background:#fff;color:inherit}.card img{width:100%;aspect-ratio:4/3;object-fit:contain;border-radius:12px;background:#f3f5f8}.card strong{display:block;margin-top:12px}.muted{color:#66748b}.price{font-weight:750;margin-top:8px}.breadcrumbs{margin-bottom:24px;font-size:.92rem}.breadcrumbs span{margin:0 8px;color:#8792a6}footer{padding:26px 0;border-top:1px solid #dbe2ee;color:#66748b}@media(prefers-color-scheme:dark){body{background:#111827;color:#eef2ff}.card{background:#182235;border-color:#32415a}.lead,.muted,footer{color:#a9b5ca}header,footer{border-color:#32415a}.card img{background:#101827}}
  </style>
</head>
<body>
  <header><a href="${SITE_URL}/" aria-label="Rozare home"><strong>Rozare</strong></a><nav><a href="${SITE_URL}/products">Products</a><a href="${SITE_URL}/marketplace">Stores</a><a href="${SITE_URL}/become-seller">Sell on Rozare</a><a href="https://docs.rozare.com/">Help</a></nav></header>
  <main>
    <h1>${htmlEscape(cleanText(heading, safeTitle))}</h1>
    <p class="lead">${htmlEscape(cleanText(lead, safeDescription))}</p>
    ${content}
  </main>
  <footer>© ${new Date().getUTCFullYear()} Rozare. Shop from independent sellers and brands.</footer>
</body>
</html>`;
};

const productCard = product => {
  const name = cleanText(product?.name, 'Product');
  const url = `${SITE_URL}/single-product/${encodeURIComponent(String(product?._id || ''))}`;
  const image = productImages(product)[0];
  const price = Number(product?.discountedPrice) > 0 && Number(product.discountedPrice) < Number(product?.price)
    ? Number(product.discountedPrice)
    : Number(product?.price);
  return `<a class="card" href="${htmlEscape(url)}">${image ? `<img src="${htmlEscape(image)}" alt="${htmlEscape(name)}" loading="lazy">` : ''}<strong>${htmlEscape(name)}</strong><span class="muted">${htmlEscape(cleanText(product?.brand, product?.category || 'Marketplace product'))}</span><div class="price">${htmlEscape(formatMoney(price, product?.currency || product?.priceCurrency))}</div></a>`;
};

const storeCard = store => {
  const name = cleanText(store?.storeName, 'Rozare store');
  const url = `https://${encodeURIComponent(cleanText(store?.storeSlug))}.rozare.com/`;
  const image = absoluteImageUrl(store?.logo);
  return `<a class="card" href="${htmlEscape(url)}">${image ? `<img src="${htmlEscape(image)}" alt="${htmlEscape(`${name} logo`)}" loading="lazy">` : ''}<strong>${htmlEscape(name)}</strong><span class="muted">${htmlEscape(excerpt(store?.description, 'Independent seller on Rozare.', 110))}</span></a>`;
};

const renderCatalogPage = ({ products = [], stores = [], canonical = SITE_URL, productsOnly = false }) => {
  const title = productsOnly
    ? 'Browse Products Online | Rozare Marketplace'
    : 'Rozare | AI Shopping Marketplace for Buyers and Sellers';
  const description = productsOnly
    ? 'Browse products from active independent sellers and brands on Rozare, with product options, seller shipping, reviews, and secure checkout.'
    : 'Discover products from active independent sellers and brands on Rozare, or build a store with seller dashboards, AI tools, and WhatsApp workflows.';
  const items = products.map((product, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    name: cleanText(product.name, 'Product'),
    url: `${SITE_URL}/single-product/${product._id}`,
  }));
  const schemas = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: SITE_NAME,
      alternateName: 'Rozare Marketplace',
      url: SITE_URL,
      potentialAction: {
        '@type': 'SearchAction',
        target: { '@type': 'EntryPoint', urlTemplate: `${SITE_URL}/?search={search_term_string}` },
        'query-input': 'required name=search_term_string',
      },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: productsOnly ? 'Rozare Products' : 'Rozare Marketplace',
      description,
      url: canonical,
      ...(items.length ? { mainEntity: { '@type': 'ItemList', itemListElement: items } } : {}),
    },
    breadcrumbSchema(productsOnly
      ? [{ name: 'Home', url: `${SITE_URL}/` }, { name: 'Products', url: canonical }]
      : [{ name: 'Home', url: `${SITE_URL}/` }]),
  ];
  const productMarkup = products.length
    ? `<h2>${productsOnly ? 'Available products' : 'Products to discover'}</h2><div class="grid">${products.map(productCard).join('')}</div>`
    : '<h2>Explore Rozare</h2><p>Browse the marketplace for products from currently active sellers.</p>';
  const storeMarkup = !productsOnly && stores.length
    ? `<h2>Active stores</h2><div class="grid">${stores.map(storeCard).join('')}</div>`
    : '';
  return renderDocument({
    title,
    description,
    canonical,
    heading: productsOnly ? 'Browse products on Rozare' : 'Shop independent stores on Rozare',
    lead: description,
    jsonLd: schemas,
    content: `${productMarkup}${storeMarkup}`,
  });
};

const renderMarketplacePage = ({ stores = [] }) => {
  const canonical = `${SITE_URL}/marketplace`;
  const description = 'Browse active independent stores and brands on Rozare. Compare seller profiles, products, reviews, trust signals, and shipping options.';
  const items = stores.map((store, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    name: cleanText(store.storeName, 'Rozare store'),
    url: `https://${store.storeSlug}.rozare.com/`,
  }));
  return renderDocument({
    title: 'Stores and Brands | Rozare Marketplace',
    description,
    canonical,
    heading: 'Stores and brands on Rozare',
    lead: description,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: 'Rozare stores and brands',
        description,
        url: canonical,
        ...(items.length ? { mainEntity: { '@type': 'ItemList', itemListElement: items } } : {}),
      },
      breadcrumbSchema([{ name: 'Home', url: `${SITE_URL}/` }, { name: 'Stores', url: canonical }]),
    ],
    content: stores.length
      ? `<div class="grid">${stores.map(storeCard).join('')}</div>`
      : '<p>No public stores are available right now.</p>',
  });
};

const renderStorePage = ({ store, products = [] }) => {
  const name = cleanText(store?.storeName, 'Rozare store');
  const slug = cleanText(store?.storeSlug);
  const canonical = `https://${slug}.rozare.com/`;
  const description = excerpt(
    store?.description,
    `Shop products from ${name} on Rozare. Review products, seller information, and shipping options before checkout.`,
  );
  const address = store?.address || {};
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Store',
    name,
    description,
    url: canonical,
    ...(absoluteImageUrl(store?.logo) ? { logo: absoluteImageUrl(store.logo) } : {}),
    ...(absoluteImageUrl(store?.banner || store?.logo) ? { image: absoluteImageUrl(store.banner || store.logo) } : {}),
    ...(cleanText(address.country) ? {
      address: {
        '@type': 'PostalAddress',
        ...(cleanText(address.street) ? { streetAddress: cleanText(address.street) } : {}),
        ...(cleanText(address.city) ? { addressLocality: cleanText(address.city) } : {}),
        ...(cleanText(address.state) ? { addressRegion: cleanText(address.state) } : {}),
        ...(cleanText(address.postalCode) ? { postalCode: cleanText(address.postalCode) } : {}),
        addressCountry: cleanText(address.countryCode || address.country),
      },
    } : {}),
  };
  return renderDocument({
    title: `${name} | Rozare Store`,
    description,
    canonical,
    heading: name,
    lead: description,
    image: store?.logo || store?.banner,
    jsonLd: [
      schema,
      breadcrumbSchema([{ name: 'Home', url: `${SITE_URL}/` }, { name, url: canonical }]),
    ],
    content: products.length
      ? `<h2>Products from ${htmlEscape(name)}</h2><div class="grid">${products.map(productCard).join('')}</div>`
      : '<h2>Store catalog</h2><p>This active store has no in-stock public products at the moment.</p>',
  });
};

const renderProductPage = ({ product, store }) => {
  const name = cleanText(product?.name);
  if (!name) return null;
  const canonical = `${SITE_URL}/single-product/${encodeURIComponent(String(product._id))}`;
  const sellerName = cleanText(store?.storeName, 'Rozare Marketplace');
  const description = excerpt(
    product?.description,
    `Buy ${name} from ${sellerName} on Rozare. Review price, availability, seller details, and shipping options before checkout.`,
  );
  const price = Number(product?.discountedPrice) > 0 && Number(product.discountedPrice) < Number(product?.price)
    ? Number(product.discountedPrice)
    : Number(product?.price);
  const currency = cleanText(product?.currency || product?.priceCurrency, 'USD').toUpperCase();
  const images = productImages(product);
  const reviewCount = Number(product?.numReviews);
  const ratingValue = Number(product?.rating);
  const productSchema = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name,
    description,
    sku: String(product._id),
    ...(images.length ? { image: images } : {}),
    ...(cleanText(product?.brand) ? { brand: { '@type': 'Brand', name: cleanText(product.brand) } } : {}),
    offers: {
      '@type': 'Offer',
      url: canonical,
      price,
      priceCurrency: currency,
      availability: Number(product?.stock) > 0
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
      seller: { '@type': 'Organization', name: sellerName },
    },
    ...(ratingValue > 0 && reviewCount > 0 ? {
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue,
        reviewCount,
        bestRating: 5,
        worstRating: 1,
      },
    } : {}),
  };
  const sellerUrl = store?.storeSlug ? `https://${store.storeSlug}.rozare.com/` : `${SITE_URL}/marketplace`;
  const visibleImage = images[0]
    ? `<img src="${htmlEscape(images[0])}" alt="${htmlEscape(name)}" style="width:min(520px,100%);max-height:520px;object-fit:contain;border-radius:20px;background:#fff;padding:18px">`
    : '';
  return renderDocument({
    title: `${name} | Buy on Rozare`,
    description,
    canonical,
    heading: name,
    lead: description,
    image: images[0],
    ogType: 'product',
    jsonLd: [
      productSchema,
      breadcrumbSchema([
        { name: 'Home', url: `${SITE_URL}/` },
        { name: cleanText(product?.category, 'Products'), url: `${SITE_URL}/products` },
        { name, url: canonical },
      ]),
    ],
    content: `<div class="grid"><section>${visibleImage}</section><section><h2>Product details</h2><p class="price">${htmlEscape(formatMoney(price, currency))}</p><p>${htmlEscape(description)}</p><p><strong>Availability:</strong> ${Number(product?.stock) > 0 ? 'In stock' : 'Out of stock'}</p><p><strong>Sold by:</strong> <a href="${htmlEscape(sellerUrl)}">${htmlEscape(sellerName)}</a></p></section></div>`,
  });
};

const renderUnavailablePage = ({ canonical = SITE_URL, kind = 'page' } = {}) => renderDocument({
  title: `${kind === 'store' ? 'Store' : kind === 'product' ? 'Product' : 'Page'} unavailable | Rozare`,
  description: `This ${kind} is not available on Rozare.`,
  canonical,
  heading: `${kind === 'store' ? 'Store' : kind === 'product' ? 'Product' : 'Page'} unavailable`,
  lead: `This ${kind} does not exist or is no longer publicly available.`,
  robots: NOINDEX_ROBOTS,
  content: `<p><a href="${SITE_URL}/">Return to Rozare</a> or <a href="${SITE_URL}/marketplace">browse active stores</a>.</p>`,
});

module.exports = {
  INDEX_ROBOTS,
  NOINDEX_ROBOTS,
  SITE_URL,
  cleanText,
  renderCatalogPage,
  renderMarketplacePage,
  renderProductPage,
  renderStorePage,
  renderUnavailablePage,
};
