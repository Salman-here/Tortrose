import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CartProvider, useCart } from '../../src/contexts/CartContext';
import api from '../../src/config/api';
import { GUEST_CART_STORAGE_KEY, writeGuestCart } from '../../src/utils/guestCart';

let mockCurrentUser = null;
let mockAuthLoading = false;

jest.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ currentUser: mockCurrentUser, isLoading: mockAuthLoading }),
}));

jest.mock('../../src/config/api', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock('../../src/utils/feedback', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));

jest.mock('../../src/utils/haptics', () => ({
  impact: jest.fn(),
}));

const product = {
  _id: '64b000000000000000000001',
  name: 'Premium headphones',
  price: 120,
  discountedPrice: 90,
  stock: 5,
};

const mockApi = api;

let latestCart;
const CartProbe = () => {
  latestCart = useCart();
  return null;
};

const flushEffects = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('CartContext guest and authenticated ownership', () => {
  let root;

  beforeEach(async () => {
    mockCurrentUser = null;
    mockAuthLoading = false;
    latestCart = null;
    jest.clearAllMocks();
    await AsyncStorage.clear();
  });

  afterEach(() => {
    if (root) {
      act(() => root.unmount());
      root = null;
    }
  });

  it('adds, persists, and removes a guest line without calling authenticated APIs', async () => {
    await act(async () => {
      root = TestRenderer.create(<CartProvider><CartProbe /></CartProvider>);
      await flushEffects();
    });

    await act(async () => {
      await latestCart.handleAddToCart(product._id, 'Black', { Size: 'Large' }, product);
    });

    expect(latestCart.cartItems.cart).toHaveLength(1);
    expect(latestCart.cartItems.cart[0]).toMatchObject({
      product: { _id: product._id },
      selectedColor: 'Black',
      selectedOptions: { Size: 'Large' },
      qty: 1,
      __guest: true,
    });
    expect(await AsyncStorage.getItem(GUEST_CART_STORAGE_KEY)).not.toBeNull();
    expect(mockApi.post).not.toHaveBeenCalled();

    await act(async () => {
      await latestCart.handleQtyDec(latestCart.cartItems.cart[0]._id);
    });

    expect(latestCart.cartItems.cart).toEqual([]);
    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(mockApi.delete).not.toHaveBeenCalled();
  });

  it('merges the persisted guest bag after authentication and clears it only on success', async () => {
    await writeGuestCart([{
      product,
      qty: 2,
      selectedColor: 'Black',
      selectedOptions: { Size: 'Large' },
    }]);
    mockCurrentUser = { _id: '64b000000000000000000099' };
    const serverLine = { _id: 'server-line', product, qty: 2, selectedColor: 'Black', selectedOptions: { Size: 'Large' } };
    mockApi.post.mockResolvedValue({ data: { cart: [serverLine], totalCartPrice: 180, totalCartCurrency: 'USD' } });
    mockApi.get.mockResolvedValue({ data: { cart: [serverLine], totalCartPrice: 180, totalCartCurrency: 'USD' } });

    await act(async () => {
      root = TestRenderer.create(<CartProvider><CartProbe /></CartProvider>);
      await flushEffects();
    });

    expect(mockApi.post).toHaveBeenCalledWith('/api/cart/merge', {
      items: [{
        productId: product._id,
        qty: 2,
        selectedColor: 'Black',
        selectedOptions: { Size: 'Large' },
      }],
    });
    expect(mockApi.get).toHaveBeenCalledWith('/api/cart/get');
    expect(latestCart.cartItems).toMatchObject({ cart: [serverLine], totalCartPrice: 180 });
    expect(latestCart.isCartReady).toBe(true);
    expect(latestCart.cartHydrationStatus).toBe('ready');
    expect(await AsyncStorage.getItem(GUEST_CART_STORAGE_KEY)).toBeNull();
  });

  it('keeps the local bag for a safe retry when authenticated merge fails', async () => {
    await writeGuestCart([{ product, qty: 1, selectedColor: 'Black' }]);
    mockCurrentUser = { _id: '64b000000000000000000099' };
    mockApi.post.mockRejectedValue({ response: { data: { msg: 'Temporary sync failure' } } });
    mockApi.get.mockResolvedValue({ data: { cart: [], totalCartPrice: 0, totalCartCurrency: 'USD' } });

    await act(async () => {
      root = TestRenderer.create(<CartProvider><CartProbe /></CartProvider>);
      await flushEffects();
    });

    expect(mockApi.post).toHaveBeenCalledTimes(1);
    expect(mockApi.get).not.toHaveBeenCalled();
    expect(latestCart.isCartReady).toBe(false);
    expect(latestCart.cartHydrationStatus).toBe('error');
    expect(await AsyncStorage.getItem(GUEST_CART_STORAGE_KEY)).not.toBeNull();
  });

  it('coalesces refreshes during hydration so the same guest bag is merged once', async () => {
    await writeGuestCart([{ product, qty: 1, selectedColor: 'Black' }]);
    mockCurrentUser = { _id: '64b000000000000000000099' };
    const serverLine = { _id: 'server-line', product, qty: 1, selectedColor: 'Black' };
    let resolveMerge;
    const mergePromise = new Promise((resolve) => { resolveMerge = resolve; });
    mockApi.post.mockReturnValue(mergePromise);
    mockApi.get.mockResolvedValue({ data: { cart: [serverLine], totalCartPrice: 90, totalCartCurrency: 'USD' } });

    await act(async () => {
      root = TestRenderer.create(<CartProvider><CartProbe /></CartProvider>);
      await flushEffects();
    });

    let refreshPromise;
    await act(async () => {
      refreshPromise = latestCart.fetchCart();
      await flushEffects();
    });
    expect(mockApi.post).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveMerge({ data: { cart: [serverLine], totalCartPrice: 90, totalCartCurrency: 'USD' } });
      await refreshPromise;
      await flushEffects();
    });

    expect(mockApi.post).toHaveBeenCalledTimes(1);
    expect(mockApi.get).toHaveBeenCalledTimes(1);
    expect(latestCart.isCartReady).toBe(true);
  });

  it('does not expose checkout-ready state until auth hydration resolves', async () => {
    mockAuthLoading = true;

    await act(async () => {
      root = TestRenderer.create(<CartProvider><CartProbe /></CartProvider>);
      await flushEffects();
    });

    expect(latestCart.isCartReady).toBe(false);
    expect(latestCart.cartHydrationStatus).toBe('hydrating');
    expect(mockApi.get).not.toHaveBeenCalled();
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});
