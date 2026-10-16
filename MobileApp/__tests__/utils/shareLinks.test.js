import fs from 'fs';
import path from 'path';
import { getProductShareUrl, productShareContent, storeShareContent } from '../../src/utils/shareLinks';

const id = '64b000000000000000000001';
test('mobile product shares contain a canonical HTTPS product URL on both native share sheets', () => {
  const content = productShareContent({ _id: id, name: 'Travel Mug' }, 'Rs100.00');
  expect(content).toEqual({ title: 'Travel Mug', message: `Travel Mug\nRs100.00\nhttps://rozare.com/single-product/${id}` });
  expect(getProductShareUrl(id.toUpperCase())).toBe(`https://rozare.com/single-product/${id}`);
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/screens/ProductDetailScreen.js'), 'utf8');
  expect(source).toContain('productShareContent(product,');
  expect(source).toContain('Share.share(content)');
});

test('mobile store shares use the canonical subdomain and do not duplicate a legacy URL', () => {
  expect(storeShareContent({ storeName: 'Atlas Aura', storeSlug: 'https://rozare.com/store/atlas-aura' })).toEqual({ title: 'Atlas Aura', message: 'Atlas Aura on Rozare\nhttps://atlas-aura.rozare.com/' });
});

test.each(['', '../checkout', 'https://other.example/product', 'invalid', null])('invalid product identifiers never become shared URLs: %j', value => {
  expect(getProductShareUrl(value)).toBe('');
  expect(productShareContent({ _id: value })).toBeNull();
});

test('unavailable or reserved store identifiers are not shared', () => {
  expect(storeShareContent({ storeSlug: 'admin' })).toBeNull();
  expect(storeShareContent({ storeSlug: 'https://other.example' })).toBeNull();
});
