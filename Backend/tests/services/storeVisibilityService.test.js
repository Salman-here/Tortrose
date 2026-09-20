const {
  findVisibleStores,
  haversineKm,
  isStoreVisibleToBuyer,
  isStoreAvailableForDelivery,
  buyerLocationFromRequest,
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

    expect(isStoreVisibleToBuyer(store, { country: 'Pakistan', regionCode: 'PB', city: 'Lahore' })).toBe(true);
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

    expect(modes).not.toContain('global');
    expect(modes).toContain('country');
    expect(modes).toContain('city');
  });

  test('haversine distance is stable enough for radius checks', () => {
    const km = haversineKm({ lat: 31.5204, lng: 74.3587 }, { lat: 31.521, lng: 74.359 });
    expect(km).toBeGreaterThan(0);
    expect(km).toBeLessThan(1);
  });

  test('city and town names cannot match a different state or a different parent city', () => {
    const city = { visibility: normalizeStoreVisibility({ mode: 'city', country: 'United States', regionCode: 'IL', city: 'Springfield' }) };
    expect(isStoreVisibleToBuyer(city, { country: 'United States', regionCode: 'IL', city: 'Springfield' })).toBe(true);
    expect(isStoreVisibleToBuyer(city, { country: 'United States', regionCode: 'MA', city: 'Springfield' })).toBe(false);
    expect(isStoreVisibleToBuyer(city, { country: 'United States', city: 'Springfield' })).toBe(false);
    const town = { visibility: normalizeStoreVisibility({ mode: 'town', country: 'Pakistan', cityStateCode: 'PB', city: 'Lahore', town: 'Johar Town' }) };
    expect(isStoreVisibleToBuyer(town, { country: 'Pakistan', regionCode: 'PB', city: 'Lahore', town: ' johar  town ' })).toBe(true);
    expect(isStoreVisibleToBuyer(town, { country: 'Pakistan', regionCode: 'PB', city: 'Faisalabad', town: 'Johar Town' })).toBe(false);
    expect(isStoreVisibleToBuyer(town, { country: 'Pakistan', town: 'Johar Town' })).toBe(false);
  });

  test('Global and Country shopping are separate, even with stale country fields', () => {
    const globalRule = normalizeStoreVisibility({ mode: 'global', label: 'Pakistan', country: 'Pakistan' });
    expect(globalRule.label).toBe('Visible in Global shopping');
    const globalStore = { visibility: normalizeStoreVisibility({ mode: 'global' }) };
    const pkStore = { visibility: normalizeStoreVisibility({ mode: 'country', country: 'Pakistan', countryCode: 'PK' }) };
    const pkBuyer = buyerLocationFromRequest({ query: { buyerMode: 'country', buyerCountry: 'Pakistan', buyerCountryCode: 'PK' } });
    const globalBuyer = buyerLocationFromRequest({ query: { buyerMode: 'global', buyerCountry: 'Pakistan', buyerCity: 'Lahore' }, user: { savedShippingInfo: { country: 'Pakistan' } } });
    expect(globalBuyer).toMatchObject({ mode: 'global', country: '', city: '', hasCountry: false });
    expect(isStoreVisibleToBuyer(pkStore, pkBuyer)).toBe(true);
    expect(isStoreVisibleToBuyer(globalStore, pkBuyer)).toBe(false);
    expect(isStoreVisibleToBuyer(globalStore, globalBuyer)).toBe(true);
    expect(isStoreVisibleToBuyer(pkStore, globalBuyer)).toBe(false);
    expect(nonRadiusVisibilityFilter(globalBuyer)).toEqual({ 'visibility.mode': 'global' });
  });

  test('missing visibility uses a real legacy address, never unrestricted visibility or currency geography', () => {
    const legacy = { address: { country: 'Pakistan', countryCode: 'PK' } };
    const original = JSON.stringify(legacy);
    expect(isStoreVisibleToBuyer(legacy, { mode: 'country', country: 'Pakistan' })).toBe(true);
    expect(isStoreVisibleToBuyer(legacy, { mode: 'country', country: 'United States' })).toBe(false);
    expect(isStoreVisibleToBuyer(legacy, { mode: 'global' })).toBe(false);
    expect(isStoreVisibleToBuyer({}, { mode: 'global' })).toBe(false);
    expect(JSON.stringify(legacy)).toBe(original);
    expect(() => normalizeStoreVisibility({}, { seller: { currency: 'USD' } })).toThrow(/country/);
  });

  test('new addressed stores start with saved country visibility and explicit Global stays Global', async () => {
    const Store = require('../../models/Store');
    for (const mode of [undefined, 'global']) {
      const store = new Store({ seller: '111111111111111111111111', storeName: 'Visibility QA', storeSlug: 'visibility-qa', address: { country: 'Pakistan', countryCode: 'PK' }, ...(mode ? { visibility: normalizeStoreVisibility({ mode }) } : {}) });
      await store.validate();
      expect(store.visibility.mode).toBe(mode || 'country');
      expect(store.address.country).toBe('Pakistan');
      if (!mode) expect(store.visibility.countryKey).toBe('pakistan');
    }
  });

  test('a Global purchase can ship to Pakistan but country-limited stores must match delivery', () => {
    const globalStore = { visibility: normalizeStoreVisibility({ mode: 'global' }) };
    const pkStore = { visibility: normalizeStoreVisibility({ mode: 'country', country: 'Pakistan' }) };
    expect(isStoreAvailableForDelivery(globalStore, { country: 'Pakistan' })).toBe(true);
    expect(isStoreAvailableForDelivery(pkStore, { country: 'Pakistan', mode: 'global' })).toBe(true);
    expect(isStoreAvailableForDelivery(pkStore, { country: 'United States', mode: 'global' })).toBe(false);
    expect(isStoreAvailableForDelivery({}, { country: 'Pakistan' })).toBe(false);
  });

  test('malformed modes/countries and unselected country shopping fail safely', () => {
    expect(() => normalizeStoreVisibility({ mode: 'everything' })).toThrow(/visibility/);
    expect(() => normalizeStoreVisibility({ mode: 'country', country: 'Pakistan', countryCode: 'US' })).toThrow(/matching country/);
    expect(() => normalizeBuyerLocation({ mode: 'everything' })).toThrow(/Country or Global/);
    expect(nonRadiusVisibilityFilter({ mode: 'country' })).toEqual({ _id: { $in: [] } });
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
