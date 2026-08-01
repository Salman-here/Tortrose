/**
 * CartContext - one cart interface for persisted guest bags and server carts.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import * as Haptics from 'expo-haptics';
import Feedback from '../utils/feedback';
import { impact as hapticImpact } from '../utils/haptics';
import api from '../config/api';
import { useAuth } from './AuthContext';
import {
  calculateGuestCartTotal,
  cartLineIdentity,
  clearGuestCart,
  decrementGuestCartLine,
  guestCartPayload,
  guestLineId,
  incrementGuestCartLine,
  optionsKeyOf,
  readGuestCart,
  removeGuestCartLine,
  writeGuestCart,
} from '../utils/guestCart';

const CartContext = createContext();
const EMPTY_CART = { totalCartPrice: 0, cart: [] };

const normalizeServerCart = (payload) => ({
  cart: Array.isArray(payload?.cart) ? payload.cart : [],
  totalCartPrice: Number(payload?.totalCartPrice) || 0,
  ...(payload?.totalCartCurrency ? { totalCartCurrency: payload.totalCartCurrency } : {}),
});

const guestCartState = (cart) => ({
  cart,
  totalCartPrice: calculateGuestCartTotal(cart),
});

const productIdOf = (item) => String(item?.product?._id || item?.product || '');

const lineMatches = (item, productId, selectedColor, selectedOptions) => (
  productIdOf(item) === String(productId)
  && (item?.selectedColor || null) === (selectedColor || null)
  && optionsKeyOf(item?.selectedOptions) === optionsKeyOf(selectedOptions)
);

export const CartProvider = ({ children }) => {
  const { currentUser } = useAuth();
  const currentUserId = currentUser?._id || currentUser?.id || null;
  const [cartItems, setCartItems] = useState(EMPTY_CART);
  const [isCartLoading, setIsCartLoading] = useState(true);
  const [loadingProductId, setLoadingProductId] = useState(null);
  const [qtyUpdateId, setQtyUpdateId] = useState(null);
  const cartItemsRef = useRef(EMPTY_CART);
  const guestMutationQueueRef = useRef(Promise.resolve());

  const replaceCart = useCallback((nextCart) => {
    cartItemsRef.current = nextCart;
    setCartItems(nextCart);
  }, []);

  const runGuestMutation = useCallback((mutation) => {
    const operation = guestMutationQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const storedCart = await readGuestCart();
        const nextCart = await mutation(storedCart);
        const savedCart = await writeGuestCart(nextCart);
        replaceCart(guestCartState(savedCart));
        return savedCart;
      });

    guestMutationQueueRef.current = operation.catch(() => undefined);
    return operation;
  }, [replaceCart]);

  const readSettledGuestCart = useCallback(async () => {
    // If a tap queues a mutation while hydration is reading storage, retry the
    // read instead of letting the older snapshot overwrite the fresh UI.
    while (true) {
      const pendingMutations = guestMutationQueueRef.current;
      await pendingMutations.catch(() => undefined);
      const guestCart = await readGuestCart();
      if (pendingMutations === guestMutationQueueRef.current) return guestCart;
    }
  }, []);

  const loadGuestCart = useCallback(async () => {
    const guestCart = await readSettledGuestCart();
    replaceCart(guestCartState(guestCart));
    return guestCart;
  }, [readSettledGuestCart, replaceCart]);

  const fetchCart = useCallback(async () => {
    setIsCartLoading(true);
    try {
      if (!currentUserId) {
        await loadGuestCart();
        return;
      }

      const response = await api.get('/api/cart/get');
      replaceCart(normalizeServerCart(response.data));
    } catch (error) {
      if (error.response?.status !== 403) {
        Feedback.show({
          type: 'error',
          text1: 'Could not refresh your bag',
          text2: error.response?.data?.msg || 'Please try again in a moment',
        });
      }
    } finally {
      setIsCartLoading(false);
    }
  }, [currentUserId, loadGuestCart, replaceCart]);

  useEffect(() => {
    let active = true;

    const synchronizeCart = async () => {
      setIsCartLoading(true);
      try {
        if (!currentUserId) {
          const guestCart = await readSettledGuestCart();
          if (active) replaceCart(guestCartState(guestCart));
          return;
        }

        const guestCart = await readSettledGuestCart();
        if (guestCart.length > 0) {
          try {
            const response = await api.post('/api/cart/merge', {
              items: guestCartPayload(guestCart),
            });
            await clearGuestCart();
            if (active) replaceCart(normalizeServerCart(response.data));
            return;
          } catch (error) {
            // Keep the local bag intact so a later app launch can safely retry.
            Feedback.show({
              type: 'info',
              text1: 'Your local bag is safe',
              text2: error.response?.data?.msg || 'We will try syncing it again shortly',
            });
          }
        }

        const response = await api.get('/api/cart/get');
        if (active) replaceCart(normalizeServerCart(response.data));
      } catch (error) {
        if (error.response?.status !== 403) {
          Feedback.show({
            type: 'error',
            text1: 'Could not load your bag',
            text2: error.response?.data?.msg || 'Please pull down to retry',
          });
        }
      } finally {
        if (active) setIsCartLoading(false);
      }
    };

    synchronizeCart();
    return () => { active = false; };
  }, [currentUserId, readSettledGuestCart, replaceCart]);

  const handleRemoveCartItem = useCallback(async (lineId) => {
    if (!lineId) return;

    setQtyUpdateId(lineId);
    try {
      if (!currentUserId) {
        await runGuestMutation((items) => removeGuestCartLine(items, lineId));
        Feedback.show({ type: 'info', text1: 'Removed', text2: 'Item removed from your bag' });
        return;
      }

      const response = await api.delete(`/api/cart/remove/${lineId}`);
      replaceCart(normalizeServerCart(response.data));
      Feedback.show({
        type: 'info',
        text1: 'Removed',
        text2: response.data?.msg || 'Item removed from your bag',
      });
    } catch (error) {
      Feedback.show({
        type: 'error',
        text1: 'Could not remove item',
        text2: error.response?.data?.msg || 'Please try again',
      });
    } finally {
      setQtyUpdateId(null);
    }
  }, [currentUserId, replaceCart, runGuestMutation]);

  const handleAddToCart = useCallback(async (
    id,
    selectedColor = null,
    selectedOptions = null,
    productHint = null
  ) => {
    if (!id) return;

    const existingLine = cartItemsRef.current.cart.find((item) => (
      lineMatches(item, id, selectedColor, selectedOptions)
    ));
    if (existingLine) {
      await handleRemoveCartItem(existingLine._id);
      return;
    }

    setIsCartLoading(true);
    setLoadingProductId(id);
    hapticImpact(Haptics.ImpactFeedbackStyle.Medium);

    try {
      if (!currentUserId) {
        let product = productHint;
        if (!product || String(product._id || '') !== String(id)) {
          const response = await api.get(`/api/products/get-single-product/${id}`);
          product = response.data?.product || response.data;
        }
        if (!product?._id) throw new Error('Product details are unavailable');
        if (product.stock !== undefined && Number(product.stock) <= 0) {
          throw new Error('This product is out of stock');
        }

        const identity = cartLineIdentity(id, selectedColor, selectedOptions);
        await runGuestMutation((items) => {
          if (items.some((item) => (
            cartLineIdentity(
              item.product?._id,
              item.selectedColor,
              item.selectedOptions
            ) === identity
          ))) return items;

          return [
            ...items,
            {
              _id: guestLineId(id, selectedColor, selectedOptions),
              product: { ...product, _id: id },
              qty: 1,
              selectedColor: selectedColor || null,
              ...(selectedOptions ? { selectedOptions } : {}),
              __guest: true,
            },
          ];
        });
        Feedback.show({ type: 'success', text1: 'Added to your bag', text2: 'Ready when you are' });
        return;
      }

      const previousCart = cartItemsRef.current;
      if (productHint) {
        const optimisticLine = {
          _id: `__optim_${id}_${Date.now()}`,
          qty: 1,
          selectedColor: selectedColor || null,
          ...(selectedOptions ? { selectedOptions } : {}),
          product: { ...productHint, _id: id },
          __optimistic: true,
        };
        replaceCart({
          ...previousCart,
          cart: [...previousCart.cart, optimisticLine],
          totalCartPrice: previousCart.totalCartPrice
            + Number(productHint.discountedPrice || productHint.price || 0),
        });
      }

      try {
        const response = await api.post(`/api/cart/add/${id}`, {
          selectedColor,
          ...(selectedOptions ? { selectedOptions } : {}),
        });
        replaceCart(normalizeServerCart(response.data));
        Feedback.show({
          type: 'success',
          text1: 'Added to your bag',
          text2: response.data?.msg || 'Ready when you are',
        });
      } catch (error) {
        replaceCart(previousCart);
        throw error;
      }
    } catch (error) {
      Feedback.show({
        type: 'error',
        text1: 'Could not add item',
        text2: error.response?.data?.msg || error.message || 'Please try again',
      });
    } finally {
      setIsCartLoading(false);
      setLoadingProductId(null);
    }
  }, [currentUserId, handleRemoveCartItem, replaceCart, runGuestMutation]);

  const handleQtyInc = useCallback(async (lineId) => {
    if (!lineId) return;
    setQtyUpdateId(lineId);
    try {
      if (!currentUserId) {
        let reachedStockLimit = false;
        await runGuestMutation((items) => {
          const result = incrementGuestCartLine(items, lineId);
          reachedStockLimit = result.reachedStockLimit;
          return result.cart;
        });
        if (reachedStockLimit) {
          Feedback.show({ type: 'info', text1: 'Stock limit reached', text2: 'No more units are available' });
        }
        return;
      }

      const response = await api.patch(`/api/cart/qty-inc/${lineId}`, {});
      replaceCart(normalizeServerCart(response.data));
    } catch (error) {
      Feedback.show({
        type: 'error',
        text1: 'Could not update quantity',
        text2: error.response?.data?.msg || 'Please try again',
      });
    } finally {
      setQtyUpdateId(null);
    }
  }, [currentUserId, replaceCart, runGuestMutation]);

  const handleQtyDec = useCallback(async (lineId) => {
    if (!lineId) return;
    const currentLine = cartItemsRef.current.cart.find((item) => String(item._id) === String(lineId));
    if (currentLine && Number(currentLine.qty) <= 1) {
      await handleRemoveCartItem(lineId);
      return;
    }

    setQtyUpdateId(lineId);
    try {
      if (!currentUserId) {
        await runGuestMutation((items) => decrementGuestCartLine(items, lineId));
        return;
      }

      const response = await api.patch(`/api/cart/qty-dec/${lineId}`, {});
      replaceCart(normalizeServerCart(response.data));
    } catch (error) {
      Feedback.show({
        type: 'error',
        text1: 'Could not update quantity',
        text2: error.response?.data?.msg || 'Please try again',
      });
    } finally {
      setQtyUpdateId(null);
    }
  }, [currentUserId, handleRemoveCartItem, replaceCart, runGuestMutation]);

  return (
    <CartContext.Provider value={{
      cartItems,
      fetchCart,
      handleAddToCart,
      handleQtyInc,
      handleQtyDec,
      handleRemoveCartItem,
      isCartLoading,
      loadingProductId,
      qtyUpdateId,
    }}>
      {children}
    </CartContext.Provider>
  );
};

export const useCart = () => {
  const context = useContext(CartContext);
  if (!context) throw new Error('useCart must be used within CartProvider');
  return context;
};
