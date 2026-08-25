import {
  buildProductListParams,
  filterProductsByQuery,
  getManagedProductImage,
  getProductModerationReason,
  inspectProductPagination,
  isProductHiddenByModeration,
  mergeProducts,
  normalizeProductCategories,
  normalizeProductResponse,
  validateBulkActionSelection,
} from '../../src/utils/productManagement';

describe('seller product management contracts', () => {
  const products = [
    { _id: '1', name: 'Leather Wallet', category: 'Accessories', brand: 'Rozare', image: 'https://cdn.example.com/main.jpg' },
    { _id: '2', name: 'Travel Bag', category: 'Fashion', brand: 'Studio', images: [{ url: 'https://cdn.example.com/bag.jpg' }] },
  ];

  it('searches product name, category, and brand without assuming string values', () => {
    expect(filterProductsByQuery(products, 'studio')).toEqual([products[1]]);
    expect(filterProductsByQuery([...products, { _id: '3', name: 123 }], '123')).toHaveLength(1);
  });

  it('builds the seller endpoint parameters for server search, category filtering, and stable sorting', () => {
    expect(buildProductListParams({
      page: 2,
      limit: 24,
      currency: 'USD',
      searchQuery: ' wallet ',
      selectedCategory: 'Accessories',
    })).toEqual({
      page: 2,
      limit: 24,
      currency: 'USD',
      search: 'wallet',
      categories: 'Accessories',
      sortBy: 'newest',
      sortOrder: 'desc',
    });
  });

  it('omits inactive search and category filters', () => {
    const params = buildProductListParams({ page: 1, limit: 24, currency: 'PKR', searchQuery: '', selectedCategory: 'all' });
    expect(params.search).toBeUndefined();
    expect(params.categories).toBeUndefined();
  });

  it('normalizes strictly paginated and legacy product responses', () => {
    const pagination = { page: 1, limit: 24, totalProducts: 2, totalPages: 1, hasMore: false };
    expect(normalizeProductResponse({ products, pagination }, { expectedPage: 1, expectedLimit: 24 }))
      .toEqual({ products, pagination: { valid: true, ...pagination } });
    expect(normalizeProductResponse(products)).toEqual({ products, pagination: null });
  });

  it('rejects corrupt or inconsistent product pagination instead of fabricating counts', () => {
    const pagination = { page: 2, limit: 2, totalProducts: 3, totalPages: 2, hasMore: false };
    expect(inspectProductPagination(pagination, { productCount: 1, expectedPage: 2, expectedLimit: 2 }))
      .toEqual({ valid: true, ...pagination });
    for (const invalid of [
      { ...pagination, page: '2' },
      { ...pagination, totalProducts: 0 },
      { ...pagination, totalPages: 3 },
      { ...pagination, hasMore: true },
    ]) {
      expect(() => normalizeProductResponse({ products: [products[0]], pagination: invalid }, {
        expectedPage: 2,
        expectedLimit: 2,
      })).toThrow('Product pagination data is unavailable.');
    }
  });

  it('merges paginated products without duplicate IDs', () => {
    expect(mergeProducts([products[0]], products)).toEqual(products);
  });

  it('normalizes category values from filters and products', () => {
    expect(normalizeProductCategories([' fashion ', 'Accessories'], [{ category: 'FASHION' }, { category: 'Custom' }]))
      .toEqual(['Accessories', 'Custom', 'fashion']);
  });

  it('prefers the explicit primary image and falls back to gallery documents', () => {
    expect(getManagedProductImage(products[0])).toBe('https://cdn.example.com/main.jpg');
    expect(getManagedProductImage(products[1])).toBe('https://cdn.example.com/bag.jpg');
  });

  it('recognizes both moderation block fields and surfaces the backend reason', () => {
    const blocked = { isBlocked: true, blockedReason: 'Replace placeholder details.' };
    expect(isProductHiddenByModeration(blocked)).toBe(true);
    expect(isProductHiddenByModeration({ moderationStatus: 'blocked' })).toBe(true);
    expect(getProductModerationReason(blocked)).toBe('Replace placeholder details.');
  });

  it('accepts only canonical product IDs, deduplicates them, and enforces the backend delete limit', () => {
    const idA = '64b000000000000000000001';
    const idB = '64b000000000000000000002';
    expect(validateBulkActionSelection([idA, idA, idB])).toEqual({ isValid: true, ids: [idA, idB], message: '' });
    expect(validateBulkActionSelection([idA, '1', true])).toEqual({
      isValid: false,
      ids: [],
      message: expect.stringContaining('identifiers'),
    });
    const tooMany = validateBulkActionSelection(Array.from({ length: 251 }, (_, index) => index.toString(16).padStart(24, '0')), { max: 250 });
    expect(tooMany.isValid).toBe(false);
    expect(tooMany.message).toContain('250');
  });
});
