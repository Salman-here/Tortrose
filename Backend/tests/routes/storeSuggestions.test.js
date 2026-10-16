'use strict';

const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../../models/User');
const Store = require('../../models/Store');
const UserBlock = require('../../models/UserBlock');
const stores = require('../../controllers/storeController');
const { normalizeStoreVisibility } = require('../../services/storeVisibilityService');
const approvedCatalogFixture = require('../helpers/approvedCatalogFixture');

let mongo, app, fixture;
const pk = { buyerMode: 'country', buyerCountry: 'Pakistan', buyerCountryCode: 'PK' };
const globalPk = { ...pk, buyerMode: 'global' };
const slugs = response => response.body.suggestions.map(store => store.storeSlug).sort();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = express();
  // Isolated test identity; public requests remain anonymous unless explicitly set.
  app.use((req, _res, next) => {
    if (req.headers['x-test-buyer']) req.user = { id: req.headers['x-test-buyer'] };
    next();
  });
  app.get('/api/stores/suggestions', stores.getStoreSuggestions);
  app.get('/api/stores/search', stores.searchStores);
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
}, 60000);

async function makeStore(key, overrides = {}, sellerOverrides = {}) {
  const seller = await User.create({
    username: 'Search seller ' + key,
    email: key + '@example.com',
    role: 'seller',
    status: 'active',
    ...sellerOverrides,
  });
  const store = await Store.create({
    ...approvedCatalogFixture(),
    seller: seller._id,
    storeName: 'Safepay ' + key,
    storeSlug: 'safe-' + key,
    description: 'Everyday travel accessories.',
    isActive: true,
    visibility: normalizeStoreVisibility({ mode: 'country', country: 'Pakistan' }),
    ...overrides,
  });
  return { seller, store };
}

beforeEach(async () => {
  await Promise.all([User, Store, UserBlock].map(Model => Model.deleteMany({})));
  fixture = {
    pk: await makeStore('pk'),
    global: await makeStore('global', { visibility: normalizeStoreVisibility({ mode: 'global' }) }),
    us: await makeStore('us', { visibility: normalizeStoreVisibility({ mode: 'country', country: 'United States' }) }),
    city: await makeStore('city', { visibility: normalizeStoreVisibility({ mode: 'city', country: 'Pakistan', regionCode: 'PB', city: 'Lahore' }) }),
  };
});

test.each(['safe', '  SaFe  ', 'safe-pk', 'travel accessories'])('autocomplete returns eligible matches for %j with the real database projection', async q => {
  const suggestions = await request(app).get('/api/stores/suggestions').query({ ...pk, q });
  const search = await request(app).get('/api/stores/search').query({ ...pk, q });
  expect(suggestions.status).toBe(200);
  expect(slugs(suggestions)).toEqual(['safe-pk']);
  expect(slugs(suggestions)).toEqual(search.body.stores.map(store => store.storeSlug).sort());
  expect(suggestions.body.suggestions[0]).toMatchObject({
    storeName: 'Safepay pk',
    seller: String(fixture.pk.seller._id),
    sellerType: 'store',
    ratingAverage: 0,
    ratingCount: 0,
  });
  expect(suggestions.body.suggestions[0].seller.email).toBeUndefined();
});

test.each([
  [pk, ['safe-pk']],
  [globalPk, ['safe-global', 'safe-pk']],
  [{ buyerMode: 'global' }, ['safe-global']],
  [{ ...pk, buyerRegionCode: 'PB', buyerCity: 'Lahore' }, ['safe-city', 'safe-pk']],
  [{ buyerMode: 'country', buyerCountry: 'United States', buyerCountryCode: 'US' }, ['safe-us']],
])('autocomplete keeps marketplace location scope for %j', async (area, expected) => {
  const result = await request(app).get('/api/stores/suggestions').query({ ...area, q: 'safe' });
  expect(result.status).toBe(200);
  expect(slugs(result)).toEqual(expected);
});

test('inactive, blocked, held, protected and orphaned stores stay excluded', async () => {
  await makeStore('inactive', { isActive: false });
  await makeStore('store-blocked', { blockedAt: new Date() });
  await makeStore('seller-blocked', {}, { status: 'blocked' });
  await makeStore('non-seller', {}, { role: 'user' });
  await makeStore('pending', { moderationStatus: 'pending' });
  await makeStore('moderated', { moderationStatus: 'blocked' });
  const protectedStore = await makeStore('protected');
  // Reproduce a legacy reserved slug; current create validation rejects new ones.
  await Store.collection.updateOne({ _id: protectedStore.store._id }, { $set: { storeSlug: 'rozare-search-fixture' } });
  const orphan = await makeStore('orphan');
  await User.deleteOne({ _id: orphan.seller._id });

  const result = await request(app).get('/api/stores/suggestions').query({ ...globalPk, q: 'safe' });
  expect(result.status).toBe(200);
  expect(slugs(result)).toEqual(['safe-global', 'safe-pk']);
});

test('a buyer-blocked seller is filtered out before the five-result cap', async () => {
  const buyer = await User.create({ username: 'Search buyer', email: 'buyer@example.com', role: 'user' });
  await UserBlock.create({ blocker: buyer._id, blocked: fixture.pk.seller._id });
  for (let i = 0; i < 6; i += 1) await makeStore('extra-' + i);

  const result = await request(app).get('/api/stores/suggestions')
    .set('x-test-buyer', String(buyer._id)).query({ ...pk, q: 'safe' });
  expect(result.status).toBe(200);
  expect(result.body.suggestions).toHaveLength(5);
  expect(slugs(result)).not.toContain('safe-pk');
  expect(result.body.suggestions.every(store => store.storeSlug.startsWith('safe-extra-'))).toBe(true);
});

test('brand profiles are included and special characters are searched literally', async () => {
  await makeStore('brand', { storeName: 'Safe [A+B]', sellerType: 'brand' });
  const literal = await request(app).get('/api/stores/suggestions').query({ ...pk, q: '[A+B]' });
  expect(literal.status).toBe(200);
  expect(slugs(literal)).toEqual(['safe-brand']);
  expect(literal.body.suggestions[0].sellerType).toBe('brand');
  const pattern = await request(app).get('/api/stores/suggestions').query({ ...pk, q: '.*' });
  expect(pattern.status).toBe(200);
  expect(slugs(pattern)).toEqual([]);
});

test.each([undefined, '', '   ', 'no-matching-store-20261016'])('empty or unmatched input %j returns no suggestions', async q => {
  const result = await request(app).get('/api/stores/suggestions').query({ ...pk, ...(q === undefined ? {} : { q }) });
  expect(result.status).toBe(200);
  expect(result.body.suggestions).toEqual([]);
});

test('invalid location does not fall back to unrestricted results', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const result = await request(app).get('/api/stores/suggestions').query({ ...pk, buyerCountryCode: 'US', q: 'safe' });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('BUYER_LOCATION_INVALID');
    expect(result.body.suggestions).toBeUndefined();
  } finally {
    log.mockRestore();
  }
});

test('legacy country-scoped stores remain discoverable without rewriting their records', async () => {
  const legacy = await makeStore('legacy', { address: { country: 'Pakistan', countryCode: 'PK' } });
  await Store.collection.updateOne({ _id: legacy.store._id }, { $unset: { visibility: '' } });
  const before = await Store.collection.findOne({ _id: legacy.store._id });
  const result = await request(app).get('/api/stores/suggestions').query({ ...pk, q: 'safe-legacy' });
  expect(result.status).toBe(200);
  expect(slugs(result)).toEqual(['safe-legacy']);
  expect(await Store.collection.findOne({ _id: legacy.store._id })).toEqual(before);
});
