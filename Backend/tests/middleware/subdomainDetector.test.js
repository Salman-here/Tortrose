jest.mock('../../models/Store', () => ({
  findOne: jest.fn(),
}));

jest.mock('../../services/publicCatalogService', () => ({
  findActiveStore: jest.fn(),
}));

const Store = require('../../models/Store');
const { findActiveStore } = require('../../services/publicCatalogService');
const subdomainDetector = require('../../middleware/subdomainDetector');

const requestFor = (slug) => ({
  query: { slug },
  get: jest.fn(() => ''),
});

describe('subdomain seller lifecycle guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('exposes a subdomain only when its owner is still an active seller', async () => {
    const store = { _id: 'store-1', storeSlug: 'live-store', isActive: true };
    findActiveStore.mockResolvedValue(store);
    const req = requestFor('live-store');
    const next = jest.fn();

    await subdomainDetector(req, {}, next);

    expect(req.subdomainStore).toBe(store);
    expect(findActiveStore).toHaveBeenCalledWith(
      { storeSlug: 'live-store' },
      { lean: false }
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('does not expose an active orphan store left by a legacy deletion', async () => {
    findActiveStore.mockResolvedValue(null);
    Store.findOne.mockResolvedValue({
      _id: 'orphan-store',
      storeSlug: 'orphan-store',
      isActive: true,
    });
    const req = requestFor('orphan-store');
    const next = jest.fn();

    await subdomainDetector(req, {}, next);

    expect(req.subdomainStore).toBeUndefined();
    expect(req.subdomainStoreBlocked).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
