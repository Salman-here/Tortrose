import {
  effectiveGuestProductPrice,
  getCartPresentationProductCurrency,
  getCartPresentationQuantity,
  guestCartPresentationTotal,
} from './cartPresentation.js';

const guestCartError = (message) => {
  const error = new Error(message);
  error.code = 'CART_PRESENTATION_DATA_INVALID';
  error.statusCode = 409;
  return error;
};

const hasSelectionValue = (value) => (
  value !== undefined
  && value !== null
  && String(value).trim() !== ''
);

export const normalizeSelectedOptions = (options) => {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return undefined;
  const entries = Object.entries(options)
    .filter(([key, value]) => String(key).trim() && hasSelectionValue(value))
    .map(([key, value]) => [String(key).trim(), String(value).trim()])
    .sort(([left], [right]) => left.localeCompare(right));
  return entries.length ? Object.fromEntries(entries) : undefined;
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

export const normalizeGuestCart = (items) => {
  if (!Array.isArray(items)) throw guestCartError('The stored guest cart is invalid.');
  const linesByIdentity = new Map();

  items.forEach((item) => {
    const product = item?.product;
    const productId = String(item?.productId || product?._id || '').trim();
    if (!productId || !product || typeof product !== 'object' || Array.isArray(product)) {
      throw guestCartError('The stored guest cart contains an invalid product.');
    }
    if (!Number.isSafeInteger(product.stock) || product.stock < 0) {
      throw guestCartError('The stored guest cart contains invalid product stock.');
    }
    const currency = getCartPresentationProductCurrency(product);
    const effectivePrice = effectiveGuestProductPrice(product);
    const sourcePrice = product.price ?? product.priceOriginal;
    const sourceDiscountedPrice = product.discountedPrice ?? product.discountedPriceOriginal ?? 0;
    const requestedQty = getCartPresentationQuantity(item);
    if (requestedQty > 99) {
      throw guestCartError('The stored guest cart quantity exceeds the supported limit.');
    }

    const selectedColor = hasSelectionValue(item?.selectedColor)
      ? String(item.selectedColor).trim()
      : null;
    const selectedOptions = normalizeSelectedOptions(item?.selectedOptions);
    const identity = cartLineIdentity(productId, selectedColor, selectedOptions);
    const existing = linesByIdentity.get(identity);
    if (
      existing
      && (
        existing.product.stock !== product.stock
        || getCartPresentationProductCurrency(existing.product) !== currency
        || effectiveGuestProductPrice(existing.product) !== effectivePrice
        || (existing.product.price ?? existing.product.priceOriginal) !== sourcePrice
        || (existing.product.discountedPrice ?? existing.product.discountedPriceOriginal ?? 0) !== sourceDiscountedPrice
      )
    ) {
      throw guestCartError('Duplicate guest cart lines contain conflicting product data.');
    }
    const combinedQty = (existing?.qty || 0) + requestedQty;
    if (!Number.isSafeInteger(combinedQty)) {
      throw guestCartError('The stored guest cart quantity is outside the supported range.');
    }
    const qty = product.stock > 0
      ? Math.min(product.stock, combinedQty, 99)
      : Math.min(combinedQty, 99);

    linesByIdentity.set(identity, {
      _id: guestLineId(productId, selectedColor, selectedOptions),
      product: {
        ...product,
        _id: productId,
        currency,
        priceCurrency: currency,
      },
      qty,
      selectedColor,
      ...(selectedOptions ? { selectedOptions } : {}),
      __guest: true,
    });
  });

  const normalized = [...linesByIdentity.values()];
  guestCartPresentationTotal(normalized);
  return normalized;
};

export const parseStoredGuestCart = (rawCart) => {
  if (typeof rawCart !== 'string' || !rawCart) return [];
  let parsed;
  try {
    parsed = JSON.parse(rawCart);
  } catch (_) {
    throw guestCartError('The stored guest cart could not be read safely.');
  }
  return normalizeGuestCart(parsed);
};

export const serializeGuestCart = (items) => JSON.stringify(normalizeGuestCart(items));

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
