import { fetchCompleteSellerCatalog } from '../../src/utils/sellerCatalog';

describe('complete seller catalog loading', () => {
  it('loads every paginated page so dashboard totals are accurate', async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) => ({ _id: `p-${index + 1}` }));
    const pageTwo = Array.from({ length: 100 }, (_, index) => ({ _id: `p-${index + 101}` }));
    const pageThree = [{ _id: 'p-201' }];
    const apiClient = {
      get: jest.fn()
        .mockResolvedValueOnce({ data: { products: pageOne, pagination: { page: 1, limit: 100, totalProducts: 201, totalPages: 3, hasMore: true } } })
        .mockResolvedValueOnce({ data: { products: pageTwo, pagination: { page: 2, limit: 100, totalProducts: 201, totalPages: 3, hasMore: true } } })
        .mockResolvedValueOnce({ data: { products: pageThree, pagination: { page: 3, limit: 100, totalProducts: 201, totalPages: 3, hasMore: false } } }),
    };

    const products = await fetchCompleteSellerCatalog(apiClient);
    expect(products).toHaveLength(201);
    expect(products[0]).toEqual({ _id: 'p-1' });
    expect(products[200]).toEqual({ _id: 'p-201' });
    expect(apiClient.get).toHaveBeenCalledTimes(3);
    expect(apiClient.get).toHaveBeenNthCalledWith(1, '/api/products/get-seller-products', {
      params: { page: 1, limit: 100, sortBy: 'newest', sortOrder: 'desc' },
    });
  });

  it('supports the legacy unpaginated response shape', async () => {
    const apiClient = { get: jest.fn().mockResolvedValue({ data: [{ _id: '1' }] }) };
    await expect(fetchCompleteSellerCatalog(apiClient)).resolves.toEqual([{ _id: '1' }]);
  });

  it('rejects duplicate product identities instead of inflating inventory counts', async () => {
    const apiClient = {
      get: jest.fn().mockResolvedValue({ data: [{ _id: 'same' }, { _id: 'same' }] }),
    };
    await expect(fetchCompleteSellerCatalog(apiClient)).rejects.toThrow('invalid product identities');
  });

  it('rejects coercible or incomplete pagination instead of returning a partial catalog', async () => {
    const coercible = {
      get: jest.fn().mockResolvedValue({
        data: {
          products: [{ _id: '1' }],
          pagination: { page: 1, limit: 100, totalProducts: 2, totalPages: '2', hasMore: true },
        },
      }),
    };
    await expect(fetchCompleteSellerCatalog(coercible)).rejects.toThrow('pagination response is invalid');

    const incomplete = {
      get: jest.fn()
        .mockResolvedValueOnce({
          data: {
            products: [{ _id: '1' }],
            pagination: { page: 1, limit: 100, totalProducts: 2, totalPages: 1, hasMore: false },
          },
        }),
    };
    await expect(fetchCompleteSellerCatalog(incomplete)).rejects.toThrow('catalog response is incomplete');
  });
});
