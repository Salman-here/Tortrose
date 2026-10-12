import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeProfileShippingAddress, updateProfileShippingLocation, profileShippingLocationError } from '../src/utils/profileShippingAddress.js';

const saved = { fullName: 'Test Buyer', email: 'buyer@example.com', phone: '+923001234567', address: '12 Test Street',
  country: 'Pakistan', countryCode: 'PK', state: 'Punjab', stateCode: 'PB', city: 'Lahore', postalCode: '54000' };
test('saved addresses preserve checkout names, structured codes and other shipping details', () => {
  assert.deepEqual(normalizeProfileShippingAddress(saved), saved);
  assert.equal(normalizeProfileShippingAddress({ ...saved, countryCode: 'pk', stateCode: 'pb' }).stateCode, 'PB');
  const legacy = { ...saved }; delete legacy.countryCode; delete legacy.stateCode;
  assert.deepEqual(normalizeProfileShippingAddress(legacy), { ...saved, stateCode: '' });
  const foreign = normalizeProfileShippingAddress({ country: 'United States', city: 'Austin', state: 'Texas' });
  assert.equal(foreign.countryCode, ''); assert.equal(foreign.city, 'Austin'); assert.equal(foreign.state, 'Texas');
  assert.equal(normalizeProfileShippingAddress({ ...saved, extraPrivateField: 'ignored' }).extraPrivateField, undefined);
});
test('a new form has the same Pakistan default as checkout and Cancel restores saved selections', () => {
  assert.equal(normalizeProfileShippingAddress().countryCode, 'PK');
  const changed = updateProfileShippingLocation(saved, 'country', { name: 'United States', isoCode: 'US' });
  assert.equal(changed.countryCode, 'US');
  assert.deepEqual(normalizeProfileShippingAddress(saved), saved);
});
test('changing or clearing country resets dependent state and city but preserves street/contact details', () => {
  const changed = updateProfileShippingLocation(saved, 'country', { name: 'United States', isoCode: 'US' });
  assert.deepEqual(changed, { ...saved, country: 'United States', countryCode: 'US', state: '', stateCode: '', city: '' });
  const cleared = updateProfileShippingLocation(saved, 'country');
  assert.deepEqual(cleared, { ...saved, country: '', countryCode: '', state: '', stateCode: '', city: '' });
  assert.equal(normalizeProfileShippingAddress(cleared).country, '');
  assert.equal(normalizeProfileShippingAddress(cleared).countryCode, '');
});
test('changing or clearing state resets city and keeps the selected country', () => {
  assert.deepEqual(updateProfileShippingLocation(saved, 'state', { name: 'Sindh', isoCode: 'SD', countryCode: 'PK' }),
    { ...saved, state: 'Sindh', stateCode: 'SD', city: '' });
  assert.deepEqual(updateProfileShippingLocation(saved, 'state'), { ...saved, state: '', stateCode: '', city: '' });
});
test('city selection captures its catalog state for country-wide and legacy-name searches', () => {
  const option = { name: 'Lahore', countryCode: 'PK', stateCode: 'PB', stateName: 'Punjab' };
  const chosen = updateProfileShippingLocation({ ...saved, state: '', stateCode: '', city: '' }, 'city', option);
  assert.deepEqual(chosen, saved);
  assert.deepEqual(updateProfileShippingLocation({ ...saved, countryCode: '', stateCode: '' }, 'city', option), saved);
  assert.deepEqual(updateProfileShippingLocation(saved, 'city'), { ...saved, city: '' });
});
test('stale options from a different country or state cannot alter the shipping address', () => {
  assert.equal(updateProfileShippingLocation(saved, 'state', { name: 'Texas', isoCode: 'TX', countryCode: 'US' }), saved);
  assert.equal(updateProfileShippingLocation(saved, 'city', { name: 'Karachi', countryCode: 'PK', stateCode: 'SD' }), saved);
  assert.equal(updateProfileShippingLocation(saved, 'city', { name: 'Austin', countryCode: 'US', stateCode: 'TX' }), saved);
});
test('country selection is required before dependent selections and city is required before saving', () => {
  const empty = updateProfileShippingLocation(saved, 'country');
  assert.equal(updateProfileShippingLocation(empty, 'state', { name: 'Punjab', isoCode: 'PB', countryCode: 'PK' }), empty);
  assert.match(profileShippingLocationError(empty), /Select a country/);
  assert.match(profileShippingLocationError({ ...saved, city: '' }), /Select a city/);
  assert.equal(profileShippingLocationError(saved), '');
  assert.equal(profileShippingLocationError({ ...saved, state: '', stateCode: '' }), '', 'state remains optional as in checkout');
});
test('profile uses the checkout location picker and persists both country and state codes', () => {
  const profile = readFileSync(new URL('../src/components/layout/Profile.jsx', import.meta.url), 'utf8');
  const checkout = readFileSync(new URL('../src/components/layout/Checkout.jsx', import.meta.url), 'utf8');
  const picker = readFileSync(new URL('../src/components/common/LocationAutocomplete.jsx', import.meta.url), 'utf8');
  assert.match(profile, /import LocationAutocomplete from '\.\.\/common\/LocationAutocomplete'/);
  assert.match(checkout, /import LocationAutocomplete from "\.\.\/common\/LocationAutocomplete"/);
  for (const type of ['country', 'state', 'city']) assert.match(profile, new RegExp(`<LocationAutocomplete type="${type}"`));
  assert.match(profile, /stateCode=\{shippingForm.stateCode\} stateName=\{shippingForm.state\}/);
  assert.match(profile, /countryCode=\{shippingForm.countryCode\} countryName=\{shippingForm.country\}/);
  assert.match(profile, /shippingInfo: saved/);
  assert.match(profile, /await fetchAndUpdateCurrentUser\(\)/);
  assert.match(profile, /setShippingForm\(normalizeProfileShippingAddress\(shippingInfo\)\)/);
  const shippingCardStart = profile.indexOf('{/* Shipping Info Card */}');
  assert.notEqual(shippingCardStart, -1);
  assert.doesNotMatch(profile.slice(0, shippingCardStart), /savingShipping \?/);
  assert.match(profile.slice(shippingCardStart), /type="submit" disabled=\{savingShipping\}[\s\S]*?savingShipping \? 'Saving…'/);
  assert.match(picker, /aria-label=\{label \|\| placeholder\}/);
});
