import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeProfileShippingAddress, profileShippingLocationError, updateProfileShippingLocation } from '../../src/utils/profileShippingAddress';

test('web and mobile use the identical profile location rules', () => {
  const root = resolve(__dirname, '../..');
  const source = path => readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n').trim();
  expect(source('src/utils/profileShippingAddress.js')).toBe(source('../Frontend/src/utils/profileShippingAddress.js'));
});

test('changing country and province clears stale dependent locations, not the phone or street', () => {
  const original = { country: 'Pakistan', countryCode: 'PK', state: 'Punjab', stateCode: 'PB', city: 'Lahore', phone: '+923001234567', address: 'Street' };
  const changed = updateProfileShippingLocation(original, 'country', { name: 'United Kingdom', isoCode: 'GB' });
  expect(changed).toMatchObject({ countryCode: 'GB', state: '', stateCode: '', city: '', phone: original.phone, address: original.address });
  expect(original.city).toBe('Lahore');
  expect(updateProfileShippingLocation(original, 'state', { name: 'Sindh', isoCode: 'SD', countryCode: 'PK' })).toMatchObject({ city: '', stateCode: 'SD' });
});

test('foreign legacy addresses keep their identity and stale cross-country/cross-state options are rejected', () => {
  expect(normalizeProfileShippingAddress({ country: 'United Kingdom', city: 'London' })).toMatchObject({ country: 'United Kingdom', countryCode: '', city: 'London' });
  const current = { country: 'Pakistan', countryCode: 'PK', state: 'Punjab', stateCode: 'PB', city: 'Lahore' };
  expect(updateProfileShippingLocation(current, 'city', { name: 'London', countryCode: 'GB' })).toBe(current);
  expect(updateProfileShippingLocation(current, 'city', { name: 'Karachi', countryCode: 'PK', stateCode: 'SD' })).toBe(current);
  expect(profileShippingLocationError({ country: 'Pakistan', countryCode: 'PK', city: '' })).toBe('Select a city from the list.');
});

test('profile uses checkout location pickers and never silently saves typed search text or a phone country as the shipping location', () => {
  const source = readFileSync(resolve(__dirname, '../../src/screens/ProfileScreen.js'), 'utf8');
  for (const type of ['country', 'state', 'city']) expect(source).toMatch(new RegExp(`type="${type}"`));
  expect(source).toContain('onQueryChange=');
  expect(source).not.toContain("'address', 'city', 'state'");
  expect(source).not.toContain('onCountryChange={(option) => setShippingForm');
  expect(source).toContain('profileShippingLocationError(address)');
  expect(source).toContain('height: Math.min(400, height * 0.45), flex: 0');
});
