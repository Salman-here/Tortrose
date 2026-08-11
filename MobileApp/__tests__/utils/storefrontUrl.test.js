import {
  getStorefrontHost,
  getStorefrontUrl,
  normalizeStoreSlug,
} from '../../src/utils/storefrontUrl';

describe('storefront subdomain URLs', () => {
  test.each([
    ['my-store', 'my-store'],
    ['my-store.rozare.com', 'my-store'],
    ['https://my-store.rozare.com/products?page=2#featured', 'my-store'],
    ['https://rozare.com/store/my-store?ref=mobile', 'my-store'],
    ['www.rozare.com/store/my-store', 'my-store'],
  ])('normalizes %s to the canonical store slug', (input, expected) => {
    expect(normalizeStoreSlug(input)).toBe(expected);
  });

  test.each([
    'https://rozare.com',
    'www.rozare.com',
    'docs.rozare.com',
    'not-rozare.example.com',
    'bad_slug',
    '-bad-edge',
  ])('rejects a non-store or invalid host value: %s', (input) => {
    expect(normalizeStoreSlug(input)).toBe('');
  });

  it('formats the exact production subdomain rather than a legacy /store path', () => {
    expect(getStorefrontHost('my-store')).toBe('my-store.rozare.com');
    expect(getStorefrontUrl('my-store')).toBe('https://my-store.rozare.com');
    expect(getStorefrontUrl('https://my-store.rozare.com/catalog')).not.toContain('/store/');
  });
});
