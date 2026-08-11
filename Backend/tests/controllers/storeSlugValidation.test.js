const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../controllers/mailController', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));

const Store = require('../../models/Store');
const User = require('../../models/User');
const { validateStoreSlug } = require('../../utils/storeSlug');
const { checkSubdomainAvailability, updateStore } = require('../../controllers/storeController');

let mongoServer;

const responseMock = () => {
  const response = {};
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  return response;
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 60000);

afterEach(async () => {
  await Promise.all([Store.deleteMany({}), User.deleteMany({})]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60000);

describe('seller subdomain hostname contract', () => {
  test.each([
    ['ab', 'INVALID_SUBDOMAIN_LENGTH'],
    ['a'.repeat(64), 'INVALID_SUBDOMAIN_LENGTH'],
    ['bad.slug', 'INVALID_SUBDOMAIN_FORMAT'],
    ['bad/slug', 'INVALID_SUBDOMAIN_FORMAT'],
    ['bad_slug', 'INVALID_SUBDOMAIN_FORMAT'],
    ['-edge', 'INVALID_SUBDOMAIN_FORMAT'],
    ['edge-', 'INVALID_SUBDOMAIN_FORMAT'],
    ['دکان', 'INVALID_SUBDOMAIN_FORMAT'],
    ['admin', 'RESERVED_SUBDOMAIN'],
  ])('rejects invalid or protected hostname %s', (slug, code) => {
    expect(validateStoreSlug(slug)).toMatchObject({ valid: false, code });
  });

  test('normalizes a valid hostname to lowercase', () => {
    expect(validateStoreSlug('  Premium-Shop  ')).toEqual({
      valid: true,
      slug: 'premium-shop',
    });
  });

  test('availability API rejects syntax instead of silently stripping it', async () => {
    const response = responseMock();
    await checkSubdomainAvailability({ params: { slug: 'premium.shop' }, user: null }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      available: false,
      code: 'INVALID_SUBDOMAIN_FORMAT',
    }));
  });

  test('direct seller update cannot persist invalid hostname characters', async () => {
    const seller = await User.create({
      username: 'slug-seller',
      email: 'slug-seller@example.com',
      role: 'seller',
      isVerified: true,
    });
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Slug Store',
      storeSlug: 'slug-store',
    });
    const response = responseMock();

    await updateStore({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { storeSlug: 'other/store' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'INVALID_SUBDOMAIN_FORMAT',
    }));
    await expect(Store.findById(store._id).then(doc => doc.storeSlug)).resolves.toBe('slug-store');
  });

  test('retains the existing 30-day cooldown for otherwise valid changes', async () => {
    const seller = await User.create({
      username: 'slug-cooldown-seller',
      email: 'slug-cooldown@example.com',
      role: 'seller',
      isVerified: true,
    });
    await Store.create({
      seller: seller._id,
      storeName: 'Cooldown Store',
      storeSlug: 'cooldown-store',
      lastSlugChangeAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });
    const response = responseMock();

    await updateStore({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { storeSlug: 'new-valid-slug' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(423);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      cooldown: expect.objectContaining({ field: 'storeSlug', cooldownDays: 30 }),
    }));
  });
});
