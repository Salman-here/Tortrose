import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeShoppingLocation, shoppingLocationIsValid, shoppingLocationFromDetection,
  shoppingLocationFromProfile, shoppingLocationParams, shoppingCountryPatch, withGlobalShoppingCountry, shoppingLocationLabel } from '../src/utils/shoppingLocation.js';
import { defaultStoreVisibility, storeVisibilityError, storeVisibilityPayload } from '../src/utils/storeVisibilityForm.js';

test('Global retains its detected country and clears local-area filters', () => {
  const value = normalizeShoppingLocation({ version: 2, confirmed: true, mode: 'global', country: 'Pakistan', countryCode: 'PK', city: 'Lahore', lat: '31' });
  assert.equal(value.confirmed, true);
  assert.equal(value.country, 'Pakistan');
  assert.equal(value.city, '');
  assert.deepEqual(shoppingLocationParams(value), { buyerMode: 'global', buyerCountry: 'Pakistan', buyerCountryCode: 'PK' });
  assert.equal(shoppingLocationLabel(value), 'Global + Pakistan');
});

test('Global uses actual-country suggestion instead of a previously browsed country', () => {
  for (const [code, country] of [['PK', 'Pakistan'], ['US', 'United States'], ['JP', 'Japan'], ['CA', 'Canada']]) {
    const choice = withGlobalShoppingCountry({ mode: 'country', country: 'Germany', countryCode: 'DE', city: 'Berlin' }, { country, countryCode: code });
    assert.deepEqual(shoppingLocationParams(choice), { buyerMode: 'global', buyerCountry: country, buyerCountryCode: code });
  }
  assert.deepEqual(shoppingLocationParams(withGlobalShoppingCountry({ country: 'Germany', countryCode: 'DE' }, null)), { buyerMode: 'global' });
});

test('country selection and local areas are canonical, separate from currency/delivery', () => {
  const value = normalizeShoppingLocation({ version: 2, confirmed: true, mode: 'country', country: ' Pakistan ', countryCode: 'pk', region: 'Punjab', city: 'Lahore', currency: 'USD' });
  assert.equal(value.confirmed, true);
  assert.equal(value.currency, undefined);
  assert.deepEqual(shoppingLocationParams(value), { buyerMode: 'country', buyerCountry: 'Pakistan', buyerCountryCode: 'PK', buyerRegion: 'Punjab', buyerCity: 'Lahore' });
  const switched = { ...value, ...shoppingCountryPatch({ name: 'Japan', isoCode: 'JP' }) };
  assert.equal(switched.region, '');
  assert.equal(switched.city, '');
  assert.equal(switched.countryCode, 'JP');
});

test('old implicit caches and corrupt preferences are never a confirmed first-visit choice', () => {
  for (const value of [null, [], 'global', { country: 'United States', countryCode: 'US' }, { version: 2, confirmed: true, mode: 'everything', country: 'Pakistan', countryCode: 'PK' }, { version: 2, confirmed: true, mode: 'country', country: '' }]) {
    assert.equal(normalizeShoppingLocation(value).confirmed, false);
  }
  assert.equal(shoppingLocationIsValid({ mode: 'country', country: 'Pakistan' }), false);
  assert.equal(shoppingLocationIsValid({ mode: 'global' }), true);
});

test('failed US geolocation is not a real country; real countries are not limited to money currencies', () => {
  assert.equal(shoppingLocationFromDetection({ country: 'US', detected: false }), null);
  assert.equal(shoppingLocationFromDetection({ country: 'US' }), null);
  for (const [code, name] of [['PK', 'Pakistan'], ['CA', 'Canada'], ['JP', 'Japan']]) {
    assert.equal(shoppingLocationFromDetection({ country: code, countryName: name, detected: true }).countryCode, code);
  }
  assert.equal(shoppingLocationFromProfile({ savedShippingInfo: { country: 'Pakistan', countryCode: 'PK' } }), null);
  assert.equal(shoppingLocationFromProfile({ savedShippingInfo: { country: 'Pakistan', countryCode: 'PK', city: 'Lahore' } }).country, 'Pakistan');
});

test('onboarding defaults to seller country, sends only relevant visibility fields and validates each scope', () => {
  const value = defaultStoreVisibility({ country: 'Pakistan', countryCode: 'PK', state: 'Punjab', stateCode: 'PB', city: 'Lahore' });
  assert.equal(storeVisibilityError(value), '');
  assert.deepEqual(storeVisibilityPayload(value), { mode: 'country', country: 'Pakistan', countryCode: 'PK' });
  assert.deepEqual(storeVisibilityPayload({ ...value, mode: 'global' }), { mode: 'global' });
  assert.equal(storeVisibilityError({ ...value, mode: 'region' }), '');
  assert.equal(storeVisibilityError({ ...value, mode: 'city' }), '');
  assert.match(storeVisibilityError({ ...value, mode: 'town' }), /town/);
  assert.equal(storeVisibilityPayload({ ...value, mode: 'town', town: 'Johar Town' }).town, 'Johar Town');
  assert.throws(() => storeVisibilityPayload({ mode: 'anything' }));
});

test('web and mobile share the same location and seller visibility contracts', () => {
  for (const name of ['shoppingLocation', 'storeVisibilityForm']) {
    const read = url => readFileSync(url, 'utf8').replace(/\r\n/g, '\n');
    assert.equal(read(new URL('../src/utils/' + name + '.js', import.meta.url)), read(new URL('../../MobileApp/src/utils/' + name + '.js', import.meta.url)));
  }
});

test('both onboarding forms submit visibility and include a distinct review step', () => {
  for (const path of ['../src/pages/BecomeSeller.jsx', '../../MobileApp/src/screens/BecomeSellerScreen.js']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /visibility: storeVisibilityPayload\(storeVisibility\)/);
    assert.match(source, /<StoreVisibilityPicker/);
    assert.match(source, /handleVisibilityNext/);
  }
});

test('first-visit prompt is limited to shopping routes and explains persistent filter controls', () => {
  const source = readFileSync(new URL('../src/components/common/ShoppingLocationPrompt.jsx', import.meta.url), 'utf8');
  assert.match(source, /selectionRequired && catalogRoute/);
  assert.match(source, /change your selection any time in Filters/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /touched\.current/);
  assert.doesNotMatch(source, /orders\/confirm|payment-success|reset-password/);
});

test('offline product fallback is bound to the exact location, currency and filter request', () => {
  const source = readFileSync(new URL('../src/components/Products.jsx', import.meta.url), 'utf8');
  assert.match(source, /writeProductsCache\(\{ \.\.\.res\.data, queryKey: query \}\)/);
  assert.match(source, /cached\?\.queryKey === query && cached\?\.products\?\.length/);
  assert.match(source, /appendLocationParams\(params\)/);
});
