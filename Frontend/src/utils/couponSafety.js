import {
  currencyCodeIsSupported,
  roundCurrencyAmount,
  toCurrencyMinorUnits,
} from './currencySafety.js';

const parsedFiniteNumber = (value) => {
  if (
    value === null
    || value === undefined
    || typeof value === 'boolean'
    || (typeof value === 'string' && !value.trim())
  ) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const isExactCouponMoneyInput = (
  value,
  { allowZero = false, allowEmpty = false } = {},
) => {
  if (allowEmpty && (value === null || value === undefined || String(value).trim() === '')) {
    return true;
  }
  const parsed = parsedFiniteNumber(value);
  return parsed !== null
    && (allowZero ? parsed >= 0 : parsed > 0)
    && roundCurrencyAmount(parsed) === parsed;
};

export const isExactCouponPercentageInput = (value) => {
  const parsed = parsedFiniteNumber(value);
  return parsed !== null
    && parsed >= 0.01
    && parsed <= 100
    && roundCurrencyAmount(parsed, 6) === parsed;
};

export const isPositiveCouponCountInput = (value, { allowEmpty = false } = {}) => {
  if (allowEmpty && (value === null || value === undefined || String(value).trim() === '')) {
    return true;
  }
  const parsed = parsedFiniteNumber(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
};

const exactMoney = value => (
  typeof value === 'number'
  && Number.isFinite(value)
  && value >= 0
  && roundCurrencyAmount(value) === value
);

const count = value => Number.isSafeInteger(value) && value >= 0;
const canonicalSupportedCurrency = value => (
  typeof value === 'string'
  && value === value.trim().toUpperCase()
  && currencyCodeIsSupported(value)
);

const exactPercentage = value => (
  typeof value === 'number'
  && Number.isFinite(value)
  && value >= 0.01
  && value <= 100
  && roundCurrencyAmount(value, 6) === value
);

const canonicalObjectId = value => typeof value === 'string' && /^[a-f\d]{24}$/iu.test(value);
const couponProductId = value => (typeof value === 'string' ? value : value?._id);
const invalidCouponPresentation = () => ({
  valid: false, id: null, currency: null, discountType: null, discountValue: null,
  usedCount: null, maxUses: null, productIds: [], startDate: null, expiryDate: null,
});

export const inspectCouponPresentation = (coupon) => {
  try {
  const value = coupon && typeof coupon === 'object' && !Array.isArray(coupon) ? coupon : {};
  const fixed = value.discountType === 'fixed';
  const percentage = value.discountType === 'percentage';
  const products = Array.isArray(value.applicableProducts) ? value.applicableProducts : null;
  const productIds = products?.map(couponProductId) || [];
  const startDate = new Date(value.startDate);
  const expiryDate = new Date(value.expiryDate);
  const valid = canonicalObjectId(value._id)
    && typeof value.code === 'string'
    && /^[A-Z0-9_-]{3,32}$/.test(value.code)
    && (fixed || percentage)
    && canonicalSupportedCurrency(value.currency)
    && (fixed ? exactMoney(value.discountValue) && value.discountValue > 0 : exactPercentage(value.discountValue))
    && ['all', 'selected'].includes(value.applicableTo)
    && products !== null
    && productIds.every(canonicalObjectId)
    && new Set(productIds).size === productIds.length
    && (value.applicableTo === 'all' || productIds.length > 0)
    && (value.maxUses === null || (Number.isSafeInteger(value.maxUses) && value.maxUses > 0))
    && count(value.usedCount)
    && (value.maxUses === null || value.usedCount <= value.maxUses)
    && Number.isSafeInteger(value.maxUsesPerUser)
    && value.maxUsesPerUser > 0
    && exactMoney(value.minOrderAmount)
    && (value.maxDiscountAmount === null
      || (exactMoney(value.maxDiscountAmount) && value.maxDiscountAmount > 0))
    && typeof value.isActive === 'boolean'
    && Number.isFinite(startDate.getTime())
    && Number.isFinite(expiryDate.getTime())
    && expiryDate > startDate;
  return {
    valid,
    id: valid ? value._id : null,
    currency: valid ? value.currency : null,
    discountType: valid ? value.discountType : null,
    discountValue: valid ? value.discountValue : null,
    usedCount: valid ? value.usedCount : null,
    maxUses: valid ? value.maxUses : null,
    productIds: valid ? productIds : [],
    startDate: valid ? startDate : null,
    expiryDate: valid ? expiryDate : null,
  };
  } catch (_) {
    return invalidCouponPresentation();
  }
};

export const couponAnalyticsResponseIsValid = (payload, requestedCurrency) => {
  const summary = payload?.summary;
  const rows = payload?.analytics;
  const requested = typeof requestedCurrency === 'string'
    ? requestedCurrency.trim().toUpperCase()
    : '';
  if (
    !summary
    || !Array.isArray(rows)
    || !canonicalSupportedCurrency(requested)
    || summary.currency !== requested
    || !count(summary.totalCoupons)
    || !count(summary.activeCoupons)
    || !count(summary.totalUses)
    || summary.activeCoupons > summary.totalCoupons
    || summary.totalCoupons !== rows.length
    || !exactMoney(summary.totalRevenueFromCoupons)
    || !exactMoney(summary.totalDiscountGiven)
    || summary.totalDiscountGiven > summary.totalRevenueFromCoupons
  ) return false;

  let uses = 0;
  let revenueMinor = 0n;
  let discountMinor = 0n;
  for (const row of rows) {
    const fixedDiscount = row?.discountType === 'fixed';
    const percentageDiscount = row?.discountType === 'percentage';
    if (
      (!fixedDiscount && !percentageDiscount)
      || !canonicalSupportedCurrency(row?.currency)
      || !(fixedDiscount ? exactMoney(row?.discountValue) && row.discountValue > 0 : exactPercentage(row?.discountValue))
      || !count(row?.usedCount)
      || !(row?.maxUses === null || row?.maxUses === undefined || (Number.isSafeInteger(row.maxUses) && row.maxUses > 0))
      || !count(row?.ordersGenerated)
      || !count(row?.uniqueUsers)
      || row.uniqueUsers > row.ordersGenerated
      || !exactMoney(row?.totalRevenue)
      || !exactMoney(row?.totalDiscount)
      || row.totalDiscount > row.totalRevenue
      || !exactMoney(row?.avgOrderValue)
      || !(row?.conversionRate === null || (
        Number.isSafeInteger(row?.conversionRate)
        && row.conversionRate >= 0
        && row.conversionRate <= 100
      ))
    ) return false;
    uses += row.ordersGenerated;
    revenueMinor += BigInt(toCurrencyMinorUnits(row.totalRevenue));
    discountMinor += BigInt(toCurrencyMinorUnits(row.totalDiscount));
  }

  return uses === summary.totalUses
    && revenueMinor === BigInt(toCurrencyMinorUnits(summary.totalRevenueFromCoupons))
    && discountMinor === BigInt(toCurrencyMinorUnits(summary.totalDiscountGiven));
};
