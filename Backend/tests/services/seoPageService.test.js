'use strict';

const {
  renderCatalogPage,
  renderProductPage,
  renderStorePage,
  renderUnavailablePage,
} = require('../../services/seoPageService');

const store = {
  _id: 'store-1',
  seller: 'seller-1',
  storeName: 'Nova & Nest',
  storeSlug: 'nova-nest',
  description: 'Useful home products.',
  logo: 'https://images.example.com/nova.png',
  address: { city: 'Karachi', country: 'Pakistan', countryCode: 'PK' },
};

const product = {
  _id: '64b000000000000000000001',
  seller: 'seller-1',
  name: 'Steel <Bottle>',
  description: 'An insulated bottle for daily use.',
  brand: 'Nova',
  category: 'Home',
  price: 1990,
  discountedPrice: 0,
  currency: 'PKR',
  stock: 5,
  image: 'https://images.example.com/bottle.png',
  images: [{ url: 'https://images.example.com/bottle-side.png' }],
  rating: 5,
  numReviews: 1,
};

test('product SEO contains complete Product and Breadcrumb names with escaped visible content', () => {
  const html = renderProductPage({ product, store });
  expect(html).toContain('<meta name="robots" content="index, follow');
  expect(html).toContain('<link rel="canonical" href="https://rozare.com/single-product/64b000000000000000000001">');
  expect(html).toContain('&lt;Bottle&gt;');
  expect(html).not.toContain('<h1>Steel <Bottle></h1>');

  const scripts = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)]
    .map(match => JSON.parse(match[1]));
  const productSchema = scripts.find(schema => schema['@type'] === 'Product');
  const breadcrumb = scripts.find(schema => schema['@type'] === 'BreadcrumbList');
  expect(productSchema).toMatchObject({
    name: 'Steel <Bottle>',
    description: 'An insulated bottle for daily use.',
    sku: product._id,
    offers: { price: 1990, priceCurrency: 'PKR' },
  });
  expect(productSchema.image).toHaveLength(2);
  expect(breadcrumb.itemListElement.every(item => item.name)).toBe(true);
});

test('catalog and store renders expose crawlable visible inventory', () => {
  const catalog = renderCatalogPage({ products: [product], stores: [store] });
  const storefront = renderStorePage({ store, products: [product] });
  expect(catalog).toContain('Steel &lt;Bottle&gt;');
  expect(catalog).toContain('https://nova-nest.rozare.com/');
  expect(storefront).toContain('<h1>Nova &amp; Nest</h1>');
  expect(storefront).toContain('Steel &lt;Bottle&gt;');
});

test('unavailable render is explicitly noindex', () => {
  const html = renderUnavailablePage({ canonical: 'https://blocked.rozare.com/', kind: 'store' });
  expect(html).toContain('noindex, nofollow, noarchive, nosnippet');
  expect(html).toContain('Store unavailable');
});
