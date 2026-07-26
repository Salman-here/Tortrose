/**
 * WishlistContext — optimistic wishlist state, isolated from cart/notifications.
 */
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import Toast from 'react-native-toast-message';
import * as Haptics from 'expo-haptics';
import { impact as hapticImpact } from '../utils/haptics';
import api from '../config/api';
import { useAuth } from './AuthContext';

const WishlistContext = createContext();

export const WishlistProvider = ({ children }) => {
  const { currentUser } = useAuth();
  const [wishlistItems, setWishlistItems] = useState([]);
  const wishlistItemsRef = useRef([]);
  const fetchSequenceRef = useRef(0);
  const mutationSequenceRef = useRef(0);
  const productMutationVersionsRef = useRef(new Map());
  const productMutationQueuesRef = useRef(new Map());
  const sessionGenerationRef = useRef(0);
  const userId = currentUser?._id || currentUser?.id || null;
  const activeUserIdRef = useRef(userId);

  const replaceWishlist = (nextOrUpdater) => {
    const nextWishlist = typeof nextOrUpdater === 'function'
      ? nextOrUpdater(wishlistItemsRef.current)
      : nextOrUpdater;
    const normalized = Array.isArray(nextWishlist) ? nextWishlist : [];
    wishlistItemsRef.current = normalized;
    setWishlistItems(normalized);
    return normalized;
  };

  const ensureActiveSession = () => {
    if (activeUserIdRef.current === userId) return;
    activeUserIdRef.current = userId;
    sessionGenerationRef.current += 1;
    fetchSequenceRef.current += 1;
    mutationSequenceRef.current += 1;
    productMutationVersionsRef.current.clear();
    productMutationQueuesRef.current.clear();
    replaceWishlist([]);
  };

  useEffect(() => {
    ensureActiveSession();
  }, [userId]);

  const sameProduct = (item, id) => String(item?._id || item?.id || '') === String(id);

  const nextProductMutationVersion = (id) => {
    const key = String(id);
    const version = (productMutationVersionsRef.current.get(key) || 0) + 1;
    productMutationVersionsRef.current.set(key, version);
    mutationSequenceRef.current += 1;
    return { key, version };
  };

  const isCurrentMutation = (key, version, sessionGeneration) =>
    sessionGenerationRef.current === sessionGeneration
    && productMutationVersionsRef.current.get(key) === version;

  const enqueueProductMutation = (key, sessionGeneration, operation) => {
    const previous = productMutationQueuesRef.current.get(key) || Promise.resolve();
    const queued = previous
      .catch(() => {})
      .then(() => {
        if (sessionGenerationRef.current !== sessionGeneration) return undefined;
        return operation();
      });

    productMutationQueuesRef.current.set(key, queued);
    queued.finally(() => {
      if (productMutationQueuesRef.current.get(key) === queued) {
        productMutationQueuesRef.current.delete(key);
      }
    });
    return queued;
  };

  const fetchWishlist = async () => {
    ensureActiveSession();
    const sessionGeneration = sessionGenerationRef.current;

    // Let already-queued optimistic writes reach the server before reading.
    // New writes that begin during the GET still invalidate its sequence below.
    while (
      sessionGenerationRef.current === sessionGeneration
      && productMutationQueuesRef.current.size > 0
    ) {
      const pendingMutations = Array.from(productMutationQueuesRef.current.values());
      await Promise.allSettled(pendingMutations);
    }

    if (sessionGenerationRef.current !== sessionGeneration) {
      return wishlistItemsRef.current;
    }

    const requestSequence = ++fetchSequenceRef.current;
    const mutationSequence = mutationSequenceRef.current;
    try {
      const res = await api.get('/api/products/get-wishlist');
      const nextWishlist = Array.isArray(res.data?.wishlist) ? res.data.wishlist : [];
      if (
        fetchSequenceRef.current === requestSequence
        && mutationSequenceRef.current === mutationSequence
        && sessionGenerationRef.current === sessionGeneration
      ) {
        replaceWishlist(nextWishlist);
      }
      return nextWishlist;
    } catch (error) {
      if (sessionGenerationRef.current !== sessionGeneration) {
        return wishlistItemsRef.current;
      }
      Toast.show({ type: 'error', text1: 'Error', text2: error.response?.data?.msg || 'Failed to fetch wishlist' });
      return null;
    }
  };

  const handleAddToWishlist = async (id, productHint = null) => {
    ensureActiveSession();
    if (!currentUser) {
      Toast.show({ type: 'info', text1: 'Login Required', text2: 'Please login to add items to wishlist' });
      return;
    }

    if (wishlistItemsRef.current.some((item) => sameProduct(item, id))) return;

    const { key, version } = nextProductMutationVersion(id);
    const sessionGeneration = sessionGenerationRef.current;
    replaceWishlist((items) => [
      ...items,
      productHint ? { ...productHint, _id: id } : { _id: id },
    ]);
    hapticImpact(Haptics.ImpactFeedbackStyle.Light);

    return enqueueProductMutation(key, sessionGeneration, async () => {
      try {
        const res = await api.get(`/api/products/add-to-wishlist/${id}`);
        if (!isCurrentMutation(key, version, sessionGeneration)) return;

        if (res.data?.product) {
          replaceWishlist((items) => items.map((item) => (
            sameProduct(item, id)
              ? { ...item, ...res.data.product, _id: res.data.product._id || id }
              : item
          )));
        }
        Toast.show({ type: 'success', text1: 'Saved', text2: res.data.msg });
      } catch (err) {
        if (!isCurrentMutation(key, version, sessionGeneration)) return;
        if (
          err.response?.status === 400
          && /already in wishlist/i.test(err.response?.data?.msg || '')
        ) {
          Toast.show({ type: 'success', text1: 'Saved', text2: 'Already in your favorites' });
          return;
        }
        replaceWishlist((items) => items.filter((item) => !sameProduct(item, id)));
        Toast.show({ type: 'error', text1: 'Error', text2: err.response?.data?.msg || 'Error adding to wishlist' });
      }
    });
  };

  const handleDeleteFromWishlist = async (id) => {
    ensureActiveSession();
    if (!currentUser) return;

    const removedItem = wishlistItemsRef.current.find((item) => sameProduct(item, id));
    if (!removedItem) return;

    const { key, version } = nextProductMutationVersion(id);
    const sessionGeneration = sessionGenerationRef.current;
    replaceWishlist((items) => items.filter((item) => !sameProduct(item, id)));
    hapticImpact(Haptics.ImpactFeedbackStyle.Light);

    return enqueueProductMutation(key, sessionGeneration, async () => {
      try {
        const res = await api.delete(`/api/products/delete-from-wishlist/${id}`);
        if (!isCurrentMutation(key, version, sessionGeneration)) return;
        Toast.show({ type: 'info', text1: 'Removed', text2: res.data.msg });
      } catch (err) {
        if (!isCurrentMutation(key, version, sessionGeneration)) return;
        replaceWishlist((items) => (
          items.some((item) => sameProduct(item, id))
            ? items
            : [...items, removedItem]
        ));
        Toast.show({ type: 'error', text1: 'Error', text2: err.response?.data?.msg || 'Error removing from wishlist' });
      }
    });
  };

  return (
    <WishlistContext.Provider value={{ wishlistItems, fetchWishlist, handleAddToWishlist, handleDeleteFromWishlist }}>
      {children}
    </WishlistContext.Provider>
  );
};

export const useWishlist = () => {
  const ctx = useContext(WishlistContext);
  if (!ctx) throw new Error('useWishlist must be used within WishlistProvider');
  return ctx;
};
