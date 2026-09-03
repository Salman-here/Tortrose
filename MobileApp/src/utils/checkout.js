import { runPaymentSheet } from './stripePaymentSheet';
import {
  addCurrencyAmounts,
  allocateCurrencyAmount,
  allocateConvertedCurrencyAmounts,
  convertCurrencyAmount,
  currencyCodeIsSupported,
  multiplyCurrencyAmount,
  normalizeCurrencyCode,
  percentageCurrencyAmount,
  roundCurrencyAmount,
  toCurrencyMinorUnits,
} from './currencySafety';
import {
  clearPersistedMutationAttemptForFingerprint,
  getOrCreatePersistedMutationAttemptForFingerprint,
} from './persistedMutationAttempt';
import { getCartPresentationQuantity } from './cartPresentation';

const toId = (value) => value?._id?.toString?.() || value?.toString?.() || '';

export const CHECKOUT_ATTEMPT_STORAGE_KEY = 'rozare_checkout_attempt_v1';
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

const requestedQuantity = (value) => getCartPresentationQuantity({ quantity: value });

const canonicalShippingInfo = (shippingInfo) => {
  const normalized = canonicalize(shippingInfo || {});
  if (typeof normalized.email === 'string') normalized.email = normalized.email.toLowerCase();
  return normalized;
};

export const roundMoney = roundCurrencyAmount;

export const getCartItemQuantity = getCartPresentationQuantity;

export const getCartItemSellerId = (item) => toId(item?.product?.seller);

export const getSellerDisplayName = (sellerData, fallback = 'Store') => (
  sellerData?.store?.storeName
  || sellerData?.seller?.storeName
  || sellerData?.seller?.username
  || fallback
);

export const getSellerLogo = (sellerData) => {
  const logo = sellerData?.store?.logo || sellerData?.seller?.storeLogo || sellerData?.seller?.logo;
  return typeof logo === 'string' && logo.trim().length <= 4096 ? logo.trim() : '';
};

export const parseCheckoutTaxConfigResponse = (payload = {}) => {
  const response = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  if (
    response?.success !== true
    || !response?.taxConfig
    || typeof response.taxConfig !== 'object'
    || Array.isArray(response.taxConfig)
  ) {
    throw new Error('Tax configuration could not be confirmed.');
  }

  const config = response.taxConfig;
  const type = config.type;
  if (!['none', 'percentage', 'fixed'].includes(type)) {
    throw new Error('Tax configuration has an unsupported type.');
  }
  const value = config.value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Tax configuration has an invalid value.');
  }
  if (type === 'none') {
    if (value !== 0 || config.currency !== 'USD') {
      throw new Error('Disabled tax configuration is not canonical.');
    }
    return { ...config, type, value, currency: 'USD' };
  }
  if (type === 'percentage') {
    if (
      value > 100
      || roundCurrencyAmount(value, 6) !== value
      || config.currency !== 'USD'
    ) {
      throw new Error('Tax percentage is outside the supported range or is not canonical.');
    }
    return { ...config, type, value, currency: 'USD' };
  }

  const taxCurrency = config.currency;
  let fixedAmountIsExact = false;
  try {
    fixedAmountIsExact = roundCurrencyAmount(value) === value
      && toCurrencyMinorUnits(value) >= 0;
  } catch (_) {
    fixedAmountIsExact = false;
  }
  if (
    typeof taxCurrency !== 'string'
    || taxCurrency !== taxCurrency.trim().toUpperCase()
    || !currencyCodeIsSupported(taxCurrency)
    || !fixedAmountIsExact
  ) {
    throw new Error('Fixed tax configuration has an invalid amount or currency.');
  }
  return { ...config, type, value, currency: taxCurrency };
};

const shippingMoneyIsExact = (value, { allowZero }) => (
  typeof value === 'number'
  && Number.isFinite(value)
  && (allowZero ? value >= 0 : value > 0)
  && roundCurrencyAmount(value) === value
  && (value === 0 || toCurrencyMinorUnits(value) !== 0)
);

const checkoutShippingMethodIsValid = (method) => {
  if (!method || typeof method !== 'object' || Array.isArray(method)) return false;
  if (!['free', 'standard', 'fast'].includes(method.type) || method.isActive !== true) return false;
  if (!Number.isSafeInteger(method.deliveryDays) || method.deliveryDays < 1) return false;
  if (
    typeof method.currency !== 'string'
    || method.currency !== method.currency.trim().toUpperCase()
    || !currencyCodeIsSupported(method.currency)
    || method.costCurrency !== method.currency
  ) return false;
  const isFree = method.type === 'free';
  if (!shippingMoneyIsExact(method.cost, { allowZero: isFree })) return false;
  if (!shippingMoneyIsExact(method.costInputAmount, { allowZero: isFree })) return false;
  return isFree ? method.cost === 0 && method.costInputAmount === 0 : true;
};

export const parseCheckoutShippingMethodsResponse = (payload = {}, expectedSellerIds = []) => {
  const response = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  if (
    response?.success !== true
    || !response?.shippingMethods
    || typeof response.shippingMethods !== 'object'
    || Array.isArray(response.shippingMethods)
  ) {
    throw new Error('Delivery methods could not be confirmed.');
  }
  if (!Array.isArray(expectedSellerIds) || expectedSellerIds.length === 0) {
    throw new Error('Delivery sellers could not be confirmed.');
  }
  const expected = [...new Set(expectedSellerIds)];
  if (expected.some((sellerId) => (
    typeof sellerId !== 'string' || !sellerId || sellerId !== sellerId.trim()
  ))) {
    throw new Error('Delivery sellers could not be confirmed.');
  }

  const sellerMap = response.shippingMethods;
  const returnedSellerIds = Object.keys(sellerMap);
  const sortedExpected = [...expected].sort();
  if (
    returnedSellerIds.length !== expected.length
    || [...returnedSellerIds].sort().some((sellerId, index) => sellerId !== sortedExpected[index])
  ) {
    throw new Error('Delivery methods do not match every seller in this cart.');
  }

  const verified = {};
  expected.forEach((sellerId) => {
    const sellerData = sellerMap[sellerId];
    if (!sellerData || typeof sellerData !== 'object' || Array.isArray(sellerData)) {
      throw new Error('A seller delivery configuration is invalid.');
    }
    if (
      !sellerData.seller
      || typeof sellerData.seller !== 'object'
      || Array.isArray(sellerData.seller)
      || typeof sellerData.seller._id !== 'string'
      || sellerData.seller._id !== sellerId
    ) {
      throw new Error('A delivery configuration has an invalid seller identity.');
    }
    if (
      !['online_and_cod', 'advance_only'].includes(sellerData.paymentPolicy)
      || typeof sellerData.allowsCashOnDelivery !== 'boolean'
      || sellerData.allowsCashOnDelivery !== (sellerData.paymentPolicy === 'online_and_cod')
    ) {
      throw new Error('A seller payment policy could not be confirmed.');
    }
    if (
      !Array.isArray(sellerData.methods)
      || sellerData.methods.length < 1
      || sellerData.methods.length > 3
      || sellerData.methods.some((method) => !checkoutShippingMethodIsValid(method))
      || new Set(sellerData.methods.map((method) => method.type)).size !== sellerData.methods.length
    ) {
      throw new Error('A seller delivery method contains invalid pricing or timing data.');
    }
    verified[sellerId] = {
      ...sellerData,
      seller: { ...sellerData.seller },
      ...(sellerData.store && typeof sellerData.store === 'object' && !Array.isArray(sellerData.store)
        ? { store: { ...sellerData.store, logo: getSellerLogo(sellerData) } }
        : {}),
      methods: sellerData.methods.map((method) => ({ ...method })),
    };
  });
  return verified;
};

const checkoutCouponTermsAreValid = (coupon) => {
  if (!coupon || typeof coupon !== 'object' || Array.isArray(coupon)) return false;
  if (typeof coupon._id !== 'string' || !coupon._id || coupon._id !== coupon._id.trim()) return false;
  if (
    typeof coupon.code !== 'string'
    || !/^[A-Z0-9_-]{3,32}$/u.test(coupon.code)
    || !['fixed', 'percentage'].includes(coupon.discountType)
    || typeof coupon.currency !== 'string'
    || coupon.currency !== coupon.currency.trim().toUpperCase()
    || !currencyCodeIsSupported(coupon.currency)
    || !['all', 'selected'].includes(coupon.applicableTo)
  ) return false;
  if (coupon.discountType === 'fixed') {
    if (!shippingMoneyIsExact(coupon.discountValue, { allowZero: false })) return false;
  } else if (
    typeof coupon.discountValue !== 'number'
    || !Number.isFinite(coupon.discountValue)
    || coupon.discountValue <= 0
    || coupon.discountValue > 100
    || roundCurrencyAmount(coupon.discountValue, 6) !== coupon.discountValue
  ) return false;
  if (!shippingMoneyIsExact(coupon.minOrderAmount, { allowZero: true })) return false;
  if (
    coupon.maxDiscountAmount !== null
    && coupon.maxDiscountAmount !== undefined
    && !shippingMoneyIsExact(coupon.maxDiscountAmount, { allowZero: false })
  ) return false;
  return true;
};

const exactIdentifierList = (values, { allowEmpty = true } = {}) => (
  Array.isArray(values)
  && (allowEmpty || values.length > 0)
  && values.every((value) => typeof value === 'string' && value && value === value.trim())
  && new Set(values).size === values.length
);

export const parseCheckoutCouponAvailabilityResponse = (payload = {}, expectedSellerIds = []) => {
  const response = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  if (
    !response
    || typeof response !== 'object'
    || Array.isArray(response)
    || !response.sellerCoupons
    || typeof response.sellerCoupons !== 'object'
    || Array.isArray(response.sellerCoupons)
    || !exactIdentifierList(expectedSellerIds, { allowEmpty: false })
  ) {
    throw new Error('Available coupons could not be confirmed.');
  }
  const expectedSellerSet = new Set(expectedSellerIds);
  const seenCouponIds = new Set();
  const verified = {};
  Object.entries(response.sellerCoupons).forEach(([sellerId, coupons]) => {
    if (!expectedSellerSet.has(sellerId) || !Array.isArray(coupons)) {
      throw new Error('Available coupons do not match this cart.');
    }
    verified[sellerId] = coupons.map((coupon) => {
      if (
        !checkoutCouponTermsAreValid(coupon)
        || seenCouponIds.has(coupon._id)
        || !exactIdentifierList(coupon.applicableProducts)
        || (coupon.applicableTo === 'selected' && coupon.applicableProducts.length === 0)
      ) {
        throw new Error('An available coupon contains invalid terms.');
      }
      seenCouponIds.add(coupon._id);
      return { ...coupon, applicableProducts: [...coupon.applicableProducts] };
    });
  });
  return verified;
};

export const parseValidatedCheckoutCouponResponse = (
  payload = {},
  { expectedSellerIds = [], expectedProductIds = [] } = {},
) => {
  const response = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const coupon = response?.coupon;
  if (
    response?.valid !== true
    || !checkoutCouponTermsAreValid(coupon)
    || !exactIdentifierList(expectedSellerIds, { allowEmpty: false })
    || !exactIdentifierList(expectedProductIds, { allowEmpty: false })
    || typeof coupon.seller !== 'string'
    || !expectedSellerIds.includes(coupon.seller)
    || !exactIdentifierList(coupon.applicableProductIds, { allowEmpty: false })
    || coupon.applicableProductIds.some((productId) => !expectedProductIds.includes(productId))
  ) {
    throw new Error('Coupon terms could not be confirmed.');
  }
  return { ...coupon, applicableProductIds: [...coupon.applicableProductIds] };
};

export const isCheckoutRepriceRequired = (error = {}) => (
  Number(error?.response?.status ?? error?.status) === 409
  && String(error?.response?.data?.code ?? error?.code ?? '') === 'CHECKOUT_REPRICE_REQUIRED'
);

export const isPositiveSourceAmountRoundedToZero = (sourceAmount, targetAmount) => (
  Number.isFinite(Number(sourceAmount))
  && Number(sourceAmount) > 0
  && toCurrencyMinorUnits(sourceAmount) > 0
  && toCurrencyMinorUnits(targetAmount) === 0
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

export const reconcileAppliedCheckoutCoupons = (
  appliedCoupons = [],
  cartItems = [],
  availableCouponsBySeller = null,
) => {
  const productSeller = new Map(
    (Array.isArray(cartItems) ? cartItems : [])
      .map((item) => [toId(item?.product?._id || item?.productId), getCartItemSellerId(item)])
      .filter(([productId, sellerId]) => productId && sellerId)
  );
  const availabilityIsAuthoritative = availableCouponsBySeller !== null
    && typeof availableCouponsBySeller === 'object'
    && !Array.isArray(availableCouponsBySeller);

  return (Array.isArray(appliedCoupons) ? appliedCoupons : Object.values(appliedCoupons || {}))
    .map((coupon) => {
      if (!coupon || typeof coupon !== 'object') return null;
      const couponId = toId(coupon?._id || coupon?.couponId);
      let sellerId = toId(coupon?.seller);
      let productIds = [...new Set((coupon?.applicableProductIds || []).map(toId).filter(Boolean))]
        .filter((productId) => productSeller.has(productId));
      if (!sellerId) {
        const candidateSellers = [...new Set(
          productIds.map((productId) => productSeller.get(productId)).filter(Boolean)
        )];
        if (candidateSellers.length === 1) [sellerId] = candidateSellers;
      }
      if (sellerId) {
        productIds = productIds.filter((productId) => productSeller.get(productId) === sellerId);
      }
      if (!couponId || !sellerId || !productIds.length) return null;

      let refreshedCoupon = coupon;
      if (availabilityIsAuthoritative) {
        const availableCoupon = (availableCouponsBySeller?.[sellerId] || [])
          .find((candidate) => toId(candidate?._id || candidate?.couponId) === couponId);
        if (!availableCoupon) return null;
        if (availableCoupon?.applicableTo === 'selected') {
          const configuredProducts = new Set(
            (availableCoupon?.applicableProducts || []).map(toId).filter(Boolean)
          );
          productIds = productIds.filter((productId) => configuredProducts.has(productId));
        }
        if (!productIds.length) return null;
        refreshedCoupon = { ...coupon, ...availableCoupon, seller: sellerId };
      }

      return { ...refreshedCoupon, applicableProductIds: productIds };
    })
    .filter(Boolean);
};

export const buildSellerShipping = ({
  sellerMap = {},
  selections = {},
  sellerIds: orderedSellerIds = null,
  convertShippingCost,
  convertShippingCosts,
}) => {
  const sellerIds = Array.isArray(orderedSellerIds)
    ? [...new Set(orderedSellerIds.map(toId).filter(Boolean))]
    : Object.keys(sellerMap || {});
  const missingSellerIds = sellerIds.filter((sellerId) => {
    const sellerData = sellerMap?.[sellerId];
    const selectedType = selections?.[sellerId]?.type || selections?.[sellerId]?.name;
    return !sellerData
      || !selectedType
      || !(sellerData.methods || []).some((method) => (
        method.type === selectedType && checkoutShippingMethodIsValid(method)
      ));
  });
  if (!sellerIds.length || missingSellerIds.length) {
    return { valid: false, missingSellerIds, sellerShipping: [], shippingCost: 0 };
  }

  const selected = sellerIds.map((sellerId) => ({
    sellerId,
    method: sellerMap[sellerId].methods.find((candidate) => (
      candidate.type === (selections[sellerId].type || selections[sellerId].name)
    )),
    sellerData: sellerMap[sellerId],
  }));
  const convertedCosts = typeof convertShippingCosts === 'function'
    ? convertShippingCosts(selected)
    : selected.map(({ method, sellerData }) => convertShippingCost(method, sellerData));
  if (!Array.isArray(convertedCosts) || convertedCosts.length !== selected.length) {
    return { valid: false, missingSellerIds: sellerIds, sellerShipping: [], shippingCost: 0 };
  }

  const sellerShipping = selected.map(({ sellerId, method }, index) => {
    const convertedCost = convertedCosts[index];
    if (
      typeof convertedCost !== 'number'
      || !Number.isFinite(convertedCost)
      || convertedCost < 0
      || roundMoney(convertedCost) !== convertedCost
    ) return null;
    const rawDays = method.deliveryDays;
    if (!Number.isSafeInteger(rawDays) || rawDays < 1) return null;
    const price = roundMoney(convertedCost);
    return {
      seller: sellerId,
      shippingMethod: {
        name: method.type,
        price,
        estimatedDays: rawDays,
      },
    };
  }).filter(Boolean);

  if (sellerShipping.length !== selected.length) {
    return { valid: false, missingSellerIds: sellerIds, sellerShipping: [], shippingCost: 0 };
  }

  return {
    valid: true,
    missingSellerIds: [],
    sellerShipping,
    shippingCost: addCurrencyAmounts(...sellerShipping.map((entry) => entry.shippingMethod.price)),
  };
};

const normalizeCouponList = (appliedCoupons) => (
  Array.isArray(appliedCoupons) ? appliedCoupons : Object.values(appliedCoupons || {})
);

export const getClaimedCouponProductIds = (appliedCoupons) => new Set(
  [...normalizeCouponList(appliedCoupons)]
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
  getItemLineTotal,
  convertCouponAmount,
  getCouponCurrency = (coupon) => coupon?.currency,
  targetCurrency = 'USD',
  exchangeRates = {},
}) => {
  const lineDiscounts = new Map();
  const couponDiscounts = [];
  const stagedCoupons = [];
  const claimedProductIds = new Set();
  const claimedCouponIds = new Set();
  const checkoutCurrency = normalizeCurrencyCode(targetCurrency);
  let error = null;
  let totalDiscount = 0;

  const convertSingleCouponAmount = (amount, coupon) => roundMoney(
    typeof convertCouponAmount === 'function'
      ? convertCouponAmount(amount, coupon)
      : convertCurrencyAmount(amount, getCouponCurrency(coupon), checkoutCurrency, exchangeRates)
  );

  [...normalizeCouponList(appliedCoupons)]
    .sort((left, right) => toId(left?._id || left?.couponId).localeCompare(toId(right?._id || right?.couponId)))
    .forEach((coupon) => {
    const couponId = toId(coupon?._id || coupon?.couponId);
    if (!couponId || claimedCouponIds.has(couponId)) {
      error ||= 'Each coupon can be applied only once.';
      return;
    }
    claimedCouponIds.add(couponId);
    const applicableIds = new Set((coupon?.applicableProductIds || []).map(toId).filter(Boolean));
    if ([...applicableIds].some((productId) => claimedProductIds.has(productId))) {
      error ||= 'Two coupons cannot discount the same product in one order.';
      return;
    }
    const eligibleLines = cartItems
      .map((item, index) => ({
        item,
        key: toId(item?._id) || `${toId(item?.product?._id)}:${index}`,
        productId: toId(item?.product?._id),
        subtotal: typeof getItemLineTotal === 'function'
          ? roundMoney(getItemLineTotal(item, index))
          : multiplyCurrencyAmount(getItemPrice(item), getCartItemQuantity(item)),
      }))
      .filter((line) => applicableIds.has(line.productId) && line.subtotal > 0);
    const eligibleSubtotal = addCurrencyAmounts(...eligibleLines.map((line) => line.subtotal));
    if (!eligibleSubtotal) {
      error ||= `Coupon ${coupon?.code || couponId} does not apply to an item in this cart.`;
      return;
    }

    const rawCouponCurrency = getCouponCurrency(coupon);
    if (
      typeof rawCouponCurrency !== 'string'
      || rawCouponCurrency !== rawCouponCurrency.trim().toUpperCase()
      || !currencyCodeIsSupported(rawCouponCurrency)
    ) {
      error ||= `Coupon ${coupon?.code || couponId} has an invalid currency.`;
      return;
    }
    const couponCurrency = rawCouponCurrency;
    const rawMinimumAmount = coupon?.minOrderAmount ?? 0;
    if (
      typeof rawMinimumAmount !== 'number'
      || !Number.isFinite(rawMinimumAmount)
      || rawMinimumAmount < 0
      || roundMoney(rawMinimumAmount) !== rawMinimumAmount
    ) {
      error ||= `Coupon ${coupon?.code || couponId} has an invalid minimum amount.`;
      return;
    }
    const minimumAmount = rawMinimumAmount > 0
      ? convertSingleCouponAmount(rawMinimumAmount, coupon)
      : 0;
    if (toCurrencyMinorUnits(eligibleSubtotal) < toCurrencyMinorUnits(minimumAmount)) {
      error ||= `Coupon ${coupon?.code || couponId} requires a higher eligible subtotal.`;
      return;
    }

    const rawDiscountValue = coupon?.discountValue;
    const rawMaximumDiscount = coupon?.maxDiscountAmount;
    const hasMaximumDiscount = rawMaximumDiscount !== null && rawMaximumDiscount !== undefined;
    let directTargetAmount = null;
    let foreignAllocation = null;
    if (typeof rawDiscountValue !== 'number' || !Number.isFinite(rawDiscountValue) || rawDiscountValue <= 0) {
      error ||= `Coupon ${coupon?.code || couponId} has an invalid discount.`;
      return;
    }
    if (hasMaximumDiscount && (
      typeof rawMaximumDiscount !== 'number'
      || !Number.isFinite(rawMaximumDiscount)
      || rawMaximumDiscount <= 0
      || roundMoney(rawMaximumDiscount) !== rawMaximumDiscount
    )) {
      error ||= `Coupon ${coupon?.code || couponId} has an invalid maximum discount.`;
      return;
    }

    if (coupon?.discountType === 'percentage') {
      if (rawDiscountValue > 100 || roundCurrencyAmount(rawDiscountValue, 6) !== rawDiscountValue) {
        error ||= `Coupon ${coupon?.code || couponId} has an invalid percentage.`;
        return;
      }
      const percentageAmount = percentageCurrencyAmount(eligibleSubtotal, rawDiscountValue);
      if (percentageAmount <= 0) {
        error ||= `Coupon ${coupon?.code || couponId} does not provide a valid discount.`;
        return;
      }
      if (!hasMaximumDiscount) {
        directTargetAmount = percentageAmount;
      } else {
        const roundedMaximum = convertSingleCouponAmount(rawMaximumDiscount, coupon);
        const hardMaximum = Math.min(eligibleSubtotal, percentageAmount, roundedMaximum);
        if (hardMaximum <= 0) {
          error ||= `Coupon ${coupon?.code || couponId} does not provide a valid discount.`;
          return;
        }
        if (couponCurrency === checkoutCurrency) directTargetAmount = hardMaximum;
        else {
          foreignAllocation = {
            sourceAmount: rawMaximumDiscount,
            sourceCurrency: couponCurrency,
            maximumTargetAmount: percentageAmount,
            maximumAllocatedTargetAmount: hardMaximum,
          };
        }
      }
    } else if (coupon?.discountType === 'fixed') {
      if (roundMoney(rawDiscountValue) !== rawDiscountValue) {
        error ||= `Coupon ${coupon?.code || couponId} has an invalid fixed discount.`;
        return;
      }
      const sourceFaceValue = rawDiscountValue;
      const sourceMaximum = hasMaximumDiscount ? roundMoney(rawMaximumDiscount) : null;
      const effectiveSourceValue = sourceMaximum === null
        ? sourceFaceValue
        : Math.min(sourceFaceValue, sourceMaximum);
      if (effectiveSourceValue <= 0) {
        error ||= `Coupon ${coupon?.code || couponId} does not provide a valid discount.`;
        return;
      }
      if (couponCurrency === checkoutCurrency) {
        directTargetAmount = Math.min(eligibleSubtotal, effectiveSourceValue);
      } else {
        let hardMaximum = eligibleSubtotal;
        if (hasMaximumDiscount) {
          hardMaximum = Math.min(hardMaximum, convertSingleCouponAmount(rawMaximumDiscount, coupon));
        }
        if (hardMaximum <= 0) {
          error ||= `Coupon ${coupon?.code || couponId} does not provide a valid discount.`;
          return;
        }
        foreignAllocation = {
          sourceAmount: effectiveSourceValue,
          sourceCurrency: couponCurrency,
          maximumTargetAmount: eligibleSubtotal,
          maximumAllocatedTargetAmount: hardMaximum,
        };
      }
    } else {
      error ||= `Coupon ${coupon?.code || couponId} has an invalid discount type.`;
      return;
    }

    applicableIds.forEach((productId) => claimedProductIds.add(productId));
    stagedCoupons.push({
      coupon,
      couponId,
      eligibleLines,
      eligibleSubtotal,
      directTargetAmount,
      foreignAllocation,
    });
  });

  const foreignStages = stagedCoupons.filter((stage) => stage.foreignAllocation);
  const foreignAllocations = allocateConvertedCurrencyAmounts(
    foreignStages.map((stage) => stage.foreignAllocation),
    checkoutCurrency,
    exchangeRates
  );
  const foreignAmountByCoupon = new Map(
    foreignStages.map((stage, index) => [stage.couponId, foreignAllocations[index] || 0])
  );

  stagedCoupons.forEach((stage) => {
    const discount = stage.directTargetAmount === null
      ? (foreignAmountByCoupon.get(stage.couponId) || 0)
      : roundMoney(stage.directTargetAmount);
    if (discount <= 0) {
      error ||= `Coupon ${stage.coupon?.code || stage.couponId} is too small to discount this order in ${checkoutCurrency}.`;
      couponDiscounts.push({ coupon: stage.coupon, eligibleSubtotal: stage.eligibleSubtotal, discount: 0 });
      return;
    }

    const allocations = allocateCurrencyAmount(discount, stage.eligibleLines.map((line) => line.subtotal));
    stage.eligibleLines.forEach((line, index) => {
      lineDiscounts.set(
        line.key,
        addCurrencyAmounts(lineDiscounts.get(line.key) || 0, allocations[index])
      );
    });
    couponDiscounts.push({ coupon: stage.coupon, eligibleSubtotal: stage.eligibleSubtotal, discount });
    totalDiscount = addCurrencyAmounts(totalDiscount, discount);
  });

  return { totalDiscount, couponDiscounts, lineDiscounts, error };
};

export const createCheckoutAttemptKey = (randomUUID) => {
  const entropy = typeof randomUUID === 'function' ? randomUUID() : '';
  if (!entropy) throw new Error('Secure checkout retry-key generation is unavailable.');
  return `mobile-checkout:${entropy}`;
};

export const prepareStripeAfterOrderResponse = async ({
  response,
  normalizedPayment = null,
  ensureStripeReady,
}) => {
  const data = response?.data || response || {};
  const order = data?.order || {};
  const completed = data?.isPaid === true
    || data?.completed === true
    || data?.noPaymentRequired === true
    || order?.isPaid === true
    || normalizedPayment?.completed === true;

  if (completed) {
    return { paymentRequired: false, stripeConfig: null };
  }
  if (typeof ensureStripeReady !== 'function') {
    throw new Error('Stripe configuration is unavailable.');
  }
  return {
    paymentRequired: true,
    stripeConfig: await ensureStripeReady(),
  };
};

/**
 * Mirrors Backend/services/checkoutIdempotencyService.js. Volatile prices,
 * totals, exchange-rate conversions, and delivery estimates are deliberately
 * excluded so a lost response can be retried with the original attempt key.
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

export const clearCheckoutAttempt = async (
  storage,
  storageKey = CHECKOUT_ATTEMPT_STORAGE_KEY,
  fingerprint = '',
  attemptKey = '',
  now = Date.now(),
) => {
  return clearPersistedMutationAttemptForFingerprint(
    storage,
    storageKey,
    fingerprint,
    attemptKey,
    now,
  );
};

export const getOrCreateCheckoutAttempt = async ({
  storage,
  fingerprint,
  storageKey = CHECKOUT_ATTEMPT_STORAGE_KEY,
  now = Date.now(),
}) => getOrCreatePersistedMutationAttemptForFingerprint({
  storage,
  storageKey,
  fingerprint,
  keyPrefix: 'mobile-checkout',
  now,
});

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

export const cancelOrderPaymentAttempt = async ({ apiClient, orderId, paymentIntentId }) => {
  if (!orderId) {
    return { status: 'unavailable', reason: 'missing_reference' };
  }

  try {
    const response = await apiClient.post(
      `/api/order/payment/${encodeURIComponent(orderId)}/cancel`,
      paymentIntentId ? { paymentIntentId } : {}
    );
    const payload = response?.data || response || {};
    const rawStatus = String(payload?.status || '').toLowerCase();
    if (
      payload?.isPaid === true
      || payload?.stripePaymentReceived === true
      || ['paid', 'succeeded', 'payment_succeeded'].includes(rawStatus)
    ) {
      return { status: 'payment_received', payload };
    }
    if (['cancelled', 'canceled'].includes(rawStatus)) {
      return { status: 'cancelled', payload };
    }
    return { status: 'pending', payload };
  } catch (error) {
    const code = String(error?.response?.data?.code || '');
    if (code === 'PAYMENT_ALREADY_SUCCEEDED') {
      return { status: 'payment_received', error, payload: error.response?.data };
    }
    return { status: 'unavailable', error, code, reason: 'cancellation_unconfirmed' };
  }
};

export const runOrderPaymentSheetAttempt = async ({
  initPaymentSheet,
  presentPaymentSheet,
  options,
  apiClient,
  orderId,
  paymentIntentId,
}) => {
  const sheetResult = await runPaymentSheet({ initPaymentSheet, presentPaymentSheet, options });
  if (sheetResult.status === 'presented') return { ...sheetResult, cancellation: null };
  const cancellation = await cancelOrderPaymentAttempt({ apiClient, orderId, paymentIntentId });
  return { ...sheetResult, cancellation };
};

export const isTransientPaymentVerificationError = (error = {}) => {
  const status = Number(error?.response?.status ?? error?.status);
  const code = String(error?.response?.data?.code ?? error?.code ?? '');
  return (
    (status === 409 && code === 'CHECKOUT_IN_PROGRESS')
    || (status === 429 && code === 'PAYMENT_RATE_LIMITED')
  );
};

export const verifyOrderPayment = async ({
  apiClient,
  orderId,
  sessionId,
  paymentIntentId,
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
        {
          params: {
            ...(sessionId ? { sessionId } : {}),
            ...(paymentIntentId ? { paymentIntentId } : {}),
          },
        }
      );
      lastPayload = response?.data || response;
      const status = normalizePaymentStatus(lastPayload);
      if (status !== 'pending') return { status, payload: lastPayload };
    } catch (error) {
      lastError = error;
      if (
        !isTransientPaymentVerificationError(error)
        && error?.response?.status >= 400
        && error?.response?.status < 500
        && error?.response?.status !== 408
      ) {
        return { status: 'failed', error, reason: 'verification_rejected' };
      }
    }
    if (attempt < attempts - 1) await sleep(delayMs);
  }

  return { status: 'pending', payload: lastPayload, error: lastError };
};
