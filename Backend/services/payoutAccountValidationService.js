'use strict';

const {
  countryNameFromCode,
  resolveCountryCode,
} = require('./locationCatalogService');

const SUPPORTED_PAYOUT_CURRENCIES = new Set(['USD', 'PKR', 'EUR', 'GBP']);
const DISALLOWED_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

// ISO 13616 national IBAN lengths from the SWIFT IBAN Registry (release 102,
// June 2026). A generic ISO country code plus a valid mod-97 checksum is not
// sufficient: countries that have not registered an IBAN format do not issue
// IBANs, and every registered national format has one exact length.
const IBAN_LENGTH_BY_COUNTRY = Object.freeze({
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28,
  BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28,
  CH: 21, CR: 22, CY: 28, CZ: 24,
  DE: 22, DJ: 27, DK: 18, DO: 28,
  EE: 20, EG: 29, ES: 24,
  FI: 18, FK: 18, FO: 18, FR: 27,
  GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28,
  HN: 28, HR: 21, HU: 28,
  IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27,
  JO: 30,
  KW: 30, KZ: 20,
  LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25,
  MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30,
  NI: 28, NL: 18, NO: 15,
  OM: 23,
  PK: 24, PL: 28, PS: 29, PT: 25,
  QA: 29,
  RO: 24, RS: 22, RU: 33,
  SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28,
  TL: 23, TN: 24, TR: 26,
  UA: 29,
  VA: 22, VG: 24,
  XK: 20,
  YE: 30,
});

const payoutAccountInputError = (message, code = 'PAYOUT_ACCOUNT_INPUT_INVALID') => {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
};

const requireTextInput = (value, label, {
  required = false,
  maxLength,
  collapseWhitespace = true,
} = {}) => {
  if (value === null || value === undefined) {
    if (required) {
      throw payoutAccountInputError(
        `${label} is required.`,
        'PAYOUT_ACCOUNT_INPUT_REQUIRED'
      );
    }
    return '';
  }
  if (typeof value !== 'string') {
    throw payoutAccountInputError(`${label} must be text.`);
  }
  if (DISALLOWED_CONTROL_CHARACTERS.test(value)) {
    throw payoutAccountInputError(`${label} contains unsupported control characters.`);
  }
  const text = collapseWhitespace
    ? value.trim().replace(/\s+/gu, ' ')
    : value.trim();
  if (required && !text) {
    throw payoutAccountInputError(
      `${label} is required.`,
      'PAYOUT_ACCOUNT_INPUT_REQUIRED'
    );
  }
  if (maxLength && text.length > maxLength) {
    throw payoutAccountInputError(
      `${label} cannot exceed ${maxLength} characters.`,
      'PAYOUT_ACCOUNT_INPUT_TOO_LONG'
    );
  }
  return text;
};

const normalizeRequiredName = (value, label) => {
  const text = requireTextInput(value, label, { required: true, maxLength: 120 });
  if (text.length < 2) {
    throw payoutAccountInputError(`${label} must contain at least 2 characters.`);
  }
  return text.normalize('NFC');
};

const normalizeAccountNumber = value => {
  const raw = requireTextInput(value, 'Bank account number', { maxLength: 80 });
  if (!raw) return '';
  const normalized = raw.replace(/\s+/gu, '').toUpperCase();
  const alphanumeric = normalized.replace(/[-/]/gu, '');
  if (
    !/^[A-Z0-9]+(?:[-/][A-Z0-9]+)*$/u.test(normalized)
    || alphanumeric.length < 4
    || alphanumeric.length > 34
  ) {
    throw payoutAccountInputError(
      'Bank account number must contain 4 to 34 letters or digits, with only single hyphens or slashes as separators.'
    );
  }
  return normalized;
};

const ibanRemainder = iban => {
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  let remainder = 0;
  for (const character of rearranged) {
    const numeric = character >= 'A' && character <= 'Z'
      ? String(character.charCodeAt(0) - 55)
      : character;
    for (const digit of numeric) {
      remainder = ((remainder * 10) + Number(digit)) % 97;
    }
  }
  return remainder;
};

const normalizeIban = value => {
  const raw = requireTextInput(value, 'IBAN', { maxLength: 80 });
  if (!raw) return '';
  const iban = raw.replace(/\s+/gu, '').toUpperCase();
  const countryCode = iban.slice(0, 2);
  const registeredLength = IBAN_LENGTH_BY_COUNTRY[countryCode];
  if (
    !registeredLength
    || iban.length !== registeredLength
    || !/^[A-Z]{2}\d{2}[A-Z0-9]+$/u.test(iban)
    || !resolveCountryCode({ countryCode })
    || ibanRemainder(iban) !== 1
  ) {
    throw payoutAccountInputError(
      'IBAN is invalid, is not registered for that country, has the wrong national length, or its checksum does not match.'
    );
  }
  return iban;
};

const normalizeSwiftCode = value => {
  const raw = requireTextInput(value, 'SWIFT / BIC code', { maxLength: 20 });
  if (!raw) return '';
  const swiftCode = raw.replace(/\s+/gu, '').toUpperCase();
  if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/u.test(swiftCode)) {
    throw payoutAccountInputError('SWIFT / BIC code must contain exactly 8 or 11 valid characters.');
  }
  return swiftCode;
};

const normalizeCountry = value => {
  const input = requireTextInput(value, 'Payout bank country', {
    required: true,
    maxLength: 80,
  });
  const countryCode = resolveCountryCode({ country: input, countryCode: input });
  if (!countryCode) {
    throw payoutAccountInputError('Choose a recognized payout bank country.');
  }
  return {
    country: countryNameFromCode(countryCode),
    countryCode,
  };
};

const normalizeCurrency = value => {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw payoutAccountInputError('Payout currency must be USD, PKR, EUR, or GBP.');
  }
  const currency = value.toUpperCase();
  if (!SUPPORTED_PAYOUT_CURRENCIES.has(currency)) {
    throw payoutAccountInputError('Payout currency must be USD, PKR, EUR, or GBP.');
  }
  return currency;
};

const lastFourDestinationCharacters = value => String(value || '')
  .replace(/[^A-Za-z0-9]/gu, '')
  .slice(-4)
  .toUpperCase();

const validatePayoutAccountDestination = (value, {
  defaultCurrency = 'USD',
} = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw payoutAccountInputError('Payout account details are required.');
  }
  const accountHolderName = normalizeRequiredName(value.accountHolderName, 'Account holder name');
  const bankName = normalizeRequiredName(value.bankName, 'Bank name');
  const accountNumber = normalizeAccountNumber(value.accountNumber);
  const iban = normalizeIban(value.iban);
  if (!accountNumber && !iban) {
    throw payoutAccountInputError(
      'Please enter a bank account number or IBAN.',
      'PAYOUT_DESTINATION_REQUIRED'
    );
  }
  const swiftCode = normalizeSwiftCode(value.swiftCode);
  const { country, countryCode } = normalizeCountry(value.countryCode || value.country);
  if (iban && iban.slice(0, 2) !== countryCode) {
    throw payoutAccountInputError('IBAN country does not match the selected payout bank country.');
  }
  if (swiftCode && swiftCode.slice(4, 6) !== countryCode) {
    throw payoutAccountInputError('SWIFT / BIC country does not match the selected payout bank country.');
  }
  const currency = normalizeCurrency(
    value.currency === undefined ? defaultCurrency : value.currency
  );
  const payoutInstructions = requireTextInput(value.payoutInstructions, 'Payout instructions', {
    maxLength: 500,
  });

  return {
    accountHolderName,
    bankName,
    accountNumber,
    accountNumberLast4: lastFourDestinationCharacters(accountNumber),
    iban,
    ibanLast4: lastFourDestinationCharacters(iban),
    swiftCode,
    country,
    countryCode,
    currency,
    payoutInstructions,
  };
};

const mergeAndValidatePayoutAccountUpdate = ({ input, existing, defaultCurrency = 'USD' }) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw payoutAccountInputError('Payout account details are required.');
  }
  const previous = existing || {};
  const preserveSecretWhenBlank = field => {
    if (input[field] === undefined || input[field] === null) return previous[field] || '';
    if (typeof input[field] !== 'string') {
      throw payoutAccountInputError(`${field === 'iban' ? 'IBAN' : 'Bank account number'} must be text.`);
    }
    return input[field].trim() ? input[field] : previous[field] || '';
  };
  return validatePayoutAccountDestination({
    accountHolderName: input.accountHolderName,
    bankName: input.bankName,
    accountNumber: preserveSecretWhenBlank('accountNumber'),
    iban: preserveSecretWhenBlank('iban'),
    swiftCode: input.swiftCode === undefined ? previous.swiftCode : input.swiftCode,
    country: input.country === undefined && input.countryCode === undefined
      ? (previous.countryCode || previous.country)
      : (input.countryCode || input.country),
    currency: input.currency === undefined
      ? (previous.currency || defaultCurrency)
      : input.currency,
    payoutInstructions: input.payoutInstructions === undefined
      ? previous.payoutInstructions
      : input.payoutInstructions,
  }, { defaultCurrency });
};

module.exports = {
  IBAN_LENGTH_BY_COUNTRY,
  SUPPORTED_PAYOUT_CURRENCIES,
  ibanRemainder,
  lastFourDestinationCharacters,
  mergeAndValidatePayoutAccountUpdate,
  normalizeAccountNumber,
  normalizeIban,
  normalizeSwiftCode,
  payoutAccountInputError,
  validatePayoutAccountDestination,
};
