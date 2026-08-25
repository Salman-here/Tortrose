'use strict';

const { parsePhoneNumberFromString } = require('libphonenumber-js/max');
const { resolveCountryCode } = require('./locationCatalogService');

const E164_PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;
const PHONE_INPUT_PATTERN = /^[+0-9().\-\s]+$/;

const invalidShippingPhoneError = (message = (
  'Enter a valid international phone number, or choose a valid shipping country for a local number.'
)) => {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'SHIPPING_PHONE_INVALID';
  return error;
};

const cleanPhoneInput = value => {
  if (typeof value !== 'string') {
    throw invalidShippingPhoneError();
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || !PHONE_INPUT_PATTERN.test(trimmed)) {
    throw invalidShippingPhoneError();
  }

  const compact = trimmed.replace(/[().\-\s]/g, '');
  if (!compact || (compact.includes('+') && !compact.startsWith('+'))) {
    throw invalidShippingPhoneError();
  }
  if ((compact.match(/\+/g) || []).length > 1) throw invalidShippingPhoneError();
  return compact;
};

const requireParsedE164 = (candidate, defaultCountry) => {
  let parsed;
  try {
    parsed = parsePhoneNumberFromString(candidate, defaultCountry || undefined);
  } catch (_error) {
    throw invalidShippingPhoneError();
  }
  if (!parsed || !parsed.isValid() || !E164_PHONE_PATTERN.test(parsed.number)) {
    throw invalidShippingPhoneError();
  }
  return parsed.number;
};

const normalizeExplicitE164 = value => {
  const compact = cleanPhoneInput(value);
  if (!compact.startsWith('+') && !compact.startsWith('00')) {
    throw invalidShippingPhoneError('The stored international phone number is invalid.');
  }
  const candidate = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  return requireParsedE164(candidate);
};

/**
 * Canonicalize checkout phone input without ever guessing a default country.
 * Explicit +/00 numbers are authoritative. A domestic number is accepted only
 * when the order carries a country that resolves to an ISO-3166 alpha-2 code.
 */
const canonicalizeShippingPhone = shippingInfo => {
  const shipping = shippingInfo && typeof shippingInfo === 'object' ? shippingInfo : {};
  const compact = cleanPhoneInput(shipping.phone);
  const resolvedCountryCode = resolveCountryCode({
    countryCode: shipping.countryCode,
    country: shipping.country,
  });

  let e164;
  if (compact.startsWith('+') || compact.startsWith('00')) {
    e164 = normalizeExplicitE164(compact);
  } else {
    if (!resolvedCountryCode) {
      throw invalidShippingPhoneError(
        'Choose a valid shipping country before using a local phone number, or enter the number with its + country code.'
      );
    }
    e164 = requireParsedE164(compact, resolvedCountryCode);
  }

  return {
    e164,
    digits: e164.slice(1),
    countryCode: resolvedCountryCode,
  };
};

/**
 * Read an order's immutable destination. New rows must use phoneE164. Legacy
 * rows are derived from their frozen phone + country metadata. If phoneE164 is
 * present but corrupt, never fall back to a different raw destination.
 */
const orderBuyerPhoneE164 = order => {
  const shipping = order?.shippingInfo;
  if (!shipping) throw invalidShippingPhoneError('The order has no shipping phone destination.');
  if (shipping.phoneE164 !== undefined && shipping.phoneE164 !== null) {
    if (typeof shipping.phoneE164 !== 'string' || !E164_PHONE_PATTERN.test(shipping.phoneE164)) {
      throw invalidShippingPhoneError('The stored international phone number is invalid.');
    }
    return normalizeExplicitE164(shipping.phoneE164);
  }
  return canonicalizeShippingPhone(shipping).e164;
};

const orderBuyerPhoneDigits = order => orderBuyerPhoneE164(order).slice(1);

const tryOrderBuyerPhoneE164 = order => {
  try {
    return orderBuyerPhoneE164(order);
  } catch (error) {
    if (error?.code === 'SHIPPING_PHONE_INVALID') return '';
    throw error;
  }
};

module.exports = {
  E164_PHONE_PATTERN,
  canonicalizeShippingPhone,
  invalidShippingPhoneError,
  normalizeExplicitE164,
  orderBuyerPhoneDigits,
  orderBuyerPhoneE164,
  tryOrderBuyerPhoneE164,
};
