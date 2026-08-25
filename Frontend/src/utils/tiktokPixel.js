import {
  addCurrencyAmounts,
  currencyCodeIsSupported,
  multiplyCurrencyAmount,
  normalizeCurrencyCode,
  roundCurrencyAmount,
} from './currencySafety.js';

const DEFAULT_CURRENCY = 'USD';

const hasTikTokPixel = () =>
  typeof window !== 'undefined' &&
  window.ttq &&
  typeof window.ttq.track === 'function';

const hasMetaPixel = () =>
  typeof window !== 'undefined' &&
  window.fbq &&
  typeof window.fbq === 'function';

const normalizeForHash = (value) => String(value || '').trim().toLowerCase();

const hashSha256 = async (value) => {
  const normalized = normalizeForHash(value);
  if (!normalized || typeof crypto === 'undefined' || !crypto.subtle) return null;

  const data = new TextEncoder().encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

const cleanPayload = (payload) => {
  const cleaned = {};
  Object.entries(payload || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value) && value.length === 0) return;
    cleaned[key] = value;
  });
  return cleaned;
};

const getCookie = (name) => {
  if (typeof document === 'undefined') return undefined;
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.cookie.match(new RegExp(`(?:^|; )${escapedName}=([^;]*)`));
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

const setTrackingCookie = (name, value, maxAgeSeconds) => {
  if (typeof window === 'undefined' || !value) return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/; SameSite=Lax${secure}`;
};

const createMetaFbc = (fbclid) => {
  const cleanFbclid = String(fbclid || '').trim();
  if (!cleanFbclid) return undefined;
  return `fb.1.${Date.now()}.${cleanFbclid}`;
};

export const createTikTokEventId = (prefix = 'event') => {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${random}`;
};

export const getTikTokTrackingContext = () => {
  if (typeof window === 'undefined') return {};

  const searchParams = new URLSearchParams(window.location.search);
  const fbclid = searchParams.get('fbclid');
  return cleanPayload({
    pageUrl: window.location.href,
    referrer: document.referrer,
    ttclid: searchParams.get('ttclid') || getCookie('ttclid'),
    ttp: getCookie('_ttp'),
    fbclid,
    fbc: getCookie('_fbc') || createMetaFbc(fbclid),
    fbp: getCookie('_fbp'),
  });
};

export const captureTikTokClickId = () => {
  if (typeof window === 'undefined') return;
  const searchParams = new URLSearchParams(window.location.search);
  const ttclid = searchParams.get('ttclid');
  const fbclid = searchParams.get('fbclid');

  if (ttclid) {
    setTrackingCookie('ttclid', ttclid, 60 * 60 * 24 * 30);
  }

  if (fbclid && !getCookie('_fbc')) {
    setTrackingCookie('_fbc', createMetaFbc(fbclid), 60 * 60 * 24 * 90);
  }
};

const strictExactNonNegativeMoney = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return roundCurrencyAmount(value) === value ? value : null;
};

const getProductEventCurrency = (product = {}) => {
  const fields = ['currency', 'priceCurrency']
    .filter((field) => Object.prototype.hasOwnProperty.call(product, field))
    .map((field) => product[field]);
  if (fields.length === 0) return DEFAULT_CURRENCY;
  if (fields.some((value) => typeof value !== 'string' || !normalizeEventCurrency(value))) return null;
  const currencies = [...new Set(fields.map((value) => normalizeEventCurrency(value)))];
  return currencies.length === 1 ? currencies[0] : null;
};

const buildProductContent = (product, quantity = 1, price = getProductEventPrice(product)) => {

  return cleanPayload({
    content_id: product?._id || product?.id,
    content_type: 'product',
    content_name: product?.name,
    content_category: product?.category,
    brand: product?.brand,
    price,
    quantity,
  });
};

const getProductEventPrice = (product) => {
  const productPrice = strictExactNonNegativeMoney(product?.price);
  const discountedPrice = product?.discountedPrice === null || product?.discountedPrice === undefined
    ? 0
    : strictExactNonNegativeMoney(product.discountedPrice);
  if (productPrice === null || discountedPrice === null) return null;
  return discountedPrice > 0 && discountedPrice < productPrice ? discountedPrice : productPrice;
};

const normalizeEventCurrency = (currency) => {
  if (typeof currency !== 'string') return null;
  const normalized = normalizeCurrencyCode(currency, '');
  return currencyCodeIsSupported(normalized) ? normalized : null;
};

const getCheckoutEventQuantity = (item) => {
  const quantity = item?.qty ?? item?.quantity ?? 1;
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
};

const getCheckoutEventLineSubtotal = (item, lineTotals, index) => {
  const candidate = Array.isArray(lineTotals) && index < lineTotals.length
    ? lineTotals[index]
    : item?.lineSubtotal;
  return candidate === undefined || candidate === null
    ? null
    : strictExactNonNegativeMoney(candidate);
};

/**
 * Build checkout commerce contents from the exact line allocations already
 * shown by checkout. Native product prices cannot be labelled as the selected
 * checkout currency in a mixed cart, so a missing authoritative line amount
 * deliberately omits price instead of reporting false money.
 */
export const buildCheckoutEventPayload = (options = {}) => {
  const safeOptions = options && typeof options === 'object' && !Array.isArray(options)
    ? options
    : {};
  const {
    orderId,
    cartItems = [],
    lineTotals = [],
    totalAmount = 0,
    currency,
  } = safeOptions;
  const eventCurrency = Object.prototype.hasOwnProperty.call(safeOptions, 'currency')
    ? normalizeEventCurrency(currency)
    : DEFAULT_CURRENCY;
  if (!eventCurrency) return null;
  const contents = (cartItems || [])
    .map((item, index) => {
      const product = item?.product || item;
      const quantity = getCheckoutEventQuantity(item);
      if (quantity === null) return null;
      const lineSubtotal = getCheckoutEventLineSubtotal(item, lineTotals, index);
      return cleanPayload({
        content_id: product?._id || product?.id || item?.productId,
        content_type: 'product',
        content_name: product?.name || item?.name,
        content_category: product?.category || item?.category,
        brand: product?.brand || item?.brand,
        price: lineSubtotal === null ? undefined : lineSubtotal / quantity,
        quantity,
      });
    })
    .filter((content) => content?.content_id);

  const numericTotal = strictExactNonNegativeMoney(totalAmount);
  if (numericTotal === null) return null;
  return cleanPayload({
    contents,
    content_type: contents.length > 0 ? 'product' : undefined,
    content_ids: contents.map((content) => content.content_id),
    order_id: orderId,
    value: numericTotal,
    currency: eventCurrency,
  });
};

const buildSellerSignupPayload = ({
  id = 'seller_account_signup',
  name = 'Rozare Seller Account',
  category = 'Seller Signup',
  value = 1,
} = {}) => {
  const content = cleanPayload({
    content_id: id,
    content_type: 'product',
    content_name: name,
    content_category: category,
    price: value,
    quantity: 1,
  });

  return {
    contents: [content],
    content_type: 'product',
    content_ids: [id],
    content_name: name,
    content_category: category,
    value,
    currency: DEFAULT_CURRENCY,
  };
};

export const trackTikTokPage = () => {
  if (typeof window === 'undefined' || !window.ttq || typeof window.ttq.page !== 'function') return false;
  window.ttq.page();
  return true;
};

const buildApiUrl = (path) => {
  const baseUrl = import.meta.env.VITE_API_URL || '/';
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${normalizedBase}${path.replace(/^\/+/, '')}`;
};

const postBrowserEvent = (path, payload = {}) => {
  if (typeof window === 'undefined') return false;

  const url = buildApiUrl(path);
  const body = JSON.stringify(cleanPayload(payload));
  let isSameOrigin = false;
  try {
    isSameOrigin = new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    isSameOrigin = false;
  }

  if (isSameOrigin && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    const blob = new Blob([body], { type: 'application/json' });
    if (navigator.sendBeacon(url, blob)) return true;
  }

  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    credentials: 'include',
    keepalive: true,
  }).catch(() => {});

  return true;
};

export const trackMetaPageView = () => {
  if (typeof window === 'undefined') return false;

  const eventId = createTikTokEventId('meta_page_view');
  const tracking = getTikTokTrackingContext();

  if (hasMetaPixel()) {
    window.fbq('track', 'PageView', {}, { eventID: eventId });
  }

  postBrowserEvent('api/meta/page-view', {
    eventId,
    pageUrl: window.location.href,
    referrer: document.referrer,
    tracking,
  });

  return true;
};

export const trackTikTokEvent = (eventName, payload = {}, options = {}) => {
  if (!hasTikTokPixel()) return false;
  const eventOptions = cleanPayload(options);
  if (Object.keys(eventOptions).length > 0) {
    window.ttq.track(eventName, cleanPayload(payload), eventOptions);
  } else {
    window.ttq.track(eventName, cleanPayload(payload));
  }
  return true;
};

export const identifyTikTokUser = async ({ email, phone, externalId } = {}) => {
  if (!hasTikTokPixel() || typeof window.ttq.identify !== 'function') return false;

  const [hashedEmail, hashedPhone, hashedExternalId] = await Promise.all([
    email ? hashSha256(email) : null,
    phone ? hashSha256(phone) : null,
    externalId ? hashSha256(externalId) : null,
  ]);

  const identity = cleanPayload({
    email: hashedEmail,
    phone_number: hashedPhone,
    external_id: hashedExternalId,
  });

  if (Object.keys(identity).length === 0) return false;
  window.ttq.identify(identity);
  return true;
};

export const trackSellerPageView = () => {
  trackTikTokEvent('ViewContent', buildSellerSignupPayload({
    id: 'become_seller_page',
    name: 'Become a Seller Page',
    category: 'Seller Registration',
  }));
};

export const trackSellerFormSubmitted = (stepName = 'seller_details') => {
  trackTikTokEvent('SubmitForm', buildSellerSignupPayload({
    id: stepName,
    name: stepName,
    category: 'Seller Signup',
  }));
};

export const trackSellerRegistrationCompleted = async ({ user, storeName, email, phone, eventId } = {}) => {
  const externalId = user?._id || user?.id;
  await identifyTikTokUser({ email: user?.email || email, phone, externalId });

  trackTikTokEvent('CompleteRegistration', buildSellerSignupPayload({
    id: externalId || 'new_seller',
    name: storeName || 'New Seller Store',
    category: 'Seller Signup',
  }), eventId ? { event_id: eventId } : {});

  // Track Meta (Facebook) CompleteRegistration
  if (hasMetaPixel()) {
    window.fbq('track', 'CompleteRegistration', {
      content_name: storeName || 'New Seller Store',
      content_category: 'Seller Signup',
      status: 'seller_account_created',
    });
  }
};

export const trackProductView = (product) => {
  const currency = getProductEventCurrency(product);
  const price = getProductEventPrice(product);
  if (!currency || price === null) return false;
  const content = buildProductContent(product, 1, price);

  return trackTikTokEvent('ViewContent', {
    contents: [content],
    content_type: 'product',
    content_ids: [content.content_id],
    value: price,
    currency,
  });
};

export const trackSearch = ({ searchString, products = [] } = {}) => {
  const eventProducts = (products || [])
    .slice(0, 10)
    .map((product) => ({
      product,
      currency: getProductEventCurrency(product),
      price: getProductEventPrice(product),
    }));
  const currencies = [...new Set(eventProducts.map((entry) => entry.currency).filter(Boolean))];
  const oneCurrency = currencies.length === 1 && eventProducts.every((entry) => (
    entry.currency === currencies[0] && entry.price !== null
  ));
  const contents = eventProducts
    .map(({ product, price }) => buildProductContent(product, 1, oneCurrency ? price : null))
    .filter((content) => content.content_id);
  const value = oneCurrency
    ? addCurrencyAmounts(...eventProducts.map((entry) => entry.price))
    : undefined;

  return trackTikTokEvent('Search', {
    contents,
    content_type: contents.length > 0 ? 'product' : undefined,
    content_ids: contents.map((content) => content.content_id),
    value,
    currency: oneCurrency ? currencies[0] : undefined,
    search_string: searchString,
  });
};

export const trackAddToCart = (product, quantity = 1) => {
  const currency = getProductEventCurrency(product);
  const price = getProductEventPrice(product);
  if (!currency || price === null || !Number.isSafeInteger(quantity) || quantity < 1) return false;
  const content = buildProductContent(product, quantity, price);

  return trackTikTokEvent('AddToCart', {
    contents: [content],
    content_type: 'product',
    content_ids: [content.content_id],
    value: multiplyCurrencyAmount(price, quantity),
    currency,
  });
};

export const trackAddToWishlist = (product) => {
  const currency = getProductEventCurrency(product);
  const price = getProductEventPrice(product);
  if (!currency || price === null) return false;
  const content = buildProductContent(product, 1, price);

  return trackTikTokEvent('AddToWishlist', {
    contents: content.content_id ? [content] : [],
    content_type: content.content_id ? 'product' : undefined,
    content_ids: content.content_id ? [content.content_id] : undefined,
    value: price,
    currency,
  });
};

export const trackInitiateCheckout = (
  cartItems = [],
  totalAmount = 0,
  currency = DEFAULT_CURRENCY,
  lineTotals = [],
) => {
  const payload = buildCheckoutEventPayload({
    cartItems,
    lineTotals,
    totalAmount,
    currency,
  });
  return payload ? trackTikTokEvent('InitiateCheckout', payload) : false;
};

export const trackAddPaymentInfo = ({ cartItems = [], lineTotals = [], totalAmount = 0, currency = DEFAULT_CURRENCY, eventId } = {}) => {
  const payload = buildCheckoutEventPayload({
    cartItems,
    lineTotals,
    totalAmount,
    currency,
  });
  return payload ? trackTikTokEvent('AddPaymentInfo', payload, eventId ? { event_id: eventId } : {}) : false;
};

export const trackPlaceAnOrder = ({ orderId, cartItems = [], lineTotals = [], totalAmount = 0, currency = DEFAULT_CURRENCY, eventId } = {}) => {
  const payload = buildCheckoutEventPayload({
    orderId,
    cartItems,
    lineTotals,
    totalAmount,
    currency,
  });
  return payload ? trackTikTokEvent('PlaceAnOrder', payload, eventId ? { event_id: eventId } : {}) : false;
};

export const trackPurchase = ({ orderId, cartItems = [], lineTotals = [], totalAmount = 0, currency = DEFAULT_CURRENCY, eventId } = {}) => {
  const payload = buildCheckoutEventPayload({
    orderId,
    cartItems,
    lineTotals,
    totalAmount,
    currency,
  });
  return payload ? trackTikTokEvent('Purchase', payload, eventId ? { event_id: eventId } : {}) : false;
};
