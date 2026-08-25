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
} from './currencySafety.js';

const toId = (value) => value?._id?.toString?.() || value?.toString?.() || '';

const normalizeCouponList = (appliedCoupons) => (
  Array.isArray(appliedCoupons) ? appliedCoupons : Object.values(appliedCoupons || {})
);

const productIdForCartItem = (item) => toId(item?.product?._id || item?.productId);
const sellerIdForCartItem = (item) => toId(
  item?.product?.seller?._id
  || item?.product?.seller
  || item?.seller?._id
  || item?.seller
);

export const createCheckoutMoneyCartSignature = (cartItems = []) => JSON.stringify(
  (Array.isArray(cartItems) ? cartItems : [])
    .map((item) => ({
      productId: productIdForCartItem(item),
      sellerId: sellerIdForCartItem(item),
    }))
    .sort((left, right) => (
      left.productId.localeCompare(right.productId)
      || left.sellerId.localeCompare(right.sellerId)
    ))
);

export const selectCheckoutShippingMethods = (sellerMap = {}, previousSelections = {}) => {
  const selections = {};
  Object.entries(sellerMap || {}).forEach(([sellerId, sellerData]) => {
    const methods = (sellerData?.methods || []).filter((method) => method?.isActive !== false);
    if (!methods.length) return;
    const previousType = previousSelections?.[sellerId]?.type || previousSelections?.[sellerId]?.name;
    selections[sellerId] = methods.find((method) => method?.type === previousType)
      || methods.find((method) => method?.type === 'free')
      || methods[0];
  });
  return selections;
};

export const reconcileAppliedCheckoutCoupons = (
  appliedCoupons = {},
  cartItems = [],
  availableCouponsBySeller = null,
) => {
  const productSeller = new Map(
    (Array.isArray(cartItems) ? cartItems : [])
      .map((item) => [productIdForCartItem(item), sellerIdForCartItem(item)])
      .filter(([productId, sellerId]) => productId && sellerId)
  );
  const availabilityIsAuthoritative = availableCouponsBySeller !== null
    && typeof availableCouponsBySeller === 'object'
    && !Array.isArray(availableCouponsBySeller);
  const reconciled = {};

  Object.entries(appliedCoupons || {}).forEach(([inputKey, coupon]) => {
    if (!coupon || typeof coupon !== 'object') return;
    const couponId = toId(coupon?._id || coupon?.couponId);
    let sellerId = toId(coupon?.seller);
    let productIds = [...new Set((coupon?.applicableProductIds || []).map(toId).filter(Boolean))]
      .filter((productId) => productSeller.has(productId));
    if (!sellerId) {
      const candidateSellers = [...new Set(productIds.map((productId) => productSeller.get(productId)).filter(Boolean))];
      if (candidateSellers.length === 1) [sellerId] = candidateSellers;
    }
    if (sellerId) {
      productIds = productIds.filter((productId) => productSeller.get(productId) === sellerId);
    }
    if (!couponId || !sellerId || !productIds.length) return;

    let refreshedCoupon = coupon;
    if (availabilityIsAuthoritative) {
      const availableCoupon = (availableCouponsBySeller?.[sellerId] || [])
        .find((candidate) => toId(candidate?._id || candidate?.couponId) === couponId);
      if (!availableCoupon) return;
      if (availableCoupon?.applicableTo === 'selected') {
        const configuredProducts = new Set(
          (availableCoupon?.applicableProducts || []).map(toId).filter(Boolean)
        );
        productIds = productIds.filter((productId) => configuredProducts.has(productId));
      }
      if (!productIds.length) return;
      refreshedCoupon = { ...coupon, ...availableCoupon, seller: sellerId };
    }

    reconciled[inputKey] = { ...refreshedCoupon, applicableProductIds: productIds };
  });
  return reconciled;
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
  if (
    returnedSellerIds.length !== expected.length
    || [...returnedSellerIds].sort().some((sellerId, index) => sellerId !== [...expected].sort()[index])
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

// Mirrors Backend/services/checkoutPricingService.js, including global foreign
// coupon conversion, caps, stable coupon ordering, and exact-cent line splits.
export const calculateCheckoutCouponPricing = ({
  appliedCoupons = [],
  cartItems = [],
  getItemPrice,
  getItemLineTotal,
  getItemKey = (item, index) => toId(item?._id) || `${toId(item?.product?._id)}:${index}`,
  getProductId = (item) => toId(item?.product?._id),
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

  const convertSingleCouponAmount = (amount, coupon) => roundCurrencyAmount(
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
          key: getItemKey(item, index),
          productId: getProductId(item),
          subtotal: typeof getItemLineTotal === 'function'
            ? roundCurrencyAmount(getItemLineTotal(item, index))
            : multiplyCurrencyAmount(getItemPrice(item), item?.qty || item?.quantity || 1),
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
        || roundCurrencyAmount(rawMinimumAmount) !== rawMinimumAmount
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
        || roundCurrencyAmount(rawMaximumDiscount) !== rawMaximumDiscount
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
        if (roundCurrencyAmount(rawDiscountValue) !== rawDiscountValue) {
          error ||= `Coupon ${coupon?.code || couponId} has an invalid fixed discount.`;
          return;
        }
        const sourceFaceValue = rawDiscountValue;
        const sourceMaximum = hasMaximumDiscount ? roundCurrencyAmount(rawMaximumDiscount) : null;
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
      : roundCurrencyAmount(stage.directTargetAmount);
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
