const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../controllers/mailController', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));

const Store = require('../../models/Store');
const User = require('../../models/User');
const { validateStoreSlug } = require('../../utils/storeSlug');
const { checkSubdomainAvailability, createStore, updateStore } = require('../../controllers/storeController');

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
  test('store creation rejects an explicitly unsupported product currency before persistence', async () => {
    const seller = await User.create({
      username: 'invalid-currency-seller',
      email: 'invalid-currency-seller@example.com',
      role: 'seller',
      isVerified: true,
    });
    const response = responseMock();

    await createStore({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { storeName: 'Invalid Currency Store', productCurrency: 'DOGE' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PRODUCT_CURRENCY_NOT_SUPPORTED',
    }));
    await expect(Store.countDocuments({ seller: seller._id })).resolves.toBe(0);
  });

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

  test('cannot change the slug while a paid subdomain Checkout owns the resource lock', async () => {
    const seller = await User.create({
      username: 'slug-checkout-lock-seller',
      email: 'slug-checkout-lock@example.com',
      role: 'seller',
      isVerified: true,
    });
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Checkout Locked Store',
      storeSlug: 'checkout-locked-store',
      subdomainResourceLock: {
        kind: 'checkout',
        token: 'checkout-lock-token',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const response = responseMock();

    await updateStore({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { storeSlug: 'replacement-while-paying' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(423);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SUBDOMAIN_RESOURCE_LOCKED',
    }));
    const unchanged = await Store.findById(store._id);
    expect(unchanged.storeSlug).toBe('checkout-locked-store');
    expect(unchanged.subdomainResourceLock.token).toBe('checkout-lock-token');
  });

  test('serializes a valid slug change and releases its short-lived lock after saving', async () => {
    const seller = await User.create({
      username: 'slug-serialized-seller',
      email: 'slug-serialized@example.com',
      role: 'seller',
      isVerified: true,
    });
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Serialized Slug Store',
      storeSlug: 'serialized-slug-store',
    });
    const response = responseMock();

    await updateStore({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { storeSlug: 'serialized-new-slug' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(200);
    const updated = await Store.findById(store._id);
    expect(updated.storeSlug).toBe('serialized-new-slug');
    expect(updated.subdomainResourceLock.token).toBe('');
    expect(updated.subdomainResourceLock.kind).toBeNull();
  });

  test('commits slug and other validated settings in the same locked compare-and-set', async () => {
    const seller = await User.create({
      username: 'slug-combined-seller',
      email: 'slug-combined@example.com',
      role: 'seller',
      isVerified: true,
    });
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Combined Settings Store',
      storeSlug: 'combined-settings-store',
      description: 'Before',
      paymentPolicy: 'online_and_cod',
    });
    const response = responseMock();

    await updateStore({
      user: { id: seller._id.toString(), role: 'seller' },
      body: {
        storeSlug: 'combined-new-slug',
        description: 'After the atomic hostname change',
        paymentPolicy: 'advance_only',
        socialLinks: { website: 'https://example.com' },
      },
    }, response);

    expect(response.status).toHaveBeenCalledWith(200);
    const updated = await Store.findById(store._id);
    expect(updated).toMatchObject({
      storeSlug: 'combined-new-slug',
      description: 'After the atomic hostname change',
      paymentPolicy: 'advance_only',
      socialLinks: { website: 'https://example.com' },
      subdomainResourceLock: { kind: null, token: '' },
    });
    expect(updated.subdomainSlugHistory).toHaveLength(1);
  });
});
