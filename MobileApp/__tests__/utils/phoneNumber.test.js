import {
  allFallbackCountryOptions,
  countryCodeFromLocale,
  countryFromPhoneNumber,
  isValidPhoneNumber,
  nationalDigitsFromPhone,
  normalizeCountryCode,
  toE164PhoneNumber,
} from '../../src/utils/phoneNumber';

describe('mobile phone-number contract', () => {
  it('normalizes supported country codes and extracts device regions', () => {
    expect(normalizeCountryCode(' pk ')).toBe('PK');
    expect(normalizeCountryCode('ZZ')).toBe('');
    expect(countryCodeFromLocale('en-PK')).toBe('PK');
    expect(countryCodeFromLocale('en_US')).toBe('US');
  });

  it('turns local numbers into canonical E.164 values for the selected country', () => {
    expect(toE164PhoneNumber('0302 858 8506', 'PK')).toBe('+923028588506');
    expect(toE164PhoneNumber('(415) 555-2671', 'US')).toBe('+14155552671');
    expect(toE164PhoneNumber('+44 20 7946 0958', 'PK')).toBe('+442079460958');
  });

  it('parses existing international values without leaking the calling code into the local field', () => {
    expect(countryFromPhoneNumber('+923028588506')).toBe('PK');
    expect(nationalDigitsFromPhone('+923028588506', 'PK')).toBe('3028588506');
  });

  it('uses libphonenumber validity instead of digit-length guesses', () => {
    expect(isValidPhoneNumber('+923028588506')).toBe(true);
    expect(isValidPhoneNumber('+14155552671')).toBe(true);
    expect(isValidPhoneNumber('+923')).toBe(false);
    expect(isValidPhoneNumber('03028588506')).toBe(false);
  });

  it('provides an offline fallback for the complete supported country catalog', () => {
    const countries = allFallbackCountryOptions();
    expect(countries.length).toBeGreaterThan(200);
    expect(countries).toEqual(expect.arrayContaining([
      expect.objectContaining({ isoCode: 'PK', phonecode: '92' }),
      expect.objectContaining({ isoCode: 'US', phonecode: '1' }),
    ]));
  });
});
