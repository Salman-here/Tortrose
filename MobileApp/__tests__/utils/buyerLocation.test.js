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
test('restores confirmed Global without requiring a country or calling detection', async () => {
  mockStored.set(key, JSON.stringify({ version: 2, confirmed: true, mode: 'global', country: 'Pakistan', countryCode: 'PK' }));
  expect(await location.getBuyerLocationParams()).toEqual({ buyerMode: 'global' });
  expect(axios.get).not.toHaveBeenCalled();
});
test('an explicit Global choice wins a late successful country lookup', async () => {
  let finish;
  axios.get.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = location.resolveBuyerLocation(); await flush();
  expect(finish).toEqual(expect.any(Function));
  await location.setBuyerLocation({ mode: 'global' });
  finish({ data: { country: 'US', countryName: 'United States', detected: true } });
  expect(await pending).toMatchObject({ mode: 'global', confirmed: true, country: '' });
  expect(JSON.parse(mockStored.get(key)).mode).toBe('global');
});
test('login suggestions do not replace an explicit choice', async () => {
  await location.setBuyerLocation({ mode: 'global' });
  await location.suggestBuyerLocation(pakistan);
  expect(await location.getBuyerLocationParams()).toEqual({ buyerMode: 'global' });
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
  storage.setItem.mockRejectedValueOnce(new Error('storage denied'));
  expect(await location.setBuyerLocation({ mode: 'global' })).toMatchObject({ mode: 'global', persistenceWarning: expect.any(String) });
  expect(await location.getBuyerLocationParams()).toEqual({ buyerMode: 'global' });
});
test('invalid country choice is not saved and subscribers are removable', async () => {
  const listener = jest.fn(), unsubscribe = location.subscribeBuyerLocation(listener);
  await expect(location.setBuyerLocation({ mode: 'country' })).rejects.toThrow(/country/);
  expect(storage.setItem).not.toHaveBeenCalled();
  await location.setBuyerLocation(pakistan); expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe(); await location.setBuyerLocation({ mode: 'global' }); expect(listener).toHaveBeenCalledTimes(1);
});
