jest.mock('expo-print', () => ({ printToFileAsync: jest.fn() }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));

import {
  buildWishlistHtml,
  formatWishlistProductPrice,
} from '../../src/utils/shareWishlist';

describe('wishlist sharing money', () => {
  it('keeps every product in its own native currency', () => {
    expect(formatWishlistProductPrice({ price: 1000, currency: 'PKR' })).toContain('PKR');
    expect(formatWishlistProductPrice({ price: 10, currency: 'USD' })).toContain('$10.00');

    const html = buildWishlistHtml([
      { name: 'PKR item', price: 1000, currency: 'PKR' },
      { name: 'USD item', price: 10, currency: 'USD' },
    ]);
    expect(html).toContain('PKR');
    expect(html).toContain('$10.00');
    expect(html).not.toContain('$1000.00');
  });

  it('uses only a valid lower discounted native price', () => {
    expect(formatWishlistProductPrice({ price: 20, discountedPrice: 15, currency: 'GBP' })).toContain('15.00');
    expect(formatWishlistProductPrice({ price: 20, discountedPrice: 25, currency: 'GBP' })).toContain('20.00');
  });

  it('does not relabel corrupt price or currency data in a shared document', () => {
    expect(formatWishlistProductPrice({ price: '10', currency: 'USD' })).toBe('Price unavailable');
    expect(formatWishlistProductPrice({ price: 10, currency: 'CAD' })).toBe('Price unavailable');
    expect(formatWishlistProductPrice({
      price: 70368744177664.02,
      currency: 'PKR',
    })).toBe('Price unavailable');
    expect(buildWishlistHtml([{
      name: '<script>alert(1)</script>',
      image: 'x" onerror="alert(1)',
      price: 10,
      currency: 'USD',
    }], '<Admin>')).not.toContain('<script>');
  });
});
