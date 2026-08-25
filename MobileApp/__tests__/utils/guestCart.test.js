import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  GUEST_CART_STORAGE_KEY,
  calculateGuestCartTotal,
  cartLineIdentity,
  clearGuestCart,
  decrementGuestCartLine,
  guestCartPayload,
  guestLineId,
  incrementGuestCartLine,
  normalizeGuestCart,
  optionsKeyOf,
  readGuestCart,
  removeGuestCartLine,
  writeGuestCart,
} from '../../src/utils/guestCart';

const product = {
  _id: '64b000000000000000000001',
  name: 'Premium headphones',
  price: 120,
  discountedPrice: 90,
  stock: 5,
};

describe('guest cart persistence and variant identity', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('uses product, color, and sorted options as the stable line identity', () => {
    const left = cartLineIdentity(product._id, 'Black', { Size: 'Large', Material: 'Cotton' });
    const right = cartLineIdentity(product._id, 'Black', { Material: 'Cotton', Size: 'Large' });

    expect(left).toBe(right);
    expect(optionsKeyOf({ Size: 'Large', Material: 'Cotton' }))
      .toBe(optionsKeyOf({ Material: 'Cotton', Size: 'Large' }));
    expect(guestLineId(product._id, 'Black', { Size: 'Large' }))
      .not.toBe(guestLineId(product._id, 'White', { Size: 'Large' }));
  });

  it('keeps different variants as separate lines and combines exact duplicates', () => {
    const cart = normalizeGuestCart([
      { product, qty: 1, selectedColor: 'Black', selectedOptions: { Size: 'Large', Material: 'Cotton' } },
      { product, qty: 2, selectedColor: 'Black', selectedOptions: { Material: 'Cotton', Size: 'Large' } },
      { product, qty: 1, selectedColor: 'White', selectedOptions: { Size: 'Large', Material: 'Cotton' } },
    ]);

    expect(cart).toHaveLength(2);
    expect(cart.find((line) => line.selectedColor === 'Black').qty).toBe(3);
    expect(cart.find((line) => line.selectedColor === 'White').qty).toBe(1);
  });

  it('persists a normalized cart and restores it after an app restart', async () => {
    const saved = await writeGuestCart([{
      product,
      qty: 2,
      selectedColor: 'Black',
      selectedOptions: { Size: 'Large', Material: 'Cotton', Empty: '' },
    }]);
    const restored = await readGuestCart();

    expect(restored).toEqual(saved);
    expect(restored[0].selectedOptions).toEqual({ Material: 'Cotton', Size: 'Large' });
    expect(calculateGuestCartTotal(restored)).toBe(180);
    expect(await AsyncStorage.getItem(GUEST_CART_STORAGE_KEY)).not.toBeNull();
  });

  it('builds the exact authenticated merge payload and clears only after requested', async () => {
    const cart = await writeGuestCart([{
      product,
      qty: 2,
      selectedColor: 'Black',
      selectedOptions: { Size: 'Large' },
    }]);

    expect(guestCartPayload(cart)).toEqual([{
      productId: product._id,
      qty: 2,
      selectedColor: 'Black',
      selectedOptions: { Size: 'Large' },
    }]);

    await clearGuestCart();
    expect(await readGuestCart()).toEqual([]);
    expect(await AsyncStorage.getItem(GUEST_CART_STORAGE_KEY)).toBeNull();
  });

  it('fails closed instead of restoring malformed persisted data as an empty cart', async () => {
    await AsyncStorage.setItem(GUEST_CART_STORAGE_KEY, '{broken-json');
    await expect(readGuestCart()).rejects.toMatchObject({ code: 'CART_PRESENTATION_DATA_INVALID' });

    await AsyncStorage.setItem(GUEST_CART_STORAGE_KEY, JSON.stringify([
      { qty: 2 },
      { product: { name: 'Missing id' }, qty: 1 },
    ]));
    await expect(readGuestCart()).rejects.toMatchObject({ code: 'CART_PRESENTATION_DATA_INVALID' });
  });

  it.each([0, -1, 1.5, '2', true, Number.POSITIVE_INFINITY, 100])(
    'rejects malformed persisted quantity %p rather than coercing it',
    (qty) => {
      expect(() => normalizeGuestCart([{ product, qty }])).toThrow(
        expect.objectContaining({ code: 'CART_PRESENTATION_DATA_INVALID' }),
      );
    },
  );

  it('rejects malformed persisted stock rather than treating it as available', () => {
    [undefined, null, '5', true, -1, 1.5].forEach((stock) => {
      expect(() => normalizeGuestCart([{ product: { ...product, stock }, qty: 1 }])).toThrow(
        expect.objectContaining({ code: 'CART_PRESENTATION_DATA_INVALID' }),
      );
    });
  });

  it('updates guest quantities by line id and removes a line when decrementing one', () => {
    const [line] = normalizeGuestCart([{ product, qty: 1, selectedColor: 'Black' }]);
    const incremented = incrementGuestCartLine([line], line._id);
    expect(incremented.cart[0].qty).toBe(2);
    expect(incremented.reachedStockLimit).toBe(false);

    const backToOne = decrementGuestCartLine(incremented.cart, line._id);
    expect(backToOne[0].qty).toBe(1);
    expect(decrementGuestCartLine(backToOne, line._id)).toEqual([]);
    expect(removeGuestCartLine(incremented.cart, line._id)).toEqual([]);
  });

  it('caps guest quantity at live product stock', () => {
    const [line] = normalizeGuestCart([{ product: { ...product, stock: 2 }, qty: 2 }]);
    const result = incrementGuestCartLine([line], line._id);
    expect(result.cart[0].qty).toBe(2);
    expect(result.reachedStockLimit).toBe(true);
  });
});
