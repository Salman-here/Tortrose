import {
  SUPPORTED_CURRENCY_CODES,
  roundCurrencyAmount,
  toCurrencyMinorUnits,
} from './currencySafety';

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

const productCurrency = (product) => {
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
  // Historic carts could omit quantity; those rows always represented one
  // unit. A present value must never be coerced into that legacy default.
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
  if (!Array.isArray(items)) throw cartIntegrityError('The stored guest cart is invalid.');

  let currency = null;
  let mixedCurrency = false;
  let totalMinor = 0n;
  items.forEach((item) => {
    const lineCurrency = productCurrency(item?.product);
    currency = currency || lineCurrency;
    if (currency !== lineCurrency) mixedCurrency = true;

    totalMinor += BigInt(toCurrencyMinorUnits(effectiveGuestProductPrice(item?.product)))
      * BigInt(getCartPresentationQuantity(item));
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

export const normalizeServerCartPayload = (payload) => {
  if (!Array.isArray(payload?.cart)) {
    throw cartIntegrityError('The server returned invalid cart items.');
  }
  // Validate every authoritative line before it reaches render or checkout.
  // The native-currency subtotal is intentionally ignored because the server
  // total is already converted into the buyer's account currency.
  guestCartPresentationTotal(payload.cart);
  getCartPresentationItemCount(payload.cart);
  return {
    cart: payload.cart,
    totalCartPrice: requireExactMoney(payload?.totalCartPrice, 'cart total'),
    totalCartCurrency: requireCurrency(payload?.totalCartCurrency, 'cart currency'),
  };
};
