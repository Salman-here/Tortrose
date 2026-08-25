export const filterProductsByQuery = (products, query) => {
  if (!Array.isArray(products)) return [];
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) return products;
  return products.filter((product) => [product?.name, product?.category, product?.brand]
    .some((value) => String(value || '').toLowerCase().includes(normalizedQuery)));
};

export const inspectProductPagination = (pagination, {
  productCount,
  expectedPage,
  expectedLimit,
} = {}) => {
  if (!pagination || typeof pagination !== 'object' || Array.isArray(pagination)) {
    return { valid: false };
  }
  const { page, limit, totalProducts, totalPages, hasMore } = pagination;
  const valuesAreValid = Number.isSafeInteger(page) && page >= 1
    && Number.isSafeInteger(limit) && limit >= 1
    && Number.isSafeInteger(totalProducts) && totalProducts >= 0
    && Number.isSafeInteger(totalPages) && totalPages >= 1
    && typeof hasMore === 'boolean'
    && Number.isSafeInteger(productCount) && productCount >= 0 && productCount <= limit
    && (expectedPage === undefined || page === expectedPage)
    && (expectedLimit === undefined || limit === expectedLimit);
  if (!valuesAreValid) return { valid: false };
  const calculatedPages = Math.max(1, Math.ceil(totalProducts / limit));
  const pageStartsAt = (page - 1) * limit;
  const countFitsPage = page <= totalPages
    ? pageStartsAt + productCount <= totalProducts
    : productCount === 0;
  if (
    totalPages !== calculatedPages
    || hasMore !== (page < totalPages)
    || !countFitsPage
  ) return { valid: false };
  return { valid: true, page, limit, totalProducts, totalPages, hasMore };
};

export const normalizeProductResponse = (data, {
  expectedPage,
  expectedLimit,
} = {}) => {
  if (Array.isArray(data)) return { products: data, pagination: null };
  if (!data || typeof data !== 'object' || !Array.isArray(data.products)) {
    throw new Error('Product list data is unavailable.');
  }
  const pagination = inspectProductPagination(data.pagination, {
    productCount: data.products.length,
    expectedPage,
    expectedLimit,
  });
  if (!pagination.valid) throw new Error('Product pagination data is unavailable.');
  return { products: data.products, pagination };
};

export const mergeProducts = (current = [], next = []) => {
  const seen = new Set();
  return [...current, ...next].filter((product) => {
    const id = product?._id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

export const normalizeProductCategories = (...sources) => {
  const categoryMap = new Map();
  sources.flat().forEach((value) => {
    const category = typeof value === 'object' ? value?.category : value;
    const clean = String(category || '').trim();
    if (!clean) return;
    const key = clean.toLocaleLowerCase();
    if (!categoryMap.has(key)) categoryMap.set(key, clean);
  });
  return [...categoryMap.values()].sort((left, right) => left.localeCompare(right));
};

export const buildProductListParams = ({ page, limit, currency, searchQuery, selectedCategory }) => ({
  page,
  limit,
  currency,
  search: String(searchQuery || '').trim() || undefined,
  categories: selectedCategory && selectedCategory !== 'all' ? selectedCategory : undefined,
  sortBy: 'newest',
  sortOrder: 'desc',
});

export const getManagedProductImage = (product) => {
  const primaryImage = product?.image;
  if (typeof primaryImage === 'string' && primaryImage.trim()) return primaryImage.trim();
  const firstImage = product?.images?.[0];
  if (typeof firstImage === 'string') return firstImage;
  return firstImage?.url || null;
};

export const isProductHiddenByModeration = (product) => (
  product?.isBlocked === true || product?.moderationStatus === 'blocked'
);

export const getProductModerationReason = (product) => (
  String(product?.blockedReason || product?.moderationReason || '').trim()
  || 'Review the product details to make it visible.'
);

export const validateBulkActionSelection = (productIds, { max = Number.POSITIVE_INFINITY } = {}) => {
  const isCanonicalProductId = value => typeof value === 'string' && /^[a-f\d]{24}$/iu.test(value);
  const rawIds = Array.isArray(productIds) ? productIds : [];
  if (rawIds.some(id => !isCanonicalProductId(id))) {
    return { isValid: false, ids: [], message: 'Refresh products before continuing because one or more identifiers are invalid.' };
  }
  const ids = [...new Set(rawIds)];
  if (ids.length === 0) return { isValid: false, ids, message: 'Select at least one product first.' };
  if (ids.length > max) return { isValid: false, ids, message: `Select no more than ${max} products at a time.` };
  return { isValid: true, ids, message: '' };
};
