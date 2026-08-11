import api from '../config/api';

/**
 * Load the complete seller catalog while respecting the backend's 100-item
 * page limit. Dashboard totals and stock alerts must not silently become a
 * first-page sample when a store grows beyond the default page size.
 */
export async function fetchCompleteSellerCatalog(apiClient = api) {
  const requestPage = (page) => apiClient.get('/api/products/get-seller-products', {
    params: { page, limit: 100, sortBy: 'newest', sortOrder: 'desc' },
  });

  const firstResponse = await requestPage(1);
  const totalPages = Math.max(1, Number(firstResponse.data?.pagination?.totalPages || 1));
  const remainingResponses = totalPages > 1
    ? await Promise.all(Array.from({ length: totalPages - 1 }, (_, index) => requestPage(index + 2)))
    : [];

  return [firstResponse, ...remainingResponses].flatMap((response) => {
    const pageProducts = response.data?.products || response.data || [];
    return Array.isArray(pageProducts) ? pageProducts : [];
  });
}

export function getProductImage(product) {
  if (product?.image) return product.image;
  const first = product?.images?.[0];
  return typeof first === 'string' ? first : first?.url || '';
}
