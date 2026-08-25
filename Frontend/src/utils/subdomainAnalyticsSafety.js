import {
  currencyCodeIsSupported,
  roundCurrencyAmount,
} from './currencySafety.js';

const count = value => Number.isSafeInteger(value) && value >= 0;
const exactMoney = value => (
  typeof value === 'number'
  && Number.isFinite(value)
  && value >= 0
  && roundCurrencyAmount(value) === value
);
const canonicalObjectId = value => typeof value === 'string' && /^[a-f\d]{24}$/u.test(value);
const canonicalSlug = value => (
  typeof value === 'string'
  && /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/u.test(value)
);
const validDate = value => (
  typeof value === 'string'
  && value.trim() === value
  && !Number.isNaN(new Date(value).getTime())
);

const invalidAdminSubdomainResponse = () => ({
  valid: false,
  currency: null,
  stores: [],
  summary: null,
  pagination: null,
});

export const inspectAdminSubdomainResponse = (
  payload,
  requestedCurrency,
  { expectedPage, expectedLimit = 15 } = {},
) => {
  try {
    const requested = typeof requestedCurrency === 'string' ? requestedCurrency.trim().toUpperCase() : '';
    const stores = payload?.stores;
    const summary = payload?.summary;
    const pagination = payload?.pagination;
    if (
      !payload
      || typeof payload !== 'object'
      || Array.isArray(payload)
      || !currencyCodeIsSupported(requested)
      || payload.currency !== requested
      || !Array.isArray(stores)
      || !summary
      || typeof summary !== 'object'
      || Array.isArray(summary)
      || !pagination
      || typeof pagination !== 'object'
      || Array.isArray(pagination)
      || !Number.isSafeInteger(expectedLimit)
      || expectedLimit <= 0
    ) return invalidAdminSubdomainResponse();

    const ids = new Set();
    const slugs = new Set();
    let pageViews = 0;
    let pageActive = 0;
    let pageInactive = 0;
    let pagePending = 0;
    for (const store of stores) {
      const verification = store?.verification;
      const seller = store?.seller;
      if (
        !store
        || typeof store !== 'object'
        || Array.isArray(store)
        || !canonicalObjectId(store._id)
        || ids.has(store._id)
        || typeof store.storeName !== 'string'
        || store.storeName.trim() !== store.storeName
        || store.storeName.length < 3
        || store.storeName.length > 50
        || !canonicalSlug(store.storeSlug)
        || slugs.has(store.storeSlug)
        || store.subdomainUrl !== `${store.storeSlug}.rozare.com`
        || !(store.logo == null || (typeof store.logo === 'string' && store.logo.trim() === store.logo))
        || !seller
        || typeof seller !== 'object'
        || Array.isArray(seller)
        || !canonicalObjectId(seller._id)
        || typeof seller.username !== 'string'
        || !seller.username.trim()
        || typeof seller.email !== 'string'
        || !seller.email.trim()
        || !count(store.views)
        || !count(store.trustCount)
        || !count(store.productCount)
        || !count(store.totalOrders)
        || !exactMoney(store.totalRevenue)
        || (store.totalOrders === 0 && store.totalRevenue !== 0)
        || typeof store.isActive !== 'boolean'
        || typeof store.isSubdomainActive !== 'boolean'
        || store.isSubdomainActive !== store.isActive
        || !verification
        || typeof verification !== 'object'
        || Array.isArray(verification)
        || typeof verification.isVerified !== 'boolean'
        || !['none', 'pending', 'approved', 'rejected'].includes(verification.status)
        || (verification.isVerified && verification.status !== 'approved')
        || (verification.status === 'approved' && !verification.isVerified)
        || !validDate(store.createdAt)
      ) return invalidAdminSubdomainResponse();

      ids.add(store._id);
      slugs.add(store.storeSlug);
      pageViews += store.views;
      if (store.isSubdomainActive) pageActive += 1;
      else pageInactive += 1;
      if (verification.status === 'pending') pagePending += 1;
    }

    if (
      !count(summary.totalStores)
      || !count(summary.activeSubdomains)
      || !count(summary.inactiveSubdomains)
      || !count(summary.pendingVerifications)
      || !count(summary.totalViews)
      || summary.activeSubdomains + summary.inactiveSubdomains !== summary.totalStores
      || summary.pendingVerifications > summary.totalStores
      || summary.totalViews < pageViews
      || summary.activeSubdomains < pageActive
      || summary.inactiveSubdomains < pageInactive
      || summary.pendingVerifications < pagePending
      || !count(pagination.total)
      || !Number.isSafeInteger(pagination.page)
      || pagination.page < 1
      || !count(pagination.pages)
      || (expectedPage !== undefined && pagination.page !== expectedPage)
      || pagination.pages !== Math.ceil(pagination.total / expectedLimit)
      || pagination.total > summary.totalStores
      || stores.length > expectedLimit
      || stores.length > pagination.total
      || (pagination.pages === 0 && (pagination.total !== 0 || stores.length !== 0 || pagination.page !== 1))
      || (pagination.pages > 0 && pagination.page > pagination.pages && stores.length !== 0)
    ) return invalidAdminSubdomainResponse();

    return {
      valid: true,
      currency: requested,
      stores,
      summary,
      pagination,
    };
  } catch (_) {
    return invalidAdminSubdomainResponse();
  }
};

export const subdomainAnalyticsResponseIsValid = (payload, requestedCurrency) => {
  const requested = typeof requestedCurrency === 'string' ? requestedCurrency.trim().toUpperCase() : '';
  const subdomain = payload?.subdomain;
  const analytics = payload?.analytics;
  if (
    !subdomain
    || typeof subdomain.slug !== 'string'
    || !/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/.test(subdomain.slug)
    || subdomain.url !== `${subdomain.slug}.rozare.com`
    || typeof subdomain.isActive !== 'boolean'
    || typeof subdomain.blocked !== 'boolean'
    || typeof subdomain.isPurchased !== 'boolean'
    || !(subdomain.daysUntilRemoval === null || count(subdomain.daysUntilRemoval))
    || !analytics
    || !currencyCodeIsSupported(requested)
    || analytics.currency !== requested
    || !count(analytics.totalViews)
    || !count(analytics.totalOrders)
    || !count(analytics.productCount)
    || !count(analytics.trustCount)
    || !exactMoney(analytics.totalRevenue)
    || (analytics.totalOrders === 0 && analytics.totalRevenue !== 0)
    || typeof analytics.conversionRate !== 'number'
    || !Number.isFinite(analytics.conversionRate)
    || analytics.conversionRate < 0
    || roundCurrencyAmount(analytics.conversionRate) !== analytics.conversionRate
    || typeof analytics.trafficHistoryAvailable !== 'boolean'
    || !Array.isArray(analytics.monthlyTraffic)
    || analytics.monthlyTraffic.some(row => (
      typeof row?.month !== 'string'
      || !row.month.trim()
      || !count(row?.views)
    ))
    || (!analytics.trafficHistoryAvailable && analytics.monthlyTraffic.length > 0)
  ) return false;
  return true;
};
