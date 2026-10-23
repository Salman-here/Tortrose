'use strict';

const {
  renderCatalogPage,
  renderProductPage,
  renderStorePage,
  renderUnavailablePage,
  socialPreviewImage,
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

test('seller-controlled text cannot break out of structured data or metadata', () => {
  const name = 'Travel Mug </script><script>alert("unsafe")</script>';
  const html = renderProductPage({ product: { ...product, name }, store });
  expect(html).not.toContain('<script>alert("unsafe")</script>');
  const data = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map(match => JSON.parse(match[1]));
  expect(data.find(value => value['@type'] === 'Product').name).toBe(name);
  expect(html).toContain('&lt;/script&gt;');
});

test('gallery images remain product-specific, and missing logos never borrow a generic brand image or store banner', () => {
  const html = renderProductPage({ product: { ...product, image: '', images: ['https://images.example.com/gallery.png'] }, store });
  expect(html).toContain('<meta property="og:image" content="https://images.example.com/gallery.png">');
  const storefront = renderStorePage({ store: { ...store, logo: ' ', banner: 'https://images.example.com/banner.png' } });
  expect(storefront).not.toContain('<meta property="og:image"');
  expect(storefront).not.toContain('<meta name="twitter:image"');
  const withoutImage = renderProductPage({ product: { ...product, image: '', images: [] }, store });
  expect(withoutImage).not.toContain('<meta property="og:image"');
  expect(withoutImage).not.toContain('og-image.png');
  expect(renderProductPage({ product: { ...product, image: { invalid: true }, images: [] }, store })).not.toContain('%5Bobject');
});

test('product and store previews each contain exactly their own first image', () => {
  const productHtml = renderProductPage({ product, store });
  const storeHtml = renderStorePage({ store, products: [product] });
  expect(productHtml.match(/property="og:image"/g)).toHaveLength(1);
  expect(productHtml).toContain(`<meta property="og:image" content="${product.image}">`);
  expect(storeHtml.match(/property="og:image"/g)).toHaveLength(1);
  expect(storeHtml).toContain(`<meta property="og:image" content="${store.logo}">`);
  expect(renderUnavailablePage({ kind: 'product' })).not.toContain('property="og:image"');
});

test('Cloudinary social previews are small JPEG delivery variants, without changing original product photos or store logos', () => {
  const original = 'https://res.cloudinary.com/dyu9eaqag/image/upload/v1788025500/E-Commerce/product.png';
  const preview = socialPreviewImage(original);
  expect(preview).toEqual({ url: 'https://res.cloudinary.com/dyu9eaqag/image/upload/c_pad,w_1200,h_630,b_white/f_jpg/q_auto:good/v1788025500/E-Commerce/product.jpg',
    mimeType: 'image/jpeg', width: 1200, height: 630 });
  for (const html of [renderProductPage({ product: { ...product, image: original }, store }), renderStorePage({ store: { ...store, logo: original } })]) {
    expect(html).toContain(`<meta property="og:image" content="${preview.url}">`);
    expect(html).toContain(`<meta name="twitter:image" content="${preview.url}">`);
    expect(html).toContain('<meta property="og:image:type" content="image/jpeg">');
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta property="og:image:height" content="630">');
    const schemas = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map(match => JSON.parse(match[1]));
    const entity = schemas.find(schema => ['Product', 'Store'].includes(schema['@type']));
    expect(entity['@type'] === 'Product' ? entity.image[0] : entity.logo).toBe(original);
  }
  const html = renderProductPage({ product: { ...product, image: original }, store });
  expect(html).toContain(`<img src="${original}"`);
  expect(original).toContain('/v1788025500/E-Commerce/product.png');
});

test('preview optimization never changes signed, transformed, non-image, or external image URLs', () => {
  for (const url of [
    product.image,
    'https://res.cloudinary.com/demo/image/upload/s--signature--/v123/product.png',
    'https://res.cloudinary.com/demo/image/upload/w_500/v123/product.png',
    'https://res.cloudinary.com/demo/image/upload/v123/product.png?__cld_token__=private',
    'https://res.cloudinary.com/demo/raw/upload/v123/document.pdf',
    'https://res.cloudinary.com.evil.example/demo/image/upload/v123/product.png',
  ]) expect(socialPreviewImage(url)).toEqual({ url });
  expect(socialPreviewImage('javascript:alert(1)')).toEqual({ url: '' });
  expect(socialPreviewImage(null)).toEqual({ url: '' });
});
