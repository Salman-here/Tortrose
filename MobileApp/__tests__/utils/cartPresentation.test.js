import {
  getCartPresentationItemCount,
  getCartPresentationQuantity,
  guestCartPresentationTotal,
  normalizeServerCartPayload,
} from '../../src/utils/cartPresentation';

describe('cart presentation integrity', () => {
  it('sums only same-native-currency guest lines in exact minor units', () => {
    expect(guestCartPresentationTotal([
      { product: { price: 200, currency: 'PKR' }, qty: 2 },
      { product: { price: 10, discountedPrice: 6.25, currency: 'PKR' }, qty: 2 },
    ])).toEqual({ totalCartPrice: 412.5, totalCartCurrency: 'PKR' });
    expect(guestCartPresentationTotal([])).toEqual({
      totalCartPrice: 0,
      totalCartCurrency: null,
    });
  });

  it('does not add unlike native currencies without an authoritative rate table', () => {
    expect(guestCartPresentationTotal([
      { product: { price: 200, currency: 'PKR' }, qty: 1 },
      { product: { price: 6, currency: 'USD' }, qty: 1 },
    ])).toEqual({ totalCartPrice: null, totalCartCurrency: null });
  });

  it('rejects corrupt guest money, quantity, and currency metadata', () => {
    [
      { product: { price: '6.00', currency: 'USD' }, qty: 1 },
      { product: { price: 0.001, currency: 'USD' }, qty: 1 },
      { product: { price: 6, currency: 'usd' }, qty: 1 },
      { product: { price: 6, currency: 'USD', priceCurrency: 'PKR' }, qty: 1 },
      { product: { price: 6, currency: 'USD' }, qty: '1' },
      { product: { price: 6, currency: 'USD' }, qty: 1, quantity: 2 },
    ].forEach((item) => {
      expect(() => guestCartPresentationTotal([item])).toThrow(
        expect.objectContaining({ code: 'CART_PRESENTATION_DATA_INVALID' }),
      );
    });
  });

  it('defaults only a genuinely missing legacy quantity and sums exact counts', () => {
    expect(getCartPresentationQuantity({})).toBe(1);
    expect(getCartPresentationQuantity({ qty: null })).toBe(1);
    expect(getCartPresentationQuantity({ qty: 2, quantity: 2 })).toBe(2);
    expect(getCartPresentationItemCount([{ qty: 2 }, { quantity: 3 }])).toBe(5);
    [0, -1, 1.5, '2', true, Number.POSITIVE_INFINITY].forEach((qty) => {
      expect(() => getCartPresentationQuantity({ qty })).toThrow(
        expect.objectContaining({ code: 'CART_PRESENTATION_DATA_INVALID' }),
      );
    });
    expect(() => getCartPresentationQuantity({ qty: 1, quantity: 2 })).toThrow(
      expect.objectContaining({ code: 'CART_PRESENTATION_DATA_INVALID' }),
    );
  });

  it('accepts only exact canonical authoritative server cart snapshots', () => {
    expect(normalizeServerCartPayload({
      cart: [],
      totalCartPrice: 1880,
      totalCartCurrency: 'PKR',
    })).toEqual({ cart: [], totalCartPrice: 1880, totalCartCurrency: 'PKR' });
    [
      { cart: {}, totalCartPrice: 0, totalCartCurrency: 'USD' },
      { cart: [], totalCartPrice: '0.00', totalCartCurrency: 'USD' },
      { cart: [], totalCartPrice: 0.001, totalCartCurrency: 'USD' },
      { cart: [], totalCartPrice: 0, totalCartCurrency: 'usd' },
      { cart: [], totalCartPrice: 0 },
    ].forEach((payload) => {
      expect(() => normalizeServerCartPayload(payload)).toThrow(
        expect.objectContaining({ code: 'CART_PRESENTATION_DATA_INVALID' }),
      );
    });
  });
});
