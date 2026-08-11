export const filterProductsByQuery = (products, query) => {
  if (!Array.isArray(products)) return [];
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) return products;
  return products.filter((product) => [product?.name, product?.category, product?.brand]
    .some((value) => String(value || '').toLowerCase().includes(normalizedQuery)));
};

export const normalizeProductResponse = (data) => {
  if (Array.isArray(data)) return { products: data, pagination: null };
  return {
    products: Array.isArray(data?.products) ? data.products : [],
    pagination: data?.pagination || null,
  };
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
  const ids = Array.isArray(productIds)
    ? [...new Set(productIds.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];
  if (ids.length === 0) return { isValid: false, ids, message: 'Select at least one product first.' };
  if (ids.length > max) return { isValid: false, ids, message: `Select no more than ${max} products at a time.` };
  return { isValid: true, ids, message: '' };
};
