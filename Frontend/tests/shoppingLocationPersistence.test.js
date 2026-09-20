import test from 'node:test';
import assert from 'node:assert/strict';
import { readShoppingPreference, writeShoppingPreference } from '../src/utils/shoppingLocationPersistence.js';

const environment = (hostname = 'rozare.com', jar = { value: '' }) => {
  const values = new Map();
  const document = { get cookie() { return jar.value; }, set cookie(value) { jar.value = value.split(';')[0]; jar.attributes = value; } };
  return { location: { hostname, protocol: 'https:' }, document, localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } };
};
const choice = (mode, updatedAt = Date.now()) => ({ version: 2, confirmed: true, updatedAt, mode, country: 'Pakistan', countryCode: 'PK' });
test('an explicit choice survives navigation from the marketplace to a store subdomain', () => {
  const jar = { value: '' }, main = environment('rozare.com', jar), store = environment('seller.rozare.com', jar);
  assert.equal(writeShoppingPreference(choice('global'), main), '');
  assert.equal(readShoppingPreference(store).mode, 'global');
  assert.match(jar.attributes, /Domain=\.rozare\.com; Path=\/;.*SameSite=Lax; Secure/);
  assert.equal(readShoppingPreference(store).country, '');
});
test('the newer explicit choice wins over an old local cache on another origin', () => {
  const jar = { value: '' }, main = environment('rozare.com', jar), store = environment('seller.rozare.com', jar);
  writeShoppingPreference(choice('country', 100), main);
  writeShoppingPreference(choice('global', 200), store);
  assert.equal(readShoppingPreference(main).mode, 'global');
});
test('lookalike hosts and localhost do not receive a Rozare parent-domain cookie', () => {
  for (const host of ['notrozare.com', 'rozare.com.example.org', 'localhost']) {
    const env = environment(host);
    assert.equal(writeShoppingPreference(choice('country'), env), '');
    assert.equal(env.document.cookie, '');
    assert.equal(readShoppingPreference(env).countryCode, 'PK');
  }
});
test('invalid cached values are ignored and storage failure is reported', () => {
  const env = environment('localhost');
  env.localStorage.getItem = () => '{invalid';
  assert.equal(readShoppingPreference(env), null);
  env.localStorage.setItem = () => { throw new Error('storage blocked'); };
  assert.match(writeShoppingPreference(choice('global'), env), /could not be saved/);
});
