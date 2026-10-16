import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { readPublicSeoPreview } from '../src/utils/publicSeoPreview.js';

const url = 'https://rozare.com/single-product/64b000000000000000000001';
const record = { '@type': 'Product', name: 'Travel Mug', description: 'A travel mug.', image: ['https://images.example.com/mug.png'], offers: { url, price: 100, priceCurrency: 'PKR' } };
const document = (canonical = url, records = [record]) => ({ querySelector: () => ({ getAttribute: () => canonical }), querySelectorAll: () => records.map(value => ({ textContent: typeof value === 'string' ? value : JSON.stringify(value) })) });

test('a location-pending public preview retains verified metadata and readable product details', () => {
  assert.deepEqual(readPublicSeoPreview('product', url, document()), { name: 'Travel Mug', description: 'A travel mug.', image: 'https://images.example.com/mug.png', price: 100, currency: 'PKR' });
});

test('previews cannot borrow a previous route record or malformed JSON', () => {
  assert.equal(readPublicSeoPreview('product', url + '2', document()), null);
  assert.equal(readPublicSeoPreview('product', url, document(url, ['not JSON'])), null);
  assert.equal(readPublicSeoPreview('product', url, document(url, [{ ...record, offers: { ...record.offers, url: 'https://other.example/' } } ])), null);
  assert.equal(readPublicSeoPreview('product', url, undefined), null);
});

test('an incomplete or coerced offer never becomes a fabricated free price', () => {
  for (const price of [null, undefined, '100', -1]) {
    const preview = readPublicSeoPreview('product', url, document(url, [{ ...record, offers: { ...record.offers, price } }]));
    assert.equal(preview.price, undefined);
    assert.equal(preview.currency, undefined);
  }
});

test('store previews use the correct store logo and are not purchase or location authority', () => {
  const canonical = 'https://atlas-aura.rozare.com/';
  const store = { '@type': 'Store', name: 'Atlas Aura', url: canonical, logo: 'https://images.example.com/logo.png', image: 'https://images.example.com/banner.png' };
  assert.equal(readPublicSeoPreview('store', canonical, document(canonical, [store])).image, store.logo);
  const component = readFileSync(new URL('../src/components/common/PublicSeoPreview.jsx', import.meta.url), 'utf8');
  assert(!/addToCart|handleAddToCart|checkout|buyNow|axios|fetch\(/.test(component));
});

test('valid loading pages never overwrite server metadata with transient noindex', () => {
  for (const file of ['ProductDetailPage.jsx', 'StorePage.jsx']) {
    const source = readFileSync(new URL('../src/pages/' + file, import.meta.url), 'utf8');
    assert(!/SEOHead title="Loading (product|store)"/.test(source));
    assert(source.includes('<PublicSeoPreview'));
    assert(/SEOHead title="(Product|Store) unavailable"[\s\S]*?noindex/.test(source));
  }
});
