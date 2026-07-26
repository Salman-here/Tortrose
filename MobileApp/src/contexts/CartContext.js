/**
 * CartContext — optimistic cart state, isolated from wishlist/notifications.
 */
import React, { createContext, useContext, useEffect, useState } from 'react';
import Feedback from '../utils/feedback';
import * as Haptics from 'expo-haptics';
import { impact as hapticImpact } from '../utils/haptics';
import api from '../config/api';
import { useAuth } from './AuthContext';

const CartContext = createContext();

export const CartProvider = ({ children }) => {
  const { currentUser } = useAuth();
  const [cartItems, setCartItems] = useState({ totalCartPrice: 0, cart: [] });
  const [isCartLoading, setIsCartLoading] = useState(false);
  const [loadingProductId, setLoadingProductId] = useState(null);
  const [qtyUpdateId, setQtyUpdateId] = useState(null);

  useEffect(() => {
    if (!currentUser) setCartItems({ totalCartPrice: 0, cart: [] });
  }, [currentUser]);

  const fetchCart = async () => {
    try {
      setIsCartLoading(true);
      if (!currentUser) { setIsCartLoading(false); return; }
      const res = await api.get('/api/cart/get');
      setCartItems({ cart: res.data.cart, totalCartPrice: res.data.totalCartPrice });
    } catch (error) {
      if (error.response?.status !== 403) {
        Feedback.show({ type: 'error', text1: 'Error', text2: error.response?.data?.msg || 'Failed to fetch cart' });
      }
    } finally {
      setIsCartLoading(false);
    }
  };

  const handleRemoveCartItem = async (id) => {
    try {
      setQtyUpdateId(id);
      const res = await api.delete(`/api/cart/remove/${id}`);
      setCartItems({ cart: res.data.cart, totalCartPrice: res.data.totalCartPrice });
      Feedback.show({ type: 'info', text1: 'Removed', text2: res.data?.msg || 'Item removed from your cart' });
    } catch {} finally { setQtyUpdateId(null); }
  };

  const optionsKeyOf = (opts) => opts ? Object.keys(opts).filter(k => opts[k]).sort().map(k => `${k}:${opts[k]}`).join('|') : '';

  const handleAddToCart = async (id, selectedColor = null, selectedOptions = null, productHint = null) => {
    if (!currentUser) {
      Feedback.show({ type: 'info', text1: 'Login Required', text2: 'Please login to add items to cart' });
      return;
    }
    const myKey = optionsKeyOf(selectedOptions);
    const isInCart = cartItems?.cart?.some(
      (item) => item?.product?._id === id &&
                (item.selectedColor || null) === (selectedColor || null) &&
                optionsKeyOf(item.selectedOptions) === myKey
    ) || false;
    if (isInCart) { await handleRemoveCartItem(id); return; }

    setIsCartLoading(true);
    setLoadingProductId(id);

    const previousCart = cartItems;
    if (productHint) {
      const tempLine = {
        _id: `__optim_${id}_${Date.now()}`, qty: 1, selectedColor: selectedColor || null, selectedOptions: selectedOptions || undefined,
        product: { ...productHint, _id: id }, __optimistic: true,
      };
      setCartItems({
        cart: [...(cartItems?.cart || []), tempLine],
        totalCartPrice: (cartItems?.totalCartPrice || 0) + (productHint.discountedPrice || productHint.price || 0),
      });
    }

    hapticImpact(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const res = await api.post(`/api/cart/add/${id}`, { selectedColor, selectedOptions: selectedOptions || undefined });
      Feedback.show({ type: 'success', text1: 'Added', text2: res.data.msg });
      setCartItems({ cart: res.data.cart, totalCartPrice: res.data.totalCartPrice });
    } catch (error) {
      setCartItems(previousCart);
      Feedback.show({ type: 'error', text1: 'Error', text2: error.response?.data?.msg || 'Failed to add to cart' });
    } finally {
      setIsCartLoading(false);
      setLoadingProductId(null);
    }
  };

  const handleQtyInc = async (id) => {
    try {
      setQtyUpdateId(id);
      const res = await api.patch(`/api/cart/qty-inc/${id}`, {});
      setCartItems({ cart: res.data.cart, totalCartPrice: res.data.totalCartPrice });
    } catch (error) {
      Feedback.show({ type: 'error', text1: 'Error', text2: error?.response?.data?.msg || 'Failed to increase quantity' });
    } finally { setQtyUpdateId(null); }
  };

  const handleQtyDec = async (id) => {
    try {
      setQtyUpdateId(id);
      const res = await api.patch(`/api/cart/qty-dec/${id}`, {});
      setCartItems({ cart: res.data.cart, totalCartPrice: res.data.totalCartPrice });
    } catch (error) {
      Feedback.show({ type: 'error', text1: 'Error', text2: error?.response?.data?.msg || 'Failed to decrease quantity' });
    } finally { setQtyUpdateId(null); }
  };

  return (
    <CartContext.Provider value={{
      cartItems, fetchCart, handleAddToCart, handleQtyInc, handleQtyDec, handleRemoveCartItem,
      isCartLoading, loadingProductId, qtyUpdateId,
    }}>
      {children}
    </CartContext.Provider>
  );
};

export const useCart = () => {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within CartProvider');
  return ctx;
};
