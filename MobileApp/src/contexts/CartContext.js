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
  calculateGuestCartSummary,
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
import { normalizeServerCartPayload } from '../utils/cartPresentation';
import {
  describeSelectionError,
  validateProductSelections,
} from '../utils/productOptions';

const CartContext = createContext();
const EMPTY_CART = { totalCartPrice: 0, totalCartCurrency: null, cart: [] };

const normalizeServerCart = normalizeServerCartPayload;

const guestCartState = (cart) => ({
  cart,
  ...calculateGuestCartSummary(cart),
});

const productIdOf = (item) => String(item?.product?._id || item?.product || '');

const lineMatches = (item, productId, selectedColor, selectedOptions) => (
  productIdOf(item) === String(productId)
  && (item?.selectedColor || null) === (selectedColor || null)
  && optionsKeyOf(item?.selectedOptions) === optionsKeyOf(selectedOptions)
);

export const CartProvider = ({ children }) => {
  const { currentUser, isLoading: isAuthLoading } = useAuth();
  const currentUserId = currentUser?._id || currentUser?.id || null;
  const cartOwner = String(currentUserId || 'guest');
  const [cartItems, setCartItems] = useState(EMPTY_CART);
  const [isCartLoading, setIsCartLoading] = useState(true);
  const [cartHydrationStatus, setCartHydrationStatus] = useState('hydrating');
  const [cartHydrationError, setCartHydrationError] = useState(null);
  const [hydratedCartOwner, setHydratedCartOwner] = useState(null);
  const [loadingProductId, setLoadingProductId] = useState(null);
  const [qtyUpdateId, setQtyUpdateId] = useState(null);
  const cartItemsRef = useRef(EMPTY_CART);
  const guestMutationQueueRef = useRef(Promise.resolve());
  const cartOwnerRef = useRef(cartOwner);
  const authLoadingRef = useRef(isAuthLoading);
  const cartReadRequestRef = useRef(0);
  const cartHydrationRequestRef = useRef(0);
  const cartHydrationOwnerRef = useRef(null);
  const cartHydrationPromiseRef = useRef(null);
  const cartHydrationStatusRef = useRef(cartHydrationStatus);
  const hydratedCartOwnerRef = useRef(hydratedCartOwner);
  cartOwnerRef.current = cartOwner;
  authLoadingRef.current = isAuthLoading;
  cartHydrationStatusRef.current = cartHydrationStatus;
  hydratedCartOwnerRef.current = hydratedCartOwner;
  const isCartReady = !isAuthLoading
    && cartHydrationStatus === 'ready'
    && hydratedCartOwner === cartOwner;

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

  const fetchAuthoritativeCart = useCallback(async (owner, reportError = true) => {
    const requestId = ++cartReadRequestRef.current;
    setIsCartLoading(true);
    try {
      if (owner === 'guest') {
        const guestCart = await readSettledGuestCart();
        if (
          requestId === cartReadRequestRef.current
          && cartOwnerRef.current === owner
          && !authLoadingRef.current
        ) {
          replaceCart(guestCartState(guestCart));
        }
        return guestCartState(guestCart);
      }

      const response = await api.get('/api/cart/get');
      const nextCart = normalizeServerCart(response.data);
      if (requestId === cartReadRequestRef.current && cartOwnerRef.current === owner) {
        replaceCart(nextCart);
      }
      return nextCart;
    } catch (error) {
      if (reportError && error.response?.status !== 403) {
        Feedback.show({
          type: 'error',
          text1: 'Could not refresh your bag',
          text2: error.response?.data?.msg || 'Please try again in a moment',
        });
      }
      throw error;
    } finally {
      if (requestId === cartReadRequestRef.current) setIsCartLoading(false);
    }
  }, [readSettledGuestCart, replaceCart]);

  const synchronizeCart = useCallback(async () => {
    if (authLoadingRef.current) return null;
    const owner = cartOwnerRef.current;
    const hydrationId = ++cartHydrationRequestRef.current;
    cartHydrationOwnerRef.current = owner;
    cartHydrationStatusRef.current = 'hydrating';
    setCartHydrationStatus('hydrating');
    setCartHydrationError(null);
    setIsCartLoading(true);

    try {
      if (owner === 'guest') {
        await fetchAuthoritativeCart(owner, false);
      } else {
        const guestCart = await readSettledGuestCart();
        if (guestCart.length > 0) {
          await api.post('/api/cart/merge', {
            items: guestCartPayload(guestCart),
          });
          // The local bag is cleared only after a successful merge. Checkout
          // remains blocked until the separate authoritative GET below also
          // completes, so these items cannot be merged again after purchase.
          await clearGuestCart();
        }
        await fetchAuthoritativeCart(owner, false);
      }

      if (hydrationId !== cartHydrationRequestRef.current || cartOwnerRef.current !== owner) return null;
      hydratedCartOwnerRef.current = owner;
      cartHydrationStatusRef.current = 'ready';
      setHydratedCartOwner(owner);
      setCartHydrationStatus('ready');
      return true;
    } catch (error) {
      if (hydrationId !== cartHydrationRequestRef.current || cartOwnerRef.current !== owner) return null;
      const message = error.response?.data?.msg || error.message || 'Your cart could not be synchronized.';
      cartHydrationStatusRef.current = 'error';
      setCartHydrationError(message);
      setCartHydrationStatus('error');
      Feedback.show({
        type: 'info',
        text1: 'Your local bag is safe',
        text2: `${message} Retry synchronization before checkout.`,
      });
      return false;
    } finally {
      if (hydrationId === cartHydrationRequestRef.current) setIsCartLoading(false);
    }
  }, [fetchAuthoritativeCart, readSettledGuestCart]);

  const retryCartHydration = useCallback(() => {
    const owner = cartOwnerRef.current;
    if (
      cartHydrationStatusRef.current === 'hydrating'
      && cartHydrationOwnerRef.current === owner
      && cartHydrationPromiseRef.current
    ) return cartHydrationPromiseRef.current;
    const operation = synchronizeCart();
    cartHydrationPromiseRef.current = operation;
    return operation;
  }, [synchronizeCart]);

  const fetchCart = useCallback(async () => {
    const owner = cartOwnerRef.current;
    if (
      authLoadingRef.current
      || cartHydrationStatusRef.current !== 'ready'
      || hydratedCartOwnerRef.current !== owner
    ) {
      return retryCartHydration();
    }
    try {
      return await fetchAuthoritativeCart(owner);
    } catch {
      return null;
    }
  }, [fetchAuthoritativeCart, retryCartHydration]);

  useEffect(() => {
    if (isAuthLoading) {
      cartHydrationStatusRef.current = 'hydrating';
      setCartHydrationStatus('hydrating');
      return undefined;
    }
    const operation = retryCartHydration();
    return () => {
      if (cartHydrationPromiseRef.current === operation) {
        ++cartHydrationRequestRef.current;
      }
    };
  }, [cartOwner, isAuthLoading, retryCartHydration]);

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
    if (!id) return false;

    setIsCartLoading(true);
    setLoadingProductId(id);
    hapticImpact(Haptics.ImpactFeedbackStyle.Medium);

    try {
      let product = productHint;
      let canonicalColor = selectedColor;
      let canonicalOptions = selectedOptions;

      const applyProductSelection = (selectionProduct) => {
        const validation = validateProductSelections(selectionProduct, {
          selectedColor,
          selectedOptions,
        });
        if (!validation.ok) {
          throw new Error(describeSelectionError(validation) || 'Review your product options to continue');
        }
        canonicalColor = validation.selectedColor;
        canonicalOptions = validation.selectedOptions;
      };

      if (product && String(product._id || '') === String(id)) {
        applyProductSelection(product);
      }

      const existingLine = cartItemsRef.current.cart.find((item) => (
        lineMatches(item, id, canonicalColor, canonicalOptions)
      ));
      if (existingLine) {
        await handleRemoveCartItem(existingLine._id);
        return true;
      }

      if (!currentUserId) {
        // Guest lines live locally, so refresh the public product before the
        // write to enforce the same current option contract as the API cart.
        const response = await api.get(`/api/products/get-single-product/${id}`);
        product = response.data?.product || response.data;
        if (!product?._id) throw new Error('Product details are unavailable');
        applyProductSelection(product);
        if (product.stock !== undefined && Number(product.stock) <= 0) {
          throw new Error('This product is out of stock');
        }

        const identity = cartLineIdentity(id, canonicalColor, canonicalOptions);
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
              _id: guestLineId(id, canonicalColor, canonicalOptions),
              product: { ...product, _id: id },
              qty: 1,
              selectedColor: canonicalColor || null,
              ...(canonicalOptions ? { selectedOptions: canonicalOptions } : {}),
              __guest: true,
            },
          ];
        });
        Feedback.show({ type: 'success', text1: 'Added to your bag', text2: 'Ready when you are' });
        return true;
      }

      const previousCart = cartItemsRef.current;
      if (productHint) {
        const optimisticLine = {
          _id: `__optim_${id}_${Date.now()}`,
          qty: 1,
          selectedColor: canonicalColor || null,
          ...(canonicalOptions ? { selectedOptions: canonicalOptions } : {}),
          product: { ...productHint, _id: id },
          __optimistic: true,
        };
        replaceCart({
          ...previousCart,
          cart: [...previousCart.cart, optimisticLine],
          // A product hint is native-currency data while an authenticated cart
          // total is in the account currency. Wait for the server snapshot.
          totalCartPrice: null,
          totalCartCurrency: null,
        });
      }

      try {
        const response = await api.post(`/api/cart/add/${id}`, {
          selectedColor: canonicalColor,
          ...(canonicalOptions ? { selectedOptions: canonicalOptions } : {}),
        });
        replaceCart(normalizeServerCart(response.data));
        Feedback.show({
          type: 'success',
          text1: 'Added to your bag',
          text2: response.data?.msg || 'Ready when you are',
        });
        return true;
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
      return false;
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
    if (currentLine && currentLine.qty <= 1) {
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
      isCartReady,
      cartHydrationStatus,
      cartHydrationError,
      retryCartHydration,
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
