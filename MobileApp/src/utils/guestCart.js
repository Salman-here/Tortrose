import AsyncStorage from '@react-native-async-storage/async-storage';

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

export const effectiveProductPrice = (product) => {
  const price = Number(product?.price || 0);
  const discountedPrice = Number(product?.discountedPrice || 0);
  return discountedPrice > 0 && discountedPrice < price ? discountedPrice : price;
};

export const calculateGuestCartTotal = (items) => (
  (Array.isArray(items) ? items : []).reduce((total, item) => (
    total + (effectiveProductPrice(item?.product) * Math.max(1, Number(item?.qty) || 1))
  ), 0)
);

export const normalizeGuestCart = (items) => {
  if (!Array.isArray(items)) return [];

  const linesByIdentity = new Map();

  items.forEach((item) => {
    const product = item?.product;
    const productId = String(item?.productId || product?._id || '').trim();
    if (!productId || !product || typeof product !== 'object') return;

    const selectedColor = hasSelectionValue(item?.selectedColor)
      ? String(item.selectedColor).trim()
      : null;
    const selectedOptions = normalizeSelectedOptions(item?.selectedOptions);
    const identity = cartLineIdentity(productId, selectedColor, selectedOptions);
    const stock = Math.max(0, Number(product.stock) || 0);
    const requestedQty = Math.max(1, Math.min(99, Math.floor(Number(item?.qty) || 1)));
    const existing = linesByIdentity.get(identity);
    const combinedQty = (existing?.qty || 0) + requestedQty;
    const qty = stock > 0 ? Math.min(stock, combinedQty) : combinedQty;

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
  try {
    const rawCart = await AsyncStorage.getItem(GUEST_CART_STORAGE_KEY);
    return normalizeGuestCart(rawCart ? JSON.parse(rawCart) : []);
  } catch {
    return [];
  }
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
    const productStock = Number(item.product?.stock);
    const stock = Number.isFinite(productStock) && productStock > 0
      ? productStock
      : 99;
    if (item.qty >= stock) {
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
