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

const buildProductContent = (product, quantity = 1) => {
  const price = getProductEventPrice(product);

  return cleanPayload({
    content_id: product?._id || product?.id,
    content_type: 'product',
    content_name: product?.name,
    content_category: product?.category,
    brand: product?.brand,
    price: price > 0 ? price : undefined,
    quantity,
  });
};

const getProductEventPrice = (product) => {
  const productPrice = Number(product?.price || 0);
  const discountedPrice = Number(product?.discountedPrice || 0);
  return discountedPrice > 0 && discountedPrice < productPrice ? discountedPrice : productPrice;
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
  const price = getProductEventPrice(product);
  const content = buildProductContent(product);

  trackTikTokEvent('ViewContent', {
    contents: [content],
    content_type: 'product',
    content_ids: [content.content_id],
    value: price > 0 ? price : undefined,
    currency: DEFAULT_CURRENCY,
  });
};

export const trackSearch = ({ searchString, products = [] } = {}) => {
  const contents = (products || [])
    .slice(0, 10)
    .map((product) => buildProductContent(product))
    .filter((content) => content.content_id);

  trackTikTokEvent('Search', {
    contents,
    content_type: contents.length > 0 ? 'product' : undefined,
    content_ids: contents.map((content) => content.content_id),
    value: contents.length > 0 ? contents.length : 1,
    currency: DEFAULT_CURRENCY,
    search_string: searchString,
  });
};

export const trackAddToCart = (product, quantity = 1) => {
  const price = getProductEventPrice(product);
  const content = buildProductContent(product, quantity);

  trackTikTokEvent('AddToCart', {
    contents: [content],
    content_type: 'product',
    content_ids: [content.content_id],
    value: price > 0 ? price * quantity : undefined,
    currency: DEFAULT_CURRENCY,
  });
};

export const trackAddToWishlist = (product) => {
  const price = getProductEventPrice(product);
  const content = buildProductContent(product);

  trackTikTokEvent('AddToWishlist', {
    contents: content.content_id ? [content] : [],
    content_type: content.content_id ? 'product' : undefined,
    content_ids: content.content_id ? [content.content_id] : undefined,
    value: price > 0 ? price : undefined,
    currency: DEFAULT_CURRENCY,
  });
};

export const trackInitiateCheckout = (cartItems = [], totalAmount = 0) => {
  const contents = cartItems
    .map((item) => buildProductContent(item.product, item.qty || item.quantity || 1))
    .filter((content) => content.content_id);

  trackTikTokEvent('InitiateCheckout', {
    contents,
    content_type: 'product',
    content_ids: contents.map((content) => content.content_id),
    value: Number(totalAmount) > 0 ? Number(totalAmount) : undefined,
    currency: DEFAULT_CURRENCY,
  });
};

export const trackAddPaymentInfo = ({ cartItems = [], totalAmount = 0, currency = DEFAULT_CURRENCY, eventId } = {}) => {
  const contents = cartItems
    .map((item) => buildProductContent(item.product || item, item.qty || item.quantity || 1))
    .filter((content) => content.content_id);

  trackTikTokEvent('AddPaymentInfo', {
    contents,
    content_type: contents.length > 0 ? 'product' : undefined,
    content_ids: contents.map((content) => content.content_id),
    value: Number(totalAmount) > 0 ? Number(totalAmount) : undefined,
    currency,
  }, eventId ? { event_id: eventId } : {});
};

export const trackPlaceAnOrder = ({ orderId, cartItems = [], totalAmount = 0, currency = DEFAULT_CURRENCY, eventId } = {}) => {
  const contents = cartItems
    .map((item) => buildProductContent(item.product || item, item.qty || item.quantity || 1))
    .filter((content) => content.content_id);

  trackTikTokEvent('PlaceAnOrder', {
    contents,
    content_type: contents.length > 0 ? 'product' : undefined,
    content_ids: contents.map((content) => content.content_id),
    order_id: orderId,
    value: Number(totalAmount) > 0 ? Number(totalAmount) : undefined,
    currency,
  }, eventId ? { event_id: eventId } : {});
};

export const trackPurchase = ({ orderId, cartItems = [], totalAmount = 0, currency = DEFAULT_CURRENCY, eventId } = {}) => {
  const contents = cartItems
    .map((item) => buildProductContent(item.product || item, item.qty || item.quantity || 1))
    .filter((content) => content.content_id);

  trackTikTokEvent('Purchase', {
    contents,
    content_type: contents.length > 0 ? 'product' : undefined,
    content_ids: contents.map((content) => content.content_id),
    order_id: orderId,
    value: Number(totalAmount) > 0 ? Number(totalAmount) : undefined,
    currency,
  }, eventId ? { event_id: eventId } : {});
};
