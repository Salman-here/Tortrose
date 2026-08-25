import { exactCurrencyCode, isExactNonNegativeJsonMoney } from './sellerMoneySafety.js';
import { formatUsdCents } from './subscriptionPricing.js';

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/u;
const PLANS = new Set(['free_trial', 'starter', 'elite']);
const SUBSCRIPTION_STATUSES = new Set([
  'trial',
  'free_period',
  'active',
  'past_due',
  'cancelled',
  'blocked',
]);
const REQUEST_TYPES = new Set(['start', 'update', 'stop']);
const REQUEST_STATUSES = new Set(['pending', 'approved', 'rejected']);

const isPlainObject = value => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
);

const isCanonicalObjectId = value => (
  typeof value === 'string' && OBJECT_ID_PATTERN.test(value)
);

const exactTrimmedText = (value, { allowEmpty = false, maxLength = 500 } = {}) => (
  typeof value === 'string'
  && value === value.trim()
  && value.length <= maxLength
  && (allowEmpty || value.length > 0)
);

const isIsoDate = value => {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};

const uniqueIds = ids => new Set(ids).size === ids.length;
const sortedIds = ids => [...ids].sort();
const sameIdSet = (left, right) => (
  left.length === right.length
  && sortedIds(left).every((id, index) => id === sortedIds(right)[index])
);

const getReferenceId = (value, { populatedStore = false } = {}) => {
  if (value === null) return null;
  if (isCanonicalObjectId(value)) return value;
  if (!isPlainObject(value) || !isCanonicalObjectId(value._id)) return undefined;
  if (populatedStore) {
    if (
      !exactTrimmedText(value.storeName, { maxLength: 200 })
      || !exactTrimmedText(value.storeSlug, { maxLength: 200 })
      || typeof value.logo !== 'string'
    ) return undefined;
  }
  return value._id;
};

const inspectProduct = product => {
  if (!isPlainObject(product)) return null;
  if (
    !isCanonicalObjectId(product._id)
    || !isCanonicalObjectId(product.seller)
    || !exactTrimmedText(product.name, { maxLength: 200 })
    || !exactTrimmedText(product.category, { maxLength: 200 })
    || typeof product.image !== 'string'
    || !Array.isArray(product.images)
    || product.images.some(image => !isPlainObject(image) || typeof image.url !== 'string')
    || typeof product.isFeatured !== 'boolean'
    || !isExactNonNegativeJsonMoney(product.price)
    || !isExactNonNegativeJsonMoney(product.discountedPrice)
  ) return null;

  const currency = exactCurrencyCode(product.currency);
  const priceCurrency = exactCurrencyCode(product.priceCurrency);
  if (!currency || currency !== priceCurrency) return null;
  if (
    product.discountedPrice !== 0
    && (product.price === 0 || product.discountedPrice >= product.price)
  ) return null;

  return {
    id: product._id,
    sellerId: product.seller,
    isFeatured: product.isFeatured,
    currency,
    price: product.price,
    discountedPrice: product.discountedPrice,
    displayAmount: product.discountedPrice === 0 ? product.price : product.discountedPrice,
  };
};

const inspectStore = store => {
  if (store === null) return { valid: true, storeId: null, sellerId: null };
  if (!isPlainObject(store)) return { valid: false };
  if (
    !isCanonicalObjectId(store._id)
    || !isCanonicalObjectId(store.seller)
    || !exactTrimmedText(store.storeName, { maxLength: 200 })
    || !exactTrimmedText(store.storeSlug, { maxLength: 200 })
    || typeof store.logo !== 'string'
  ) return { valid: false };
  return { valid: true, storeId: store._id, sellerId: store.seller };
};

const inspectSubscription = subscription => {
  if (!isPlainObject(subscription)) return null;
  if (
    !PLANS.has(subscription.plan)
    || !SUBSCRIPTION_STATUSES.has(subscription.status)
    || !exactTrimmedText(subscription.planName, { maxLength: 120 })
    || typeof subscription.metaAdsIncluded !== 'boolean'
  ) return null;
  return {
    plan: subscription.plan,
    status: subscription.status,
    planName: subscription.planName,
    metaAdsIncluded: subscription.metaAdsIncluded,
  };
};

const inspectRequest = request => {
  if (!isPlainObject(request)) return null;
  if (
    !isCanonicalObjectId(request._id)
    || !isCanonicalObjectId(request.seller)
    || !REQUEST_TYPES.has(request.requestType)
    || !REQUEST_STATUSES.has(request.status)
    || typeof request.active !== 'boolean'
    || !isPlainObject(request.channels)
    || request.channels.tiktok !== true
    || typeof request.channels.meta !== 'boolean'
    || !Array.isArray(request.products)
    || !Array.isArray(request.productIds)
    || !exactTrimmedText(request.sellerNote, { allowEmpty: true, maxLength: 500 })
    || !exactTrimmedText(request.adminNote, { allowEmpty: true, maxLength: 1000 })
    || !isIsoDate(request.createdAt)
    || !isIsoDate(request.updatedAt)
  ) return null;

  const createdAtMs = Date.parse(request.createdAt);
  const updatedAtMs = Date.parse(request.updatedAt);
  if (updatedAtMs < createdAtMs) return null;

  if (request.active && (request.status !== 'approved' || request.requestType === 'stop')) return null;
  if (request.status === 'pending' && request.active) return null;
  if (request.status === 'rejected' && request.active) return null;

  const storeId = getReferenceId(request.store, { populatedStore: isPlainObject(request.store) });
  if (storeId === undefined) return null;

  const productInspections = request.products.map(inspectProduct);
  if (productInspections.some(product => product === null)) return null;
  const productIds = request.productIds;
  if (
    productIds.some(id => !isCanonicalObjectId(id))
    || !uniqueIds(productIds)
    || !uniqueIds(productInspections.map(product => product.id))
    || !sameIdSet(productIds, productInspections.map(product => product.id))
    || productInspections.some(product => product.sellerId !== request.seller)
  ) return null;

  if (request.requestType === 'stop') {
    if (productIds.length !== 0) return null;
  } else if (productIds.length === 0) {
    return null;
  }

  const pending = request.status === 'pending';
  if (pending) {
    if (
      request.reviewedBy !== null
      || request.reviewedAt !== null
      || request.adminNote !== ''
    ) return null;
  } else if (!isCanonicalObjectId(request.reviewedBy) || !isIsoDate(request.reviewedAt)) {
    return null;
  } else {
    const reviewedAtMs = Date.parse(request.reviewedAt);
    if (reviewedAtMs < createdAtMs || reviewedAtMs > updatedAtMs) return null;
  }

  return {
    id: request._id,
    sellerId: request.seller,
    storeId,
    requestType: request.requestType,
    status: request.status,
    active: request.active,
    includeMeta: request.channels.meta,
    productIds: [...productIds],
    products: productInspections,
    sellerNote: request.sellerNote,
    adminNote: request.adminNote,
    reviewedBy: request.reviewedBy,
    reviewedAt: request.reviewedAt,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
};

const productMoneyStateKey = product => JSON.stringify({
  id: product.id,
  sellerId: product.sellerId,
  isFeatured: product.isFeatured,
  currency: product.currency,
  price: product.price,
  discountedPrice: product.discountedPrice,
});

const requestStateKey = request => JSON.stringify({
  sellerId: request.sellerId,
  storeId: request.storeId,
  requestType: request.requestType,
  status: request.status,
  active: request.active,
  includeMeta: request.includeMeta,
  productIds: sortedIds(request.productIds),
  products: [...request.products]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(productMoneyStateKey),
  sellerNote: request.sellerNote,
  adminNote: request.adminNote,
  reviewedBy: request.reviewedBy,
  reviewedAt: request.reviewedAt,
  createdAt: request.createdAt,
  updatedAt: request.updatedAt,
});

const descendingByCreatedAt = requests => requests.every((request, index) => (
  index === 0 || Date.parse(requests[index - 1].createdAt) >= Date.parse(request.createdAt)
));

const selectInitialRequest = ({ activeRequest, pendingRequests }) => (
  activeRequest?.productIds?.length ? activeRequest : pendingRequests[0] ?? null
);

export const inspectSellerAdsOverview = payload => {
  if (!isPlainObject(payload)) return null;

  const subscription = inspectSubscription(payload.subscription);
  const store = inspectStore(payload.store);
  if (
    !subscription
    || !store.valid
    || typeof payload.isElite !== 'boolean'
    || !Number.isSafeInteger(payload.metaAdsAddonCents)
    || payload.metaAdsAddonCents <= 0
    || !Array.isArray(payload.featuredProducts)
    || !Array.isArray(payload.pendingRequests)
    || !Array.isArray(payload.recentRequests)
    || payload.pendingRequests.length > 1
    || payload.recentRequests.length > 12
    || (payload.activeRequest !== null && !isPlainObject(payload.activeRequest))
  ) return null;

  const expectedElite = subscription.plan === 'elite'
    && ['active', 'free_period'].includes(subscription.status);
  if (payload.isElite !== expectedElite) return null;
  if (subscription.metaAdsIncluded && subscription.plan !== 'elite') return null;

  const featuredProducts = payload.featuredProducts.map(inspectProduct);
  if (
    featuredProducts.some(product => product === null || !payload.featuredProducts.find(item => item._id === product.id)?.isFeatured)
    || !uniqueIds(featuredProducts.map(product => product.id))
  ) return null;

  const activeRequest = payload.activeRequest === null
    ? null
    : inspectRequest(payload.activeRequest);
  const pendingRequests = payload.pendingRequests.map(inspectRequest);
  const recentRequests = payload.recentRequests.map(inspectRequest);
  if (
    (payload.activeRequest !== null && activeRequest === null)
    || pendingRequests.some(request => request === null || request.status !== 'pending' || request.active)
    || recentRequests.some(request => request === null)
    || !uniqueIds(pendingRequests.map(request => request.id))
    || !uniqueIds(recentRequests.map(request => request.id))
    || !descendingByCreatedAt(pendingRequests)
    || !descendingByCreatedAt(recentRequests)
    || (activeRequest && (activeRequest.status !== 'approved' || !activeRequest.active))
  ) return null;

  const pendingRequest = pendingRequests[0] ?? null;
  if (
    pendingRequest
    && (
      (activeRequest === null && pendingRequest.requestType !== 'start')
      || (activeRequest !== null && pendingRequest.requestType === 'start')
    )
  ) return null;

  const sellerIds = [
    store.sellerId,
    ...featuredProducts.map(product => product.sellerId),
    activeRequest?.sellerId,
    ...pendingRequests.map(request => request.sellerId),
    ...recentRequests.map(request => request.sellerId),
  ].filter(Boolean);
  if (new Set(sellerIds).size > 1) return null;
  const sellerId = sellerIds[0] ?? null;

  const storeIds = [
    activeRequest?.storeId,
    ...pendingRequests.map(request => request.storeId),
    ...recentRequests.map(request => request.storeId),
  ].filter(storeId => storeId !== undefined);
  if (storeIds.some(storeId => storeId !== store.storeId)) return null;

  const requestCopies = new Map();
  for (const request of [activeRequest, ...pendingRequests, ...recentRequests].filter(Boolean)) {
    const key = requestStateKey(request);
    if (requestCopies.has(request.id) && requestCopies.get(request.id) !== key) return null;
    requestCopies.set(request.id, key);
  }
  const productCopies = new Map();
  const allProductCopies = [
    ...featuredProducts,
    ...(activeRequest?.products ?? []),
    ...pendingRequests.flatMap(request => request.products),
    ...recentRequests.flatMap(request => request.products),
  ];
  for (const product of allProductCopies) {
    const key = productMoneyStateKey(product);
    if (productCopies.has(product.id) && productCopies.get(product.id) !== key) return null;
    productCopies.set(product.id, key);
  }
  for (const request of pendingRequests) {
    const recent = recentRequests.find(item => item.id === request.id);
    if (!recent || requestStateKey(recent) !== requestStateKey(request)) return null;
  }
  const recentActive = recentRequests.filter(request => request.active);
  if (
    recentActive.length > 1
    || (recentActive.length === 1 && (!activeRequest || recentActive[0].id !== activeRequest.id))
  ) return null;

  const featuredIdSet = new Set(featuredProducts.map(product => product.id));
  const initialRequest = selectInitialRequest({ activeRequest, pendingRequests });
  const initialSelectedIds = initialRequest
    ? initialRequest.productIds.filter(id => featuredIdSet.has(id))
    : [];

  return {
    overview: payload,
    subscription,
    sellerId,
    storeId: store.storeId,
    activeRequest,
    pendingRequests,
    recentRequests,
    featuredProductMoney: new Map(featuredProducts.map(product => [product.id, product])),
    initialSelectedIds,
    initialIncludeMeta: initialRequest?.includeMeta === true,
  };
};

export const inspectSellerAdMutationResponse = (payload, expected) => {
  if (
    !isPlainObject(payload)
    || !exactTrimmedText(payload.msg, { maxLength: 500 })
    || !isPlainObject(expected)
    || !REQUEST_TYPES.has(expected.requestType)
    || typeof expected.includeMeta !== 'boolean'
    || !exactTrimmedText(expected.sellerNote, { allowEmpty: true, maxLength: 500 })
    || !Array.isArray(expected.productIds)
    || expected.productIds.some(id => !isCanonicalObjectId(id))
    || !uniqueIds(expected.productIds)
  ) return null;

  const request = inspectRequest(payload.request);
  if (
    !request
    || request.status !== 'pending'
    || request.active
    || request.requestType !== expected.requestType
    || request.includeMeta !== expected.includeMeta
    || request.sellerNote !== expected.sellerNote
    || !sameIdSet(request.productIds, expected.productIds)
    || (expected.sellerId !== null && expected.sellerId !== undefined && request.sellerId !== expected.sellerId)
    || (expected.storeId !== undefined && request.storeId !== expected.storeId)
  ) return null;

  return { message: payload.msg, request };
};

export const sellerAdsOverviewConfirmsRequest = (inspection, request) => {
  if (!inspection || !request) return false;
  const confirmed = inspection.pendingRequests?.find(item => item.id === request.id);
  return Boolean(confirmed) && requestStateKey(confirmed) === requestStateKey(request);
};

export { formatUsdCents };
