jest.mock('../../models/Store', () => ({
  find: jest.fn(),
  exists: jest.fn(),
}));
jest.mock('../../models/User', () => ({
  find: jest.fn(),
  exists: jest.fn(),
}));

const Store = require('../../models/Store');
const User = require('../../models/User');
const {
  activeStoreQuery,
  applyActiveSellerProductFilter,
  getActiveSellerIds,
  isProductSellerPubliclyActive,
  PUBLIC_STORE_SLUG_CLAUSE,
} = require('../../services/publicCatalogService');

describe('publicCatalogService', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('builds active store queries with trial-blocked stores excluded', () => {
    expect(activeStoreQuery({ seller: 'seller-1' })).toEqual({
      isActive: true,
      blockedAt: null,
      seller: 'seller-1',
      $and: [PUBLIC_STORE_SLUG_CLAUSE],
    });
  });

  test('callers cannot override the public active-store contract', () => {
    expect(activeStoreQuery({ isActive: false, blockedAt: new Date('2026-01-01') })).toMatchObject({
      isActive: true,
      blockedAt: null,
      $and: [PUBLIC_STORE_SLUG_CLAUSE],
    });
  });

  test('adds active seller visibility to public product filters', () => {
    expect(applyActiveSellerProductFilter({ stock: { $gt: 0 } }, ['seller-1'])).toEqual({
      stock: { $gt: 0 },
      $and: [
        {
          $or: [
            { seller: null },
            { seller: { $exists: false } },
            { seller: { $in: ['seller-1'] } },
          ],
        },
      ],
    });
  });

  test('loads only active seller ids', async () => {
    const lean = jest.fn().mockResolvedValue([{ seller: 'seller-1' }, { seller: null }, { seller: 'seller-2' }]);
    const select = jest.fn(() => ({ lean }));
    Store.find.mockReturnValue({ select });
    const userLean = jest.fn().mockResolvedValue([{ _id: 'seller-2' }]);
    const userSelect = jest.fn(() => ({ lean: userLean }));
    User.find.mockReturnValue({ select: userSelect });

    await expect(getActiveSellerIds({ 'verification.isVerified': true })).resolves.toEqual(['seller-2']);
    expect(Store.find).toHaveBeenCalledWith({
      isActive: true,
      blockedAt: null,
      'verification.isVerified': true,
      $and: [PUBLIC_STORE_SLUG_CLAUSE],
    });
    expect(select).toHaveBeenCalledWith('seller');
    expect(User.find).toHaveBeenCalledWith({
      _id: { $in: ['seller-1', 'seller-2'] },
      role: 'seller',
      status: 'active',
    });
  });

  test('treats products without a seller as public but blocks inactive seller products', async () => {
    await expect(isProductSellerPubliclyActive(null)).resolves.toBe(true);

    Store.exists.mockResolvedValueOnce(null);
    User.exists.mockResolvedValueOnce(true);
    await expect(isProductSellerPubliclyActive('blocked-seller')).resolves.toBe(false);
    expect(Store.exists).toHaveBeenCalledWith({
      isActive: true,
      blockedAt: null,
      seller: 'blocked-seller',
      $and: [PUBLIC_STORE_SLUG_CLAUSE],
    });

    Store.exists.mockResolvedValueOnce(true);
    User.exists.mockResolvedValueOnce(null);
    await expect(isProductSellerPubliclyActive('deleted-seller')).resolves.toBe(false);
    expect(User.exists).toHaveBeenCalledWith({
      _id: 'deleted-seller',
      role: 'seller',
      status: 'active',
    });
  });
});
