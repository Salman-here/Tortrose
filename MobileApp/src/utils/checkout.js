const toId = (value) => value?._id?.toString?.() || value?.toString?.() || '';

export const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

export const getCartItemQuantity = (item) => Math.max(1, Number(item?.qty || item?.quantity) || 1);

export const getCartItemSellerId = (item) => toId(item?.product?.seller);

export const getSellerDisplayName = (sellerData, fallback = 'Store') => (
  sellerData?.store?.storeName
  || sellerData?.seller?.storeName
  || sellerData?.seller?.username
  || fallback
);

export const selectDefaultShippingMethods = (sellerMap = {}, previousSelections = {}) => {
  const selections = {};

  Object.entries(sellerMap || {}).forEach(([sellerId, sellerData]) => {
    const methods = (sellerData?.methods || []).filter((method) => method?.isActive !== false);
    if (!methods.length) return;

    const previousType = previousSelections?.[sellerId]?.type || previousSelections?.[sellerId]?.name;
    const previous = methods.find((method) => method.type === previousType);
    selections[sellerId] = previous || methods.find((method) => method.type === 'free') || methods[0];
  });

  return selections;
};

export const buildSellerShipping = ({ sellerMap = {}, selections = {}, convertShippingCost }) => {
  const sellerIds = Object.keys(sellerMap || {});
  const missingSellerIds = sellerIds.filter((sellerId) => !selections?.[sellerId]);
  if (!sellerIds.length || missingSellerIds.length) {
    return { valid: false, missingSellerIds, sellerShipping: [], shippingCost: 0 };
  }

  const sellerShipping = sellerIds.map((sellerId) => {
    const method = selections[sellerId];
    const price = roundMoney(convertShippingCost(method, sellerMap[sellerId]));
    return {
      seller: sellerId,
      shippingMethod: {
        name: method.type || method.name,
        price,
        estimatedDays: Math.max(1, Number(method.deliveryDays || method.estimatedDays) || 5),
      },
    };
  });

  return {
    valid: true,
    missingSellerIds: [],
    sellerShipping,
    shippingCost: roundMoney(sellerShipping.reduce((sum, entry) => sum + entry.shippingMethod.price, 0)),
  };
};

const normalizeCouponList = (appliedCoupons) => (
  Array.isArray(appliedCoupons) ? appliedCoupons : Object.values(appliedCoupons || {})
);

export const getClaimedCouponProductIds = (appliedCoupons) => new Set(
  normalizeCouponList(appliedCoupons)
    .flatMap((coupon) => coupon?.applicableProductIds || [])
    .map(toId)
    .filter(Boolean)
);

export const findCouponOverlap = (coupon, appliedCoupons) => {
  const claimed = getClaimedCouponProductIds(appliedCoupons);
  return (coupon?.applicableProductIds || []).map(toId).filter(Boolean).filter((id) => claimed.has(id));
};

/**
 * Mirrors the server's coupon math. A fixed coupon is applied once to its
 * complete eligible subtotal, then proportionally allocated across its lines.
 */
export const calculateCouponPricing = ({
  appliedCoupons = [],
  cartItems = [],
  getItemPrice,
  convertCouponAmount,
}) => {
  const lineDiscounts = new Map();
  const couponDiscounts = [];
  let totalDiscount = 0;

  normalizeCouponList(appliedCoupons).forEach((coupon) => {
    const applicableIds = new Set((coupon?.applicableProductIds || []).map(toId).filter(Boolean));
    const eligibleLines = cartItems
      .map((item, index) => ({
        item,
        key: toId(item?._id) || `${toId(item?.product?._id)}:${index}`,
        productId: toId(item?.product?._id),
        subtotal: roundMoney(getItemPrice(item) * getCartItemQuantity(item)),
      }))
      .filter((line) => applicableIds.has(line.productId) && line.subtotal > 0);
    const eligibleSubtotal = roundMoney(eligibleLines.reduce((sum, line) => sum + line.subtotal, 0));
    if (!eligibleSubtotal) return;

    let discount = coupon.discountType === 'percentage'
      ? eligibleSubtotal * Math.max(0, Number(coupon.discountValue) || 0) / 100
      : convertCouponAmount(coupon.discountValue, coupon);
    if (Number(coupon.maxDiscountAmount || 0) > 0) {
      discount = Math.min(discount, convertCouponAmount(coupon.maxDiscountAmount, coupon));
    }
    discount = roundMoney(Math.min(eligibleSubtotal, Math.max(0, discount)));
    if (!discount) return;

    let allocated = 0;
    eligibleLines.forEach((line, index) => {
      const amount = index === eligibleLines.length - 1
        ? roundMoney(discount - allocated)
        : roundMoney(discount * line.subtotal / eligibleSubtotal);
      allocated = roundMoney(allocated + amount);
      lineDiscounts.set(line.key, roundMoney((lineDiscounts.get(line.key) || 0) + amount));
    });

    couponDiscounts.push({ coupon, eligibleSubtotal, discount });
    totalDiscount = roundMoney(totalDiscount + discount);
  });

  return { totalDiscount, couponDiscounts, lineDiscounts };
};

export const createCheckoutAttemptKey = (randomUUID) => {
  const entropy = typeof randomUUID === 'function'
    ? randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `mobile-checkout:${entropy}`;
};

export const parsePaymentRedirect = (url = '') => {
  const [base, query = ''] = String(url).split('?');
  const params = {};
  query.split('&').filter(Boolean).forEach((entry) => {
    const [rawKey, ...rawValue] = entry.split('=');
    params[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue.join('=') || '');
  });
  const normalizedBase = base.toLowerCase();
  return {
    type: normalizedBase.includes('payment-success')
      ? 'success'
      : normalizedBase.includes('payment-cancel')
        ? 'cancel'
        : 'unknown',
    sessionId: params.session_id || params.sessionId || '',
    orderId: params.orderId || params.order_id || '',
    params,
  };
};

export const normalizePaymentStatus = (payload = {}) => {
  const data = payload?.data || payload;
  const order = data?.order || {};
  const raw = String(
    data?.status
    || data?.paymentStatus
    || order?.paymentStatus
    || order?.status
    || ''
  ).toLowerCase();

  if (data?.isPaid === true || order?.isPaid === true || ['paid', 'complete', 'completed', 'succeeded', 'success'].includes(raw)) {
    return 'paid';
  }
  if (['failed', 'expired'].includes(raw)) return 'failed';
  if (['cancelled', 'canceled'].includes(raw) || order?.orderStatus === 'cancelled') return 'cancelled';
  return 'pending';
};

export const verifyOrderPayment = async ({
  apiClient,
  orderId,
  sessionId,
  attempts = 5,
  delayMs = 1200,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
}) => {
  if (!orderId) {
    return { status: 'pending', reason: 'missing_reference' };
  }

  let lastPayload = null;
  let lastError = null;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      const response = await apiClient.get(
        `/api/order/payment-status/${encodeURIComponent(orderId)}`,
        { params: sessionId ? { sessionId } : {} }
      );
      lastPayload = response?.data || response;
      const status = normalizePaymentStatus(lastPayload);
      if (status !== 'pending') return { status, payload: lastPayload };
    } catch (error) {
      lastError = error;
      if (error?.response?.status >= 400 && error?.response?.status < 500 && error?.response?.status !== 408) {
        return { status: 'failed', error, reason: 'verification_rejected' };
      }
    }
    if (attempt < attempts - 1) await sleep(delayMs);
  }

  return { status: 'pending', payload: lastPayload, error: lastError };
};
