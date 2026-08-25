import api from '../config/api';

const MAX_COMPLETE_CATALOG_PAGES = 100;

const catalogProductsHaveUniqueIds = (products) => {
  if (!Array.isArray(products)) return false;
  const ids = products.map((product) => (
    typeof product?._id === 'string' ? product._id.trim() : ''
  ));
  return ids.every(Boolean) && new Set(ids).size === ids.length;
};

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
  if (Array.isArray(firstResponse.data)) {
    if (!catalogProductsHaveUniqueIds(firstResponse.data)) {
      throw new Error('The seller catalog response contains invalid product identities.');
    }
    return firstResponse.data;
  }

  const firstProducts = firstResponse.data?.products;
  const pagination = firstResponse.data?.pagination;
  if (
    !Array.isArray(firstProducts)
    || !pagination
    || typeof pagination !== 'object'
    || pagination.page !== 1
    || pagination.limit !== 100
    || !Number.isSafeInteger(pagination.totalProducts)
    || pagination.totalProducts < 0
    || !Number.isSafeInteger(pagination.totalPages)
    || pagination.totalPages < 1
    || pagination.totalPages > MAX_COMPLETE_CATALOG_PAGES
    || pagination.totalPages !== Math.max(1, Math.ceil(pagination.totalProducts / pagination.limit))
    || pagination.hasMore !== (pagination.totalPages > 1)
  ) throw new Error('The seller catalog pagination response is invalid.');

  const totalPages = pagination.totalPages;
  const remainingResponses = [];
  for (let firstPage = 2; firstPage <= totalPages; firstPage += 5) {
    const lastPage = Math.min(totalPages, firstPage + 4);
    const batch = await Promise.all(
      Array.from({ length: lastPage - firstPage + 1 }, (_, index) => requestPage(firstPage + index)),
    );
    remainingResponses.push(...batch);
  }
  const responses = [firstResponse, ...remainingResponses];
  const products = responses.flatMap((response, index) => {
    const pageProducts = response.data?.products;
    const page = response.data?.pagination;
    const expectedPage = index + 1;
    if (
      !Array.isArray(pageProducts)
      || !page
      || page.page !== expectedPage
      || page.limit !== pagination.limit
      || page.totalProducts !== pagination.totalProducts
      || page.totalPages !== pagination.totalPages
      || page.hasMore !== (expectedPage < totalPages)
      || pageProducts.length > pagination.limit
    ) throw new Error('The seller catalog page response is inconsistent.');
    return pageProducts;
  });
  if (products.length !== pagination.totalProducts) {
    throw new Error('The seller catalog response is incomplete.');
  }
  if (!catalogProductsHaveUniqueIds(products)) {
    throw new Error('The seller catalog response contains duplicate or invalid product identities.');
  }
  return products;
}

export function getProductImage(product) {
  if (product?.image) return product.image;
  const first = product?.images?.[0];
  return typeof first === 'string' ? first : first?.url || '';
}
