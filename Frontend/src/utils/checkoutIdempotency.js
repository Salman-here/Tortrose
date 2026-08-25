export const CHECKOUT_ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return typeof value === 'string' ? value.trim() : value;
};

const requestedQuantity = (value) => (
  value === undefined || value === null || value === '' ? 1 : Number(value)
);

const canonicalShippingInfo = (shippingInfo) => {
  const normalized = canonicalize(shippingInfo || {});
  if (typeof normalized.email === 'string') normalized.email = normalized.email.toLowerCase();
  return normalized;
};

/**
 * Mirrors Backend/services/checkoutIdempotencyService.js, but returns the
 * canonical JSON directly because the client only needs stable equality.
 * Server-derived prices, totals, rates, and delivery estimates are excluded.
 */
export const createCheckoutFingerprint = (
  order = {},
  paymentFlow = order?.paymentFlow ?? 'checkout_session',
  clientSurface = order?.clientSurface ?? (order?.platform === 'mobile' ? 'mobile' : 'web'),
) => {
  const items = (Array.isArray(order?.orderItems) ? order.orderItems : []).map((item) => ({
    id: String(item?.id || item?.productId || ''),
    quantity: requestedQuantity(item?.quantity),
    selectedColor: item?.selectedColor || null,
    selectedOptions: canonicalize(item?.selectedOptions || {}),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  const coupons = (Array.isArray(order?.appliedCoupons) ? order.appliedCoupons : []).map((coupon) => ({
    id: String(coupon?.couponId || coupon?._id || ''),
    code: String(coupon?.code || '').trim().toUpperCase(),
    applicableProductIds: [...new Set((Array.isArray(coupon?.applicableProductIds) ? coupon.applicableProductIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean))].sort(),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  const sellerShipping = (Array.isArray(order?.sellerShipping) ? order.sellerShipping : []).map((entry) => ({
    seller: String(entry?.seller || ''),
    method: String(entry?.shippingMethod?.name || entry?.shippingMethod?.type || '').trim().toLowerCase(),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  return JSON.stringify(canonicalize({
    items,
    coupons,
    currency: String(order?.currency || 'USD').trim().toUpperCase(),
    shippingInfo: canonicalShippingInfo(order?.shippingInfo),
    buyerLocation: order?.buyerLocation || {},
    shippingMethod: {
      seller: String(order?.shippingMethod?.seller || ''),
      method: String(order?.shippingMethod?.name || order?.shippingMethod?.type || '').trim().toLowerCase(),
    },
    sellerShipping,
    paymentMethod: order?.paymentMethod || '',
    instructions: order?.instructions || '',
    paymentFlow,
    clientSurface,
  }));
};

export const isFreshCheckoutAttempt = (attempt, now = Date.now()) => (
  Number(attempt?.createdAt) > now - CHECKOUT_ATTEMPT_MAX_AGE_MS
  && Number(attempt?.createdAt) <= now
);
