import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  effectiveGuestProductPrice,
  getCartPresentationQuantity,
  guestCartPresentationTotal,
} from './cartPresentation';

export const GUEST_CART_STORAGE_KEY = '@rozare/guest-cart/v1';

const hasSelectionValue = (value) => (
  value !== undefined
  && value !== null
  && String(value).trim() !== ''
);

export const normalizeSelectedOptions = (options) => {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return undefined;

  const normalizedEntries = Object.entries(options)
    .filter(([key, value]) => String(key).trim() && hasSelectionValue(value))
    .map(([key, value]) => [String(key).trim(), String(value).trim()])
    .sort(([left], [right]) => left.localeCompare(right));

  return normalizedEntries.length > 0
    ? Object.fromEntries(normalizedEntries)
    : undefined;
};

export const optionsKeyOf = (options) => JSON.stringify(
  Object.entries(normalizeSelectedOptions(options) || {})
);

export const cartLineIdentity = (productId, selectedColor = null, selectedOptions = null) => (
  `${String(productId || '')}::${selectedColor ? String(selectedColor).trim() : ''}::${optionsKeyOf(selectedOptions)}`
);

const hashIdentity = (identity) => {
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

export const guestLineId = (productId, selectedColor = null, selectedOptions = null) => (
  `guest_${hashIdentity(cartLineIdentity(productId, selectedColor, selectedOptions))}`
);

export const effectiveProductPrice = effectiveGuestProductPrice;

export const calculateGuestCartTotal = (items) => (
  guestCartPresentationTotal(items).totalCartPrice
);

export const calculateGuestCartSummary = guestCartPresentationTotal;

export const normalizeGuestCart = (items) => {
  if (!Array.isArray(items)) return [];

  const linesByIdentity = new Map();

  items.forEach((item) => {
    const product = item?.product;
    const productId = String(item?.productId || product?._id || '').trim();
    if (!productId || !product || typeof product !== 'object') {
      const error = new Error('The stored guest cart contains an invalid product.');
      error.code = 'CART_PRESENTATION_DATA_INVALID';
      throw error;
    }

    const selectedColor = hasSelectionValue(item?.selectedColor)
      ? String(item.selectedColor).trim()
      : null;
    const selectedOptions = normalizeSelectedOptions(item?.selectedOptions);
    const identity = cartLineIdentity(productId, selectedColor, selectedOptions);
    const stock = product.stock;
    if (!Number.isSafeInteger(stock) || stock < 0) {
      const error = new Error('The stored guest cart contains invalid product stock.');
      error.code = 'CART_PRESENTATION_DATA_INVALID';
      throw error;
    }
    const requestedQty = getCartPresentationQuantity(item);
    if (requestedQty > 99) {
      const error = new Error('The stored guest cart quantity exceeds the supported limit.');
      error.code = 'CART_PRESENTATION_DATA_INVALID';
      throw error;
    }
    const existing = linesByIdentity.get(identity);
    const combinedQty = (existing?.qty || 0) + requestedQty;
    if (!Number.isSafeInteger(combinedQty)) {
      const error = new Error('The stored guest cart quantity is outside the supported range.');
      error.code = 'CART_PRESENTATION_DATA_INVALID';
      throw error;
    }
    const qty = stock > 0
      ? Math.min(stock, combinedQty, 99)
      : Math.min(combinedQty, 99);

    linesByIdentity.set(identity, {
      _id: guestLineId(productId, selectedColor, selectedOptions),
      product: { ...product, _id: productId },
      qty,
      selectedColor,
      ...(selectedOptions ? { selectedOptions } : {}),
      __guest: true,
    });
  });

  return [...linesByIdentity.values()];
};

export const readGuestCart = async () => {
  const rawCart = await AsyncStorage.getItem(GUEST_CART_STORAGE_KEY);
  if (!rawCart) return [];
  let parsed;
  try {
    parsed = JSON.parse(rawCart);
  } catch (_) {
    const error = new Error('The stored guest cart could not be read safely.');
    error.code = 'CART_PRESENTATION_DATA_INVALID';
    throw error;
  }
  return normalizeGuestCart(parsed);
};

export const writeGuestCart = async (items) => {
  const normalized = normalizeGuestCart(items);
  await AsyncStorage.setItem(GUEST_CART_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
};

export const clearGuestCart = async () => {
  await AsyncStorage.removeItem(GUEST_CART_STORAGE_KEY);
};

export const guestCartPayload = (items) => (
  normalizeGuestCart(items).map((item) => ({
    productId: item.product._id,
    qty: item.qty,
    selectedColor: item.selectedColor || null,
    ...(item.selectedOptions ? { selectedOptions: item.selectedOptions } : {}),
  }))
);

export const removeGuestCartLine = (items, lineId) => (
  normalizeGuestCart(items).filter((item) => String(item._id) !== String(lineId))
);

export const incrementGuestCartLine = (items, lineId) => {
  let reachedStockLimit = false;
  const cart = normalizeGuestCart(items).map((item) => {
    if (String(item._id) !== String(lineId)) return item;
    const stock = item.product.stock;
    if (stock < 1 || item.qty >= stock || item.qty >= 99) {
      reachedStockLimit = true;
      return item;
    }
    return { ...item, qty: item.qty + 1 };
  });

  return { cart, reachedStockLimit };
};

export const decrementGuestCartLine = (items, lineId) => (
  normalizeGuestCart(items).flatMap((item) => {
    if (String(item._id) !== String(lineId)) return [item];
    if (item.qty <= 1) return [];
    return [{ ...item, qty: item.qty - 1 }];
  })
);
