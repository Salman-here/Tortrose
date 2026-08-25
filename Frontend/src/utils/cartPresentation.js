import {
  SUPPORTED_CURRENCY_CODES,
  roundCurrencyAmount,
  toCurrencyMinorUnits,
} from './currencySafety.js';

const MAX_REVERSIBLE_CENTS = 5629499534213120n;
const SUPPORTED_CURRENCIES = new Set(SUPPORTED_CURRENCY_CODES);

const cartIntegrityError = (message) => {
  const error = new Error(message);
  error.code = 'CART_PRESENTATION_DATA_INVALID';
  error.statusCode = 409;
  return error;
};

const hasOwn = (value, field) => Boolean(value)
  && typeof value === 'object'
  && Object.prototype.hasOwnProperty.call(value, field);

const requireExactMoney = (value, label) => {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || roundCurrencyAmount(value) !== value
    || (value > 0 && toCurrencyMinorUnits(value) === 0)
  ) throw cartIntegrityError(`The stored ${label} is invalid.`);
  return value;
};

const requireCurrency = (value, label) => {
  if (
    typeof value !== 'string'
    || value !== value.trim().toUpperCase()
    || !SUPPORTED_CURRENCIES.has(value)
  ) throw cartIntegrityError(`The stored ${label} is invalid.`);
  return value;
};

export const getCartPresentationProductCurrency = (product) => {
  const values = ['currency', 'priceCurrency']
    .filter((field) => Object.prototype.hasOwnProperty.call(product || {}, field))
    .map((field) => product[field])
    .filter((value) => value !== undefined)
    .map((value) => requireCurrency(value, 'product currency metadata'));
  if (new Set(values).size > 1) throw cartIntegrityError('The stored product currency metadata conflicts.');
  return values[0] || 'USD';
};

const productMoney = (product, field) => {
  if (!product || typeof product !== 'object') throw cartIntegrityError('The stored product price is invalid.');
  const current = product[field];
  if (current !== null && current !== undefined) return requireExactMoney(current, `product ${field}`);
  const legacy = product[field === 'price' ? 'priceOriginal' : 'discountedPriceOriginal'];
  if (legacy !== null && legacy !== undefined) return requireExactMoney(legacy, `legacy product ${field}`);
  if (field === 'discountedPrice') return 0;
  throw cartIntegrityError('The stored product price is invalid.');
};

export const getCartPresentationQuantity = (item = {}) => {
  const stored = ['qty', 'quantity']
    .filter((field) => hasOwn(item, field))
    .map((field) => item[field])
    .filter((value) => value !== null && value !== undefined);
  if (
    stored.some((value) => !Number.isSafeInteger(value) || value < 1)
    || new Set(stored).size > 1
  ) {
    throw cartIntegrityError('The stored cart quantity is invalid.');
  }
  return stored[0] ?? 1;
};

export const getCartPresentationItemCount = (items) => {
  if (!Array.isArray(items)) throw cartIntegrityError('The stored cart is invalid.');
  return items.reduce((total, item) => {
    const next = total + getCartPresentationQuantity(item);
    if (!Number.isSafeInteger(next)) {
      throw cartIntegrityError('The stored cart item count is outside the supported range.');
    }
    return next;
  }, 0);
};

export const effectiveGuestProductPrice = (product) => {
  const price = productMoney(product, 'price');
  const discountedPrice = productMoney(product, 'discountedPrice');
  return discountedPrice > 0 && discountedPrice < price ? discountedPrice : price;
};

export const guestCartPresentationTotal = (items) => {
  if (!Array.isArray(items)) {
    throw cartIntegrityError('The stored guest cart is invalid.');
  }

  let currency = null;
  let mixedCurrency = false;
  let totalMinor = 0n;
  items.forEach((item) => {
    const lineCurrency = getCartPresentationProductCurrency(item?.product);
    currency = currency || lineCurrency;
    if (currency !== lineCurrency) mixedCurrency = true;

    const lineMinor = BigInt(toCurrencyMinorUnits(effectiveGuestProductPrice(item?.product)))
      * BigInt(getCartPresentationQuantity(item));
    totalMinor += lineMinor;
    if (totalMinor > MAX_REVERSIBLE_CENTS) {
      throw cartIntegrityError('The stored guest cart total is outside the supported range.');
    }
  });

  if (mixedCurrency) return { totalCartPrice: null, totalCartCurrency: null };
  return {
    totalCartPrice: Number(totalMinor) / 100,
    totalCartCurrency: currency,
  };
};

const requireIdentifier = (value, label) => {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw cartIntegrityError(`The stored ${label} is invalid.`);
  }
  return value;
};

const normalizeServerCartLine = (item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw cartIntegrityError('The server returned an invalid cart line.');
  }
  const product = item.product;
  if (!product || typeof product !== 'object' || Array.isArray(product)) {
    throw cartIntegrityError('The server returned an invalid cart product.');
  }
  const lineId = requireIdentifier(item._id, 'cart line identity');
  const productId = requireIdentifier(product._id, 'cart product identity');
  const rawSeller = product.seller;
  const sellerId = typeof rawSeller === 'string'
    ? requireIdentifier(rawSeller, 'cart seller identity')
    : requireIdentifier(rawSeller?._id, 'cart seller identity');
  if (!Number.isSafeInteger(product.stock) || product.stock < 0) {
    throw cartIntegrityError('The stored cart product stock is invalid.');
  }
  const currency = getCartPresentationProductCurrency(product);
  const price = productMoney(product, 'price');
  const discountedPrice = productMoney(product, 'discountedPrice');
  const qty = getCartPresentationQuantity(item);
  return {
    ...item,
    _id: lineId,
    qty,
    product: {
      ...product,
      _id: productId,
      seller: typeof rawSeller === 'string' ? sellerId : { ...rawSeller, _id: sellerId },
      stock: product.stock,
      price,
      discountedPrice,
      currency,
      priceCurrency: currency,
    },
  };
};

export const normalizeServerCartPayload = (payload) => {
  if (!Array.isArray(payload?.cart)) throw cartIntegrityError('The server returned invalid cart items.');
  const cart = payload.cart.map(normalizeServerCartLine);
  guestCartPresentationTotal(cart);
  getCartPresentationItemCount(cart);
  return {
    cart,
    totalCartPrice: requireExactMoney(payload?.totalCartPrice, 'cart total'),
    totalCartCurrency: requireCurrency(payload?.totalCartCurrency, 'cart currency'),
  };
};
