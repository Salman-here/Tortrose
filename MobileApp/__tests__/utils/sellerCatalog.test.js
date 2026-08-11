import { fetchCompleteSellerCatalog } from '../../src/utils/sellerCatalog';

describe('complete seller catalog loading', () => {
  it('loads every paginated page so dashboard totals are accurate', async () => {
    const apiClient = {
      get: jest.fn()
        .mockResolvedValueOnce({ data: { products: [{ _id: '1' }], pagination: { totalPages: 3 } } })
        .mockResolvedValueOnce({ data: { products: [{ _id: '2' }] } })
        .mockResolvedValueOnce({ data: { products: [{ _id: '3' }] } }),
    };

    await expect(fetchCompleteSellerCatalog(apiClient)).resolves.toEqual([
      { _id: '1' }, { _id: '2' }, { _id: '3' },
    ]);
    expect(apiClient.get).toHaveBeenCalledTimes(3);
    expect(apiClient.get).toHaveBeenNthCalledWith(1, '/api/products/get-seller-products', {
      params: { page: 1, limit: 100, sortBy: 'newest', sortOrder: 'desc' },
    });
  });

  it('supports the legacy unpaginated response shape', async () => {
    const apiClient = { get: jest.fn().mockResolvedValue({ data: [{ _id: '1' }] }) };
    await expect(fetchCompleteSellerCatalog(apiClient)).resolves.toEqual([{ _id: '1' }]);
  });
});
