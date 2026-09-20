const mockStored = new Map();
jest.mock('axios', () => ({ get: jest.fn() }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async key => mockStored.get(key) ?? null),
  setItem: jest.fn(async (key, value) => { mockStored.set(key, value); }),
  removeItem: jest.fn(async key => { mockStored.delete(key); }),
}));
let location, axios, storage;
const key = 'rozare:shopping-location:v2';
const pakistan = { mode: 'country', country: 'Pakistan', countryCode: 'PK' };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
beforeEach(() => {
  jest.resetModules(); mockStored.clear();
  axios = require('axios'); storage = require('@react-native-async-storage/async-storage');
  axios.get.mockResolvedValue({ data: { country: 'PK', countryName: 'Pakistan', detected: true } });
  location = require('../../src/utils/buyerLocation');
});

test('detects a suggested country without silently confirming or saving it', async () => {
  expect(await location.resolveBuyerLocation()).toMatchObject({ ...pakistan, confirmed: false });
  expect(storage.setItem).not.toHaveBeenCalled();
});
test('rejects fallback US and ignores the old unconfirmed cached US location', async () => {
  mockStored.set('rozare:buyer-location', JSON.stringify({ country: 'United States', countryCode: 'US' }));
  axios.get.mockResolvedValue({ data: { country: 'US', detected: false } });
  expect(await location.resolveBuyerLocation()).toMatchObject({ mode: 'country', country: '', confirmed: false });
});
test('restores an old Global preference and adds the newly detected country', async () => {
  mockStored.set(key, JSON.stringify({ version: 2, confirmed: true, mode: 'global' }));
  expect(await location.getBuyerLocationParams()).toEqual({ buyerMode: 'global', buyerCountry: 'Pakistan', buyerCountryCode: 'PK' });
  expect(axios.get).toHaveBeenCalledTimes(1);
});
test('an explicit Global choice wins a late successful country lookup', async () => {
  let finish;
  axios.get.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = location.resolveBuyerLocation(); await flush();
  expect(finish).toEqual(expect.any(Function));
  await location.setBuyerLocation({ mode: 'global' });
  finish({ data: { country: 'US', countryName: 'United States', detected: true } });
  await pending; await flush();
  expect(location.getCachedBuyerLocation()).toMatchObject({ mode: 'global', confirmed: true, country: 'United States' });
  expect(JSON.parse(mockStored.get(key)).mode).toBe('global');
});
test('login suggestions do not replace an explicit choice', async () => {
  await location.setBuyerLocation({ mode: 'global' });
  await location.suggestBuyerLocation(pakistan);
  expect(await location.getBuyerLocationParams()).toEqual({ buyerMode: 'global', buyerCountry: 'Pakistan', buyerCountryCode: 'PK' });
});
test('rapid choices are persisted in order and cannot restore an older country', async () => {
  let release;
  storage.setItem.mockImplementationOnce((k, value) => new Promise(resolve => { release = () => { mockStored.set(k, value); resolve(); }; }));
  const first = location.setBuyerLocation(pakistan);
  const last = location.setBuyerLocation({ mode: 'global' });
  await flush();
  expect(storage.setItem).toHaveBeenCalledTimes(1);
  expect(location.getCachedBuyerLocation().mode).toBe('global');
  release(); await Promise.all([first, last]);
  expect(JSON.parse(mockStored.get(key)).mode).toBe('global');
});
test('storage failure keeps the in-session choice and reports the save limitation', async () => {
  axios.get.mockResolvedValue({ data: { country: 'US', detected: false } });
  storage.setItem.mockRejectedValueOnce(new Error('storage denied'));
  expect(await location.setBuyerLocation({ mode: 'global' })).toMatchObject({ mode: 'global', persistenceWarning: expect.any(String) });
  expect(await location.getBuyerLocationParams()).toEqual({ buyerMode: 'global' });
});

test('Global uses detected Pakistan after manually browsing another country', async () => {
  await location.resolveBuyerLocation();
  await location.setBuyerLocation({ mode: 'country', country: 'United States', countryCode: 'US' });
  await location.setBuyerLocation({ mode: 'global', country: 'United States', countryCode: 'US' });
  expect(await location.getBuyerLocationParams()).toEqual({ buyerMode: 'global', buyerCountry: 'Pakistan', buyerCountryCode: 'PK' });
});

test('late Global enrichment cannot replace a newer manual Country selection', async () => {
  let finish;
  axios.get.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await location.setBuyerLocation({ mode: 'global' });
  await location.setBuyerLocation({ mode: 'country', country: 'Japan', countryCode: 'JP' });
  finish({ data: { detected: true, country: 'PK', countryName: 'Pakistan' } });
  await flush();
  expect(await location.getBuyerLocationParams()).toEqual({ buyerMode: 'country', buyerCountry: 'Japan', buyerCountryCode: 'JP' });
});

test('a returning Global shopper gets their current country, not a stale saved one', async () => {
  mockStored.set(key, JSON.stringify({ version: 2, confirmed: true, mode: 'global', country: 'United States', countryCode: 'US' }));
  expect(await location.getBuyerLocationParams()).toEqual({ buyerMode: 'global', buyerCountry: 'Pakistan', buyerCountryCode: 'PK' });
});

test.each(['network', 'provider'])('an old Global choice recovers automatically from a transient %s lookup failure', async reason => {
  mockStored.set(key, JSON.stringify({ version: 2, confirmed: true, mode: 'global' }));
  if (reason === 'network') axios.get.mockRejectedValueOnce(new Error('temporary timeout'));
  else axios.get.mockResolvedValueOnce({ data: { detected: false, country: 'US' } });
  expect(await location.getBuyerLocationParams()).toEqual({ buyerMode: 'global', buyerCountry: 'Pakistan', buyerCountryCode: 'PK' });
  expect(axios.get).toHaveBeenCalledTimes(2);
});

test('persistent detection failure stops after two attempts without guessing the fallback US country', async () => {
  mockStored.set(key, JSON.stringify({ version: 2, confirmed: true, mode: 'global' }));
  axios.get.mockResolvedValue({ data: { detected: false, country: 'US' } });
  expect(await location.getBuyerLocationParams()).toEqual({ buyerMode: 'global' });
  expect(axios.get).toHaveBeenCalledTimes(2);
});
test('invalid country choice is not saved and subscribers are removable', async () => {
  const listener = jest.fn(), unsubscribe = location.subscribeBuyerLocation(listener);
  await expect(location.setBuyerLocation({ mode: 'country' })).rejects.toThrow(/country/);
  expect(storage.setItem).not.toHaveBeenCalled();
  await location.setBuyerLocation(pakistan); expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe(); await location.setBuyerLocation({ mode: 'global' }); expect(listener).toHaveBeenCalledTimes(1);
});
