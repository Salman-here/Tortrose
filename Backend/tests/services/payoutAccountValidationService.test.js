'use strict';

const {
  ibanRemainder,
  lastFourDestinationCharacters,
  mergeAndValidatePayoutAccountUpdate,
  validatePayoutAccountDestination,
} = require('../../services/payoutAccountValidationService');

const ibanWithValidChecksum = (countryCode, bban) => {
  const rearranged = `${bban}${countryCode}00`;
  let remainder = 0;
  for (const character of rearranged) {
    const numeric = character >= 'A' && character <= 'Z'
      ? String(character.charCodeAt(0) - 55)
      : character;
    for (const digit of numeric) {
      remainder = ((remainder * 10) + Number(digit)) % 97;
    }
  }
  return `${countryCode}${String(98 - remainder).padStart(2, '0')}${bban}`;
};

describe('payout account destination validation', () => {
  const validAccount = Object.freeze({
    accountHolderName: 'Durable Seller',
    bankName: 'Production Bank',
    accountNumber: '0011-223344556677',
    iban: 'PK36 SCBL 0000 0011 2345 6702',
    swiftCode: 'SCBLPKKX',
    country: 'Pakistan',
    currency: 'PKR',
    payoutInstructions: 'Primary payout destination',
  });

  test('normalizes a valid global destination and preserves leading zeroes', () => {
    const normalized = validatePayoutAccountDestination(validAccount);
    expect(normalized).toEqual({
      accountHolderName: 'Durable Seller',
      bankName: 'Production Bank',
      accountNumber: '0011-223344556677',
      accountNumberLast4: '6677',
      iban: 'PK36SCBL0000001123456702',
      ibanLast4: '6702',
      swiftCode: 'SCBLPKKX',
      country: 'Pakistan',
      countryCode: 'PK',
      currency: 'PKR',
      payoutInstructions: 'Primary payout destination',
    });
    expect(ibanRemainder(normalized.iban)).toBe(1);
  });

  test.each([
    [{ ...validAccount, accountNumber: true }, /must be text/i],
    [{ ...validAccount, accountNumber: '-' }, /4 to 34/i],
    [{ ...validAccount, iban: 'PK00SCBL0000001123456702' }, /checksum/i],
    [{ ...validAccount, swiftCode: 'SCBLUS33' }, /country does not match/i],
    [{ ...validAccount, country: 'Not a real country' }, /recognized/i],
    [{ ...validAccount, currency: 'JPY' }, /USD, PKR, EUR, or GBP/i],
    [{ ...validAccount, currency: '' }, /USD, PKR, EUR, or GBP/i],
    [{ ...validAccount, bankName: 'Bank\u0000Name' }, /control characters/i],
  ])('rejects an unsafe or contradictory payout destination', (account, message) => {
    expect(() => validatePayoutAccountDestination(account)).toThrow(message);
  });

  test('rejects checksum-valid identifiers for countries that do not issue IBANs', () => {
    const checksumValidUsLookalike = ibanWithValidChecksum('US', 'BANK123456789');
    expect(ibanRemainder(checksumValidUsLookalike)).toBe(1);
    expect(() => validatePayoutAccountDestination({
      ...validAccount,
      accountNumber: '',
      iban: checksumValidUsLookalike,
      swiftCode: 'BOFAUS3N',
      country: 'United States',
      currency: 'USD',
    })).toThrow(/not registered/i);
  });

  test('rejects a checksum-valid IBAN with the wrong national length', () => {
    const checksumValidShortPakistanIban = ibanWithValidChecksum('PK', 'SCBL000000112345');
    expect(ibanRemainder(checksumValidShortPakistanIban)).toBe(1);
    expect(() => validatePayoutAccountDestination({
      ...validAccount,
      accountNumber: '',
      iban: checksumValidShortPakistanIban,
    })).toThrow(/wrong national length/i);
  });

  test('requires at least one destination and does not coerce non-text secrets', () => {
    expect(() => validatePayoutAccountDestination({
      ...validAccount,
      accountNumber: '',
      iban: '',
    })).toThrow(/account number or IBAN/i);
    expect(() => validatePayoutAccountDestination({
      ...validAccount,
      accountNumber: 11223344,
      iban: '',
    })).toThrow(/must be text/i);
  });

  test('partial updates retain encrypted fields while validating the complete final destination', () => {
    const existing = validatePayoutAccountDestination(validAccount);
    const updated = mergeAndValidatePayoutAccountUpdate({
      input: {
        accountHolderName: 'Durable Seller',
        bankName: 'Renamed Production Bank',
        accountNumber: '',
        iban: '',
      },
      existing,
      defaultCurrency: 'USD',
    });
    expect(updated).toMatchObject({
      bankName: 'Renamed Production Bank',
      accountNumber: existing.accountNumber,
      iban: existing.iban,
      country: 'Pakistan',
      countryCode: 'PK',
      currency: 'PKR',
    });
  });

  test('last-four masking ignores separators and never exposes more than four characters', () => {
    expect(lastFourDestinationCharacters('12-34/56')).toBe('3456');
    expect(lastFourDestinationCharacters('')).toBe('');
  });
});
