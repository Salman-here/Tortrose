const {
  findVisibleStores,
  haversineKm,
  isStoreVisibleToBuyer,
  nonRadiusVisibilityFilter,
  normalizeBuyerLocation,
  normalizeStoreVisibility,
} = require('../../services/storeVisibilityService');
const User = require('../../models/User');

describe('storeVisibilityService', () => {
  test('defaults seller visibility to seller country', () => {
    const visibility = normalizeStoreVisibility({}, {
      store: { address: { country: 'Pakistan' } },
      seller: { currency: 'USD' },
    });

    expect(visibility.mode).toBe('country');
    expect(visibility.country).toBe('Pakistan');
    expect(visibility.countryKey).toBe('pakistan');
  });

  test('matches city visibility only inside the selected city and country', () => {
    const store = {
      visibility: normalizeStoreVisibility({
        mode: 'city',
        country: 'Pakistan',
        region: 'Punjab',
        city: 'Lahore',
      }),
    };

    expect(isStoreVisibleToBuyer(store, { country: 'Pakistan', city: 'Lahore' })).toBe(true);
    expect(isStoreVisibleToBuyer(store, { country: 'Pakistan', city: 'Karachi' })).toBe(false);
    expect(isStoreVisibleToBuyer(store, { country: 'United States', city: 'Lahore' })).toBe(false);
  });

  test('matches radius visibility using buyer coordinates', () => {
    const store = {
      visibility: normalizeStoreVisibility({
        mode: 'radius',
        country: 'Pakistan',
        city: 'Lahore',
        lat: 31.5204,
        lng: 74.3587,
        radiusKm: 5,
      }),
    };

    expect(isStoreVisibleToBuyer(store, { lat: 31.521, lng: 74.359 })).toBe(true);
    expect(isStoreVisibleToBuyer(store, { lat: 24.8607, lng: 67.0011 })).toBe(false);
  });

  test('builds non-radius filter for country and city scopes', () => {
    const buyer = normalizeBuyerLocation({ country: 'Pakistan', city: 'Lahore' });
    const filter = nonRadiusVisibilityFilter(buyer);
    const modes = filter.$or.map(entry => entry['visibility.mode']).filter(Boolean);

    expect(modes).toContain('global');
    expect(modes).toContain('country');
    expect(modes).toContain('city');
  });

  test('haversine distance is stable enough for radius checks', () => {
    const km = haversineKm({ lat: 31.5204, lng: 74.3587 }, { lat: 31.521, lng: 74.359 });
    expect(km).toBeGreaterThan(0);
    expect(km).toBeLessThan(1);
  });

  test('excludes an otherwise active store when its seller account is missing', async () => {
    const activeSellerId = '111111111111111111111111';
    const orphanSellerId = '222222222222222222222222';
    const protectedSellerId = '333333333333333333333333';
    const stores = [
      { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', seller: activeSellerId, storeSlug: 'ordinary-store' },
      { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', seller: orphanSellerId },
      { _id: 'cccccccccccccccccccccccc', seller: protectedSellerId, storeSlug: 'rozare-legacy-store' },
    ];
    const lean = jest.fn().mockResolvedValue(stores);
    const StoreModel = { find: jest.fn(() => ({ lean })) };
    const userLean = jest.fn().mockResolvedValue([{ _id: activeSellerId }, { _id: protectedSellerId }]);
    const userSelect = jest.fn(() => ({ lean: userLean }));
    const userFind = jest.spyOn(User, 'find').mockReturnValue({ select: userSelect });

    await expect(findVisibleStores(StoreModel, { isActive: true }, {}, {}))
      .resolves.toEqual([stores[0]]);
    expect(userFind).toHaveBeenCalledWith({
      _id: { $in: [activeSellerId, orphanSellerId, protectedSellerId] },
      role: 'seller',
      status: 'active',
    });

    userFind.mockRestore();
  });
});
