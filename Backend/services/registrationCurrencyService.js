'use strict';

const { isSupportedCurrency, normalizeCurrency } = require('./currencyService');

// Initial browsing preference only. This must never change an existing user
// or a store's separately selected native product currency.
const registrationCurrency = value => typeof value === 'string' && isSupportedCurrency(value)
  ? normalizeCurrency(value) : undefined;

const mobileGoogleRegistration = state => {
  const match = typeof state === 'string' && /^mobile(?::(USD|PKR|EUR|GBP))?$/.exec(state);
  return { isMobile: Boolean(match), currency: match?.[1] };
};

module.exports = { registrationCurrency, mobileGoogleRegistration };
