import {
  exactCurrencyCode,
  isExactNonNegativeJsonMoney,
} from './sellerMoneySafety';

export const SELLER_ADS_ADDON_CURRENCY = 'USD';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/;
const REQUEST_TYPES = new Set(['start', 'update', 'stop']);
const REQUEST_STATUSES = new Set(['pending', 'approved', 'rejected']);
const SUBSCRIPTION_PLANS = new Set(['free_trial', 'starter', 'elite']);
const SUBSCRIPTION_STATUSES = new Set([
  'trial',
  'free_period',
  'active',
  'past_due',
  'cancelled',
  'blocked',
]);

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isBoundedString = (value, maxLength, { allowEmpty = true } = {}) => (
  typeof value === 'string'
  && value.length <= maxLength
  && (allowEmpty || value.trim().length > 0)
);

export const isCanonicalSellerAdsObjectId = (value) => (
  typeof value === 'string' && OBJECT_ID_PATTERN.test(value)
);

const isCanonicalIsoDate = (value) => {
  if (typeof value !== 'string' || !value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
};

const referenceId = (value) => {
  if (isCanonicalSellerAdsObjectId(value)) return value;
  if (isRecord(value) && isCanonicalSellerAdsObjectId(value._id)) return value._id;
  return null;
};

const uniqueCanonicalIds = (values) => {
  if (!Array.isArray(values)) return null;
  if (!values.every(isCanonicalSellerAdsObjectId)) return null;
  if (new Set(values).size !== values.length) return null;
  return values;
};

const sameIdSet = (left, right) => (
  left.length === right.length
  && left.every((id) => right.includes(id))
);

const inspectProduct = (product, { requireFeatured = false } = {}) => {
  if (!isRecord(product)) return null;
  if (!isCanonicalSellerAdsObjectId(product._id)) return null;
  if (!isCanonicalSellerAdsObjectId(product.seller)) return null;
  if (!isBoundedString(product.name, 200, { allowEmpty: false })) return null;
  if (!isBoundedString(product.category, 200, { allowEmpty: false })) return null;
  if (typeof product.image !== 'string') return null;
  if (!Array.isArray(product.images)) return null;
  if (!product.images.every((image) => (
    isRecord(image)
    && isBoundedString(image.url, 4096, { allowEmpty: false })
  ))) return null;
  if (typeof product.isFeatured !== 'boolean') return null;
  if (requireFeatured && product.isFeatured !== true) return null;

  const currency = exactCurrencyCode(product.currency);
  const priceCurrency = exactCurrencyCode(product.priceCurrency);
  if (!currency || !priceCurrency || currency !== priceCurrency) return null;
  if (!isExactNonNegativeJsonMoney(product.price)) return null;
  if (!isExactNonNegativeJsonMoney(product.discountedPrice)) return null;
  if (
    product.discountedPrice > 0
    && (product.price <= 0 || product.discountedPrice >= product.price)
  ) return null;

  return product;
};

export const selectSellerAdsProductMoney = (product) => {
  const currency = exactCurrencyCode(product?.currency);
  const priceCurrency = exactCurrencyCode(product?.priceCurrency);
  if (!currency || !priceCurrency || currency !== priceCurrency) return null;
  if (!isExactNonNegativeJsonMoney(product?.price)) return null;
  if (!isExactNonNegativeJsonMoney(product?.discountedPrice)) return null;
  if (
    product.discountedPrice > 0
    && (product.price <= 0 || product.discountedPrice >= product.price)
  ) return null;

  return {
    amount: product.discountedPrice > 0 ? product.discountedPrice : product.price,
    currency,
  };
};

const inspectStore = (store) => {
  if (store === null) return null;
  if (!isRecord(store)) return false;
  if (!isCanonicalSellerAdsObjectId(store._id)) return false;
  if (!isCanonicalSellerAdsObjectId(store.seller)) return false;
  if (!isBoundedString(store.storeName, 50, { allowEmpty: false })) return false;
  if (!isBoundedString(store.storeSlug, 200, { allowEmpty: false })) return false;
  if (typeof store.logo !== 'string') return false;
  return store;
};

const inspectRequestStoreReference = (store) => {
  if (store === null) return null;
  const id = referenceId(store);
  if (!id) return false;
  if (isRecord(store)) {
    if (!isBoundedString(store.storeName, 50, { allowEmpty: false })) return false;
    if (!isBoundedString(store.storeSlug, 200, { allowEmpty: false })) return false;
    if (typeof store.logo !== 'string') return false;
  }
  return id;
};

const inspectRequest = (request, { expectedSellerId = null } = {}) => {
  if (!isRecord(request)) return null;
  if (!isCanonicalSellerAdsObjectId(request._id)) return null;
  if (!isCanonicalSellerAdsObjectId(request.seller)) return null;
  if (expectedSellerId && request.seller !== expectedSellerId) return null;
  if (!REQUEST_TYPES.has(request.requestType)) return null;
  if (!REQUEST_STATUSES.has(request.status)) return null;
  if (typeof request.active !== 'boolean') return null;
  if (!isRecord(request.channels)) return null;
  if (request.channels.tiktok !== true || typeof request.channels.meta !== 'boolean') return null;
  if (!isBoundedString(request.sellerNote, 500)) return null;
  if (!isBoundedString(request.adminNote, 1000)) return null;
  if (!isCanonicalIsoDate(request.createdAt) || !isCanonicalIsoDate(request.updatedAt)) return null;
  if (Date.parse(request.updatedAt) < Date.parse(request.createdAt)) return null;

  const requestStoreId = inspectRequestStoreReference(request.store);
  if (requestStoreId === false) return null;

  if (!Array.isArray(request.products)) return null;
  const products = request.products.map((product) => inspectProduct(product));
  if (products.some((product) => !product)) return null;
  const productIds = uniqueCanonicalIds(request.productIds);
  if (!productIds) return null;
  const populatedProductIds = products.map((product) => product._id);
  if (new Set(populatedProductIds).size !== populatedProductIds.length) return null;
  if (!sameIdSet(productIds, populatedProductIds)) return null;
  if (products.some((product) => product.seller !== request.seller)) return null;

  if (request.requestType === 'stop') {
    if (productIds.length !== 0 || request.active) return null;
  } else if (productIds.length === 0) {
    return null;
  }

  const reviewedBy = request.reviewedBy;
  const reviewedAt = request.reviewedAt;
  if (request.status === 'pending') {
    if (
      request.active
      || request.adminNote !== ''
      || reviewedBy !== null
      || reviewedAt !== null
    ) return null;
  } else {
    if (!isCanonicalSellerAdsObjectId(reviewedBy) || !isCanonicalIsoDate(reviewedAt)) return null;
    if (Date.parse(reviewedAt) < Date.parse(request.createdAt)) return null;
    if (Date.parse(reviewedAt) > Date.parse(request.updatedAt)) return null;
  }
  if (request.status === 'rejected' && request.active) return null;
  if (request.active && request.status !== 'approved') return null;

  return request;
};

const descendingByCreatedAt = (requests) => requests.every((request, index) => (
  index === 0
  || Date.parse(requests[index - 1].createdAt) >= Date.parse(request.createdAt)
));

const distinctRequestIds = (requests) => (
  new Set(requests.map((request) => request._id)).size === requests.length
);

const productMoneyStateSnapshot = (product) => ({
  _id: product._id,
  seller: product.seller,
  isFeatured: product.isFeatured,
  price: product.price,
  discountedPrice: product.discountedPrice,
  currency: product.currency,
  priceCurrency: product.priceCurrency,
});

const canonicalProductSnapshot = (product) => ({
  ...productMoneyStateSnapshot(product),
  name: product.name,
  category: product.category,
  image: product.image,
  images: product.images.map((image) => image.url),
});

const canonicalRequestSnapshot = (request) => ({
  _id: request._id,
  seller: request.seller,
  store: referenceId(request.store),
  requestType: request.requestType,
  status: request.status,
  active: request.active,
  channels: {
    tiktok: request.channels.tiktok,
    meta: request.channels.meta,
  },
  sellerNote: request.sellerNote,
  adminNote: request.adminNote,
  reviewedBy: request.reviewedBy,
  reviewedAt: request.reviewedAt,
  createdAt: request.createdAt,
  updatedAt: request.updatedAt,
  productIds: [...request.productIds],
  products: request.products.map(canonicalProductSnapshot),
});

const sameCanonicalSnapshot = (left, right) => (
  JSON.stringify(left) === JSON.stringify(right)
);

export const inspectSellerAdsOverview = (payload) => {
  if (!isRecord(payload)) return null;
  if (!isRecord(payload.subscription)) return null;
  if (!SUBSCRIPTION_PLANS.has(payload.subscription.plan)) return null;
  if (!SUBSCRIPTION_STATUSES.has(payload.subscription.status)) return null;
  if (!isBoundedString(payload.subscription.planName, 120, { allowEmpty: false })) return null;
  if (typeof payload.subscription.metaAdsIncluded !== 'boolean') return null;
  if (typeof payload.isElite !== 'boolean') return null;

  const expectedElite = payload.subscription.plan === 'elite'
    && ['active', 'free_period'].includes(payload.subscription.status);
  if (payload.isElite !== expectedElite) return null;
  if (payload.subscription.metaAdsIncluded && payload.subscription.plan !== 'elite') return null;
  if (!Number.isSafeInteger(payload.metaAdsAddonCents) || payload.metaAdsAddonCents <= 0) {
    return null;
  }

  const store = inspectStore(payload.store);
  if (store === false) return null;
  const sellerId = store?.seller || null;

  if (!Array.isArray(payload.featuredProducts)) return null;
  const featuredProducts = payload.featuredProducts.map((product) => (
    inspectProduct(product, { requireFeatured: true })
  ));
  if (featuredProducts.some((product) => !product)) return null;
  if (new Set(featuredProducts.map((product) => product._id)).size !== featuredProducts.length) {
    return null;
  }

  const sellerIds = new Set(featuredProducts.map((product) => product.seller));
  if (sellerId) sellerIds.add(sellerId);
  if (sellerIds.size > 1) return null;
  const expectedSellerId = sellerId || featuredProducts[0]?.seller || null;

  const activeRequest = payload.activeRequest === null
    ? null
    : inspectRequest(payload.activeRequest, { expectedSellerId });
  if (payload.activeRequest !== null && !activeRequest) return null;
  if (activeRequest && (
    activeRequest.status !== 'approved'
    || activeRequest.active !== true
    || activeRequest.requestType === 'stop'
  )) return null;

  if (!Array.isArray(payload.pendingRequests) || payload.pendingRequests.length > 1) return null;
  if (!Array.isArray(payload.recentRequests) || payload.recentRequests.length > 12) return null;
  const pendingRequests = payload.pendingRequests.map((request) => (
    inspectRequest(request, { expectedSellerId })
  ));
  const recentRequests = payload.recentRequests.map((request) => (
    inspectRequest(request, { expectedSellerId })
  ));
  if (pendingRequests.some((request) => !request) || recentRequests.some((request) => !request)) {
    return null;
  }
  if (pendingRequests.some((request) => request.status !== 'pending' || request.active)) return null;
  if (!distinctRequestIds(pendingRequests) || !distinctRequestIds(recentRequests)) return null;
  if (!descendingByCreatedAt(pendingRequests) || !descendingByCreatedAt(recentRequests)) return null;

  const allRequests = [
    ...(activeRequest ? [activeRequest] : []),
    ...pendingRequests,
    ...recentRequests,
  ];
  const topLevelStoreId = store?._id || null;
  if (allRequests.some((request) => referenceId(request.store) !== topLevelStoreId)) return null;

  if (pendingRequests.some((request) => (
    activeRequest
      ? !['update', 'stop'].includes(request.requestType)
      : request.requestType !== 'start'
  ))) return null;

  const activeRecentRequests = recentRequests.filter((request) => request.active);
  if (activeRecentRequests.length > 1) return null;
  if (activeRecentRequests.length === 1 && (
    !activeRequest || activeRecentRequests[0]._id !== activeRequest._id
  )) return null;

  const requestSnapshotsById = new Map();
  for (const request of allRequests) {
    const snapshot = canonicalRequestSnapshot(request);
    const existing = requestSnapshotsById.get(request._id);
    if (existing && !sameCanonicalSnapshot(existing, snapshot)) return null;
    requestSnapshotsById.set(request._id, snapshot);
  }

  const allProducts = [
    ...featuredProducts,
    ...allRequests.flatMap((request) => request.products),
  ];
  const productStatesById = new Map();
  for (const product of allProducts) {
    const state = productMoneyStateSnapshot(product);
    const existing = productStatesById.get(product._id);
    if (existing && !sameCanonicalSnapshot(existing, state)) return null;
    productStatesById.set(product._id, state);
  }

  const allSellerIds = new Set([
    ...sellerIds,
    ...(activeRequest ? [activeRequest.seller] : []),
    ...pendingRequests.map((request) => request.seller),
    ...recentRequests.map((request) => request.seller),
  ]);
  if (allSellerIds.size > 1) return null;

  const recentIds = new Set(recentRequests.map((request) => request._id));
  if (pendingRequests.some((request) => !recentIds.has(request._id))) return null;
  const pendingIds = new Set(pendingRequests.map((request) => request._id));
  if (recentRequests.some((request) => (
    request.status === 'pending' && !pendingIds.has(request._id)
  ))) return null;

  return payload;
};

export const inspectSellerAdsMutationResponse = (payload, expected = {}) => {
  if (!isRecord(payload)) return null;
  if (!isBoundedString(payload.msg, 500, { allowEmpty: false })) return null;
  const request = inspectRequest(payload.request);
  if (!request || request.status !== 'pending' || request.active) return null;
  if (
    Object.prototype.hasOwnProperty.call(expected, 'sellerId')
    && request.seller !== expected.sellerId
  ) return null;
  if (
    Object.prototype.hasOwnProperty.call(expected, 'storeId')
    && referenceId(request.store) !== expected.storeId
  ) return null;
  if (expected.requestType && request.requestType !== expected.requestType) return null;
  if (typeof expected.includeMeta === 'boolean' && request.channels.meta !== expected.includeMeta) {
    return null;
  }
  if (typeof expected.sellerNote === 'string' && request.sellerNote !== expected.sellerNote) {
    return null;
  }
  if (expected.productIds !== undefined) {
    const expectedProductIds = uniqueCanonicalIds(expected.productIds);
    if (!expectedProductIds || !sameIdSet(request.productIds, expectedProductIds)) return null;
  }
  return { message: payload.msg, request };
};

export const selectSellerAdsOverviewOwnership = (overview) => {
  const verified = inspectSellerAdsOverview(overview);
  if (!verified) return null;
  const sellerId = verified.store?.seller
    || verified.featuredProducts[0]?.seller
    || verified.activeRequest?.seller
    || verified.pendingRequests[0]?.seller
    || verified.recentRequests[0]?.seller
    || null;
  if (!isCanonicalSellerAdsObjectId(sellerId)) return null;
  return {
    sellerId,
    storeId: verified.store?._id || null,
  };
};

export const sellerAdsOverviewReflectsMutation = (overview, mutation) => {
  const verifiedOverview = inspectSellerAdsOverview(overview);
  const verifiedMutationRequest = inspectRequest(mutation?.request);
  if (
    !verifiedOverview
    || !verifiedMutationRequest
    || verifiedMutationRequest.status !== 'pending'
    || verifiedMutationRequest.active
  ) return false;
  const pending = verifiedOverview.pendingRequests.find(
    (request) => request._id === verifiedMutationRequest._id
  );
  const recent = verifiedOverview.recentRequests.find(
    (request) => request._id === verifiedMutationRequest._id
  );
  if (!pending || !recent) return false;
  const mutationSnapshot = canonicalRequestSnapshot(verifiedMutationRequest);
  return sameCanonicalSnapshot(canonicalRequestSnapshot(pending), mutationSnapshot)
    && sameCanonicalSnapshot(canonicalRequestSnapshot(recent), mutationSnapshot);
};

export const formatSellerAdsUsdCents = (cents) => {
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new TypeError('Meta ads add-on cents must be a positive safe integer.');
  }
  const minor = BigInt(cents);
  return `$${minor / 100n}.${String(minor % 100n).padStart(2, '0')} ${SELLER_ADS_ADDON_CURRENCY}`;
};
