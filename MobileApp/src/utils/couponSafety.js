import {
  currencyCodeIsSupported,
  roundCurrencyAmount,
  toCurrencyMinorUnits,
} from './currencySafety';
import { inspectManagedProduct } from './productBulkSafety';
import { parseExactMoneyInput } from './sellerMoneySafety';

const MAX_COMPLETE_COUPON_PAGES = 100;
const COMPLETE_COUPON_PAGE_LIMIT = 100;

const plainUnsignedDecimal = (value, maximumDecimals) => {
  if (!['number', 'string'].includes(typeof value)) return null;
  const text = String(value).trim();
  if (!text || text.length > 64) return null;
  const pattern = maximumDecimals === 0
    ? /^\d+$/
    : new RegExp(`^\\d+(?:\\.\\d{1,${maximumDecimals}})?$`);
  if (!pattern.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};

export const isExactCouponMoneyInput = (
  value,
  { allowZero = false, allowEmpty = false } = {},
) => {
  if (allowEmpty && (value === null || value === undefined || String(value).trim() === '')) return true;
  const parsed = parseExactMoneyInput(value, { allowZero });
  return parsed !== null;
};

export const isExactCouponPercentageInput = (value) => {
  const parsed = plainUnsignedDecimal(value, 6);
  return parsed !== null
    && parsed >= 0.01
    && parsed <= 100;
};

export const isPositiveCouponCountInput = (value, { allowEmpty = false } = {}) => {
  if (allowEmpty && (value === null || value === undefined || String(value).trim() === '')) return true;
  const parsed = plainUnsignedDecimal(value, 0);
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

export const canonicalCouponObjectId = value => typeof value === 'string' && /^[a-f\d]{24}$/iu.test(value);
const couponProductId = value => (typeof value === 'string' ? value : value?._id);
const invalidCouponPresentation = () => ({
  valid: false, id: null, code: null, currency: null, discountType: null, discountValue: null,
  applicableTo: null, isActive: null,
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
    const valid = canonicalCouponObjectId(value._id)
      && typeof value.code === 'string'
      && /^[A-Z0-9_-]{3,32}$/.test(value.code)
      && (fixed || percentage)
      && canonicalSupportedCurrency(value.currency)
      && (fixed ? exactMoney(value.discountValue) && value.discountValue > 0 : exactPercentage(value.discountValue))
      && ['all', 'selected'].includes(value.applicableTo)
      && products !== null
      && productIds.every(canonicalCouponObjectId)
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
      && typeof value.description === 'string'
      && typeof value.startDate === 'string'
      && typeof value.expiryDate === 'string'
      && Number.isFinite(startDate.getTime())
      && Number.isFinite(expiryDate.getTime())
      && startDate.toISOString() === value.startDate
      && expiryDate.toISOString() === value.expiryDate
      && expiryDate > startDate;
    return {
      valid,
      id: valid ? value._id : null,
      code: valid ? value.code : null,
      currency: valid ? value.currency : null,
      discountType: valid ? value.discountType : null,
      discountValue: valid ? value.discountValue : null,
      applicableTo: valid ? value.applicableTo : null,
      isActive: valid ? value.isActive : null,
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

const invalidProductCurrencyState = () => ({
  valid: false,
  activeCurrency: null,
  productCount: null,
  products: [],
});

/**
 * Coupon creation depends on both the store currency aggregate and the exact
 * catalog snapshot used by the product picker. Cross-check the two responses
 * so a partial page, stale aggregate, mixed currency, corrupt price, or
 * coercible count cannot silently produce a coupon in the wrong currency.
 * A product price of zero remains valid: free products are a supported backend
 * state and are intentionally accepted by inspectManagedProduct.
 */
export const inspectCouponProductCurrencyState = (state, products) => {
  try {
    if (!state || typeof state !== 'object' || Array.isArray(state) || !Array.isArray(products)) {
      return invalidProductCurrencyState();
    }
    if (
      state.hasStore !== true
      || state.canAddProduct !== true
      || state.status !== 'active'
      || state.pendingCurrency !== null
      || state.previousCurrency !== null
      || !canonicalSupportedCurrency(state.activeCurrency)
      || !Number.isSafeInteger(state.productCount)
      || state.productCount < 0
      || !Array.isArray(state.productCurrencies)
      || !state.productCurrencyCounts
      || typeof state.productCurrencyCounts !== 'object'
      || Array.isArray(state.productCurrencyCounts)
    ) return invalidProductCurrencyState();

    const presentations = products.map(inspectManagedProduct);
    const productIds = products.map(product => product?._id);
    if (
      products.length !== state.productCount
      || presentations.some(presentation => !presentation.valid)
      || products.some(product => typeof product?.name !== 'string' || !product.name.trim())
      || new Set(productIds).size !== productIds.length
      || presentations.some(presentation => presentation.currency !== state.activeCurrency)
    ) return invalidProductCurrencyState();

    const declaredCurrencies = state.productCurrencies;
    if (
      declaredCurrencies.some(currency => !canonicalSupportedCurrency(currency))
      || new Set(declaredCurrencies).size !== declaredCurrencies.length
    ) return invalidProductCurrencyState();

    const declaredCounts = Object.entries(state.productCurrencyCounts);
    if (
      declaredCounts.some(([currency, productCount]) => (
        !canonicalSupportedCurrency(currency)
        || !Number.isSafeInteger(productCount)
        || productCount <= 0
      ))
      || new Set(declaredCounts.map(([currency]) => currency)).size !== declaredCounts.length
      || declaredCounts.reduce((total, [, productCount]) => total + BigInt(productCount), 0n)
        !== BigInt(state.productCount)
      || declaredCurrencies.length !== declaredCounts.length
      || declaredCurrencies.some(currency => !declaredCounts.some(([key]) => key === currency))
    ) return invalidProductCurrencyState();

    if (state.productCount === 0) {
      if (declaredCurrencies.length !== 0 || declaredCounts.length !== 0) {
        return invalidProductCurrencyState();
      }
    } else if (
      declaredCurrencies.length !== 1
      || declaredCurrencies[0] !== state.activeCurrency
      || declaredCounts[0][0] !== state.activeCurrency
      || declaredCounts[0][1] !== state.productCount
    ) return invalidProductCurrencyState();

    return {
      valid: true,
      activeCurrency: state.activeCurrency,
      productCount: state.productCount,
      products,
    };
  } catch (_) {
    return invalidProductCurrencyState();
  }
};

export const inspectCouponPagination = (pagination, {
  couponCount,
  expectedPage,
  expectedLimit,
} = {}) => {
  if (!pagination || typeof pagination !== 'object' || Array.isArray(pagination)) {
    return { valid: false };
  }
  const { page, limit, totalCoupons, totalPages, hasMore } = pagination;
  if (
    !Number.isSafeInteger(page)
    || page < 1
    || !Number.isSafeInteger(limit)
    || limit < 1
    || !Number.isSafeInteger(totalCoupons)
    || totalCoupons < 0
    || !Number.isSafeInteger(totalPages)
    || totalPages < 1
    || totalPages > MAX_COMPLETE_COUPON_PAGES
    || typeof hasMore !== 'boolean'
    || !Number.isSafeInteger(couponCount)
    || couponCount < 0
    || couponCount > limit
    || (expectedPage !== undefined && page !== expectedPage)
    || (expectedLimit !== undefined && limit !== expectedLimit)
    || totalPages !== Math.max(1, Math.ceil(totalCoupons / limit))
    || hasMore !== (page < totalPages)
    || ((page - 1) * limit) + couponCount > totalCoupons
  ) return { valid: false };
  return { valid: true, page, limit, totalCoupons, totalPages, hasMore };
};

const requireCouponPage = (payload, { expectedPage, expectedLimit, allowUnpaginated = false } = {}) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.coupons)) {
    throw new Error('Coupon data is unavailable.');
  }
  const coupons = payload.coupons;
  if (!coupons.every(coupon => inspectCouponPresentation(coupon).valid)) {
    throw new Error('Coupon data contains invalid money, currency, usage, or scheduling fields.');
  }
  const ids = coupons.map(coupon => coupon._id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Coupon data contains duplicate identities.');
  }
  if (payload.pagination === undefined && allowUnpaginated) {
    return { coupons, pagination: null };
  }
  const pagination = inspectCouponPagination(payload.pagination, {
    couponCount: coupons.length,
    expectedPage,
    expectedLimit,
  });
  if (!pagination.valid) throw new Error('Coupon pagination data is invalid.');
  return { coupons, pagination };
};

export const fetchCompleteSellerCoupons = async (apiClient) => {
  if (!apiClient || typeof apiClient.get !== 'function') {
    throw new Error('Coupon API is unavailable.');
  }
  const requestPage = page => apiClient.get('/api/coupons/seller', {
    params: { page, limit: COMPLETE_COUPON_PAGE_LIMIT },
  });
  const firstResponse = await requestPage(1);
  const first = requireCouponPage(firstResponse?.data, {
    expectedPage: 1,
    expectedLimit: COMPLETE_COUPON_PAGE_LIMIT,
    allowUnpaginated: true,
  });
  if (!first.pagination) return first.coupons;

  const responses = [];
  for (let firstPage = 2; firstPage <= first.pagination.totalPages; firstPage += 5) {
    const lastPage = Math.min(first.pagination.totalPages, firstPage + 4);
    const batch = await Promise.all(Array.from(
      { length: lastPage - firstPage + 1 },
      (_, index) => requestPage(firstPage + index),
    ));
    responses.push(...batch);
  }
  const remaining = responses.map((response, index) => requireCouponPage(response?.data, {
    expectedPage: index + 2,
    expectedLimit: first.pagination.limit,
  }));
  if (remaining.some(page => (
    page.pagination.totalCoupons !== first.pagination.totalCoupons
    || page.pagination.totalPages !== first.pagination.totalPages
  ))) throw new Error('Coupon pagination pages are inconsistent.');

  const coupons = [first, ...remaining].flatMap(page => page.coupons);
  const ids = coupons.map(coupon => coupon._id);
  if (
    coupons.length !== first.pagination.totalCoupons
    || new Set(ids).size !== ids.length
  ) throw new Error('Coupon data is incomplete or duplicated.');
  return coupons;
};

export const couponAnalyticsResponseIsValid = (payload, requestedCurrency) => {
  const summary = payload?.summary;
  const rows = payload?.analytics;
  const requested = typeof requestedCurrency === 'string' ? requestedCurrency.trim().toUpperCase() : '';
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
    || !(summary.topCouponCode === null || (
      typeof summary.topCouponCode === 'string'
      && /^[A-Z0-9_-]{3,32}$/.test(summary.topCouponCode)
    ))
    || payload?.moneyBasis?.attributedSales !== 'recognized_eligible_product_subtotal_before_coupon_discount'
    || payload?.moneyBasis?.discount !== 'allocated_frozen_coupon_discount'
    || !Array.isArray(payload?.moneyBasis?.excludes)
    || payload.moneyBasis.excludes.length !== 2
    || payload.moneyBasis.excludes[0] !== 'shipping'
    || payload.moneyBasis.excludes[1] !== 'tax'
  ) return false;

  let uses = 0;
  let revenueMinor = 0n;
  let discountMinor = 0n;
  const rowIds = [];
  const rowCodes = [];
  let activeCoupons = 0;
  const now = new Date();
  for (const row of rows) {
    const fixedDiscount = row?.discountType === 'fixed';
    const percentageDiscount = row?.discountType === 'percentage';
    const productIds = Array.isArray(row?.applicableProducts)
      ? row.applicableProducts.map(couponProductId)
      : null;
    const startDate = new Date(row?.startDate);
    const expiryDate = new Date(row?.expiryDate);
    if (
      !canonicalCouponObjectId(row?._id)
      || typeof row?.code !== 'string'
      || !/^[A-Z0-9_-]{3,32}$/.test(row.code)
      || (!fixedDiscount && !percentageDiscount)
      || !canonicalSupportedCurrency(row?.currency)
      || !(fixedDiscount ? exactMoney(row?.discountValue) && row.discountValue > 0 : exactPercentage(row?.discountValue))
      || !count(row?.usedCount)
      || !(row?.maxUses === null || (Number.isSafeInteger(row.maxUses) && row.maxUses > 0))
      || (row.maxUses !== null && row.usedCount > row.maxUses)
      || !count(row?.ordersGenerated)
      || row.ordersGenerated > row.usedCount
      || !count(row?.uniqueUsers)
      || row.uniqueUsers > row.ordersGenerated
      || !['all', 'selected'].includes(row?.applicableTo)
      || productIds === null
      || productIds.some(productId => !canonicalCouponObjectId(productId))
      || new Set(productIds).size !== productIds.length
      || (row.applicableTo === 'selected' && productIds.length === 0)
      || typeof row?.isActive !== 'boolean'
      || typeof row?.description !== 'string'
      || typeof row?.startDate !== 'string'
      || typeof row?.expiryDate !== 'string'
      || !Number.isFinite(startDate.getTime())
      || !Number.isFinite(expiryDate.getTime())
      || startDate.toISOString() !== row.startDate
      || expiryDate.toISOString() !== row.expiryDate
      || expiryDate <= startDate
      || !exactMoney(row?.totalRevenue)
      || !exactMoney(row?.totalDiscount)
      || row.totalDiscount > row.totalRevenue
      || !exactMoney(row?.avgOrderValue)
      || row.avgOrderValue !== (row.ordersGenerated > 0
        ? roundCurrencyAmount(row.totalRevenue / row.ordersGenerated)
        : 0)
      || !(row?.conversionRate === null || (
        Number.isSafeInteger(row?.conversionRate)
        && row.conversionRate >= 0
        && row.conversionRate <= 100
      ))
      || row.conversionRate !== (row.maxUses === null
        ? null
        : Math.round((row.ordersGenerated / row.maxUses) * 100))
    ) return false;
    rowIds.push(row._id);
    rowCodes.push(row.code);
    if (row.isActive && now <= expiryDate) activeCoupons += 1;
    uses += row.ordersGenerated;
    revenueMinor += BigInt(toCurrencyMinorUnits(row.totalRevenue));
    discountMinor += BigInt(toCurrencyMinorUnits(row.totalDiscount));
  }

  const topCoupon = rows.length > 0
    ? rows.reduce((best, current) => (
      current.ordersGenerated > best.ordersGenerated ? current : best
    ), rows[0])
    : null;
  return new Set(rowIds).size === rowIds.length
    && new Set(rowCodes).size === rowCodes.length
    && activeCoupons === summary.activeCoupons
    && summary.topCouponCode === (topCoupon?.code || null)
    && uses === summary.totalUses
    && revenueMinor === BigInt(toCurrencyMinorUnits(summary.totalRevenueFromCoupons))
    && discountMinor === BigInt(toCurrencyMinorUnits(summary.totalDiscountGiven));
};
