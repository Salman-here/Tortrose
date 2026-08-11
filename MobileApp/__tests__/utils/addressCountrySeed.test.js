import fs from 'fs';
import path from 'path';
import { addressCountrySeed } from '../../src/utils/addressCountrySeed';

describe('addressCountrySeed', () => {
  it('prefers a saved address over detected location', () => {
    expect(addressCountrySeed(
      { country: 'United Arab Emirates', countryCode: 'AE' },
      { country: 'Pakistan', countryCode: 'PK' },
    )).toEqual({ country: 'United Arab Emirates', countryCode: 'AE' });
  });

  it('uses detected country for a new address without saved country data', () => {
    expect(addressCountrySeed(null, { country: 'Canada', countryCode: 'CA' }))
      .toEqual({ country: 'Canada', countryCode: 'CA' });
  });

  it('uses Pakistan only as the final offline fallback', () => {
    expect(addressCountrySeed(null, null, false)).toEqual({ country: '', countryCode: '' });
    expect(addressCountrySeed(null, null, true)).toEqual({ country: 'Pakistan', countryCode: 'PK' });
  });

  it('keeps the profile shipping phone country aligned with detection and selection', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/screens/ProfileScreen.js'),
      'utf8',
    );
    expect(source).toContain('resolveBuyerLocation()');
    expect(source).toContain('addressCountrySeed(null, detectedLocation)');
    expect(source).toContain('onCountryChange={(option) => setShippingForm');
    expect(source).not.toMatch(/country:\s*['"]Pakistan['"],\s*countryCode:\s*['"]PK/);
  });
});
