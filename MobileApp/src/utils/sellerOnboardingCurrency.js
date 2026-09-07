export const SELLER_PRODUCT_CURRENCY_CODES = ['USD', 'PKR', 'EUR', 'GBP'];

// Supported local currencies, including Croatia (2023) and Bulgaria (2026).
// Bulgaria: https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.pr260101~c830245e42.en.html
const CURRENCY_COUNTRIES = {
  PKR: ['PK'],
  USD: ['US', 'AS', 'BQ', 'EC', 'FM', 'GU', 'IO', 'MH', 'MP', 'PA', 'PR', 'PW', 'SV', 'TC', 'TL', 'UM', 'VG', 'VI'],
  GBP: ['GB', 'GG', 'IM', 'JE', 'GS'],
  EUR: ['AD', 'AT', 'AX', 'BE', 'BG', 'BL', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GF', 'GP', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MC', 'ME', 'MF', 'MQ', 'MT', 'NL', 'PM', 'PT', 'RE', 'SI', 'SK', 'SM', 'TF', 'VA', 'XK', 'YT'],
};
const COUNTRY_CURRENCY = Object.fromEntries(
  Object.entries(CURRENCY_COUNTRIES).flatMap(([currency, countries]) => countries.map(code => [code, currency])),
);
const COUNTRY_ALIASES = {
  pakistan: 'PK', uk: 'GB', 'united kingdom': 'GB', britain: 'GB', england: 'GB',
  usa: 'US', 'united states': 'US', 'united states of america': 'US',
};
const clean = value => typeof value === 'string' ? value.trim() : '';
const regionNames = typeof Intl.DisplayNames === 'function'
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null;

export const normalizeSellerProductCurrency = value => {
  const code = clean(value).toUpperCase();
  return SELLER_PRODUCT_CURRENCY_CODES.includes(code) ? code : 'USD';
};

export function sellerCurrencyRecommendation(location = {}) {
  const country = clean(location.country);
  let countryCode = clean(location.countryCode).toUpperCase();
  if (countryCode === 'UK') countryCode = 'GB';
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    countryCode = COUNTRY_ALIASES[country.toLowerCase()]
      || (/^[a-z]{2}$/i.test(country) ? country.toUpperCase() : '')
      || Object.keys(COUNTRY_CURRENCY).find(code => regionNames?.of(code)?.toLowerCase() === country.toLowerCase())
      || '';
  }
  const countryLabel = countryCode ? (regionNames?.of(countryCode) || country || countryCode) : country;
  const localCurrency = COUNTRY_CURRENCY[countryCode]
    || (SELLER_PRODUCT_CURRENCY_CODES.includes(location.countryCurrency) ? location.countryCurrency : null);
  const hasCountry = Boolean(countryCode || country);
  const currency = localCurrency || 'USD';
  return {
    currency,
    hasCountry,
    isLocalCurrency: Boolean(localCurrency),
    country: countryLabel,
    message: !hasCountry
      ? 'Select your store country to see the recommended currency.'
      : localCurrency
        ? `Based on your country (${countryLabel}), we recommend using ${currency} for your store/brand. This keeps your prices and reports in your local currency.`
        : `Your local currency is not currently supported. USD is the recommended alternative; you can also choose PKR, EUR or GBP.`,
  };
}

export function sellerCurrencyChangeMessage(currency) {
  const code = normalizeSellerProductCurrency(currency);
  return `Your product prices, shipping charges and seller reports will use ${code}. For example, a product price of 100 means 100 ${code}. Buyers can view prices in another supported currency, and checkout converts their order amounts. Choose the currency you use to price your products.`;
}

export function sellerCountryFromProfile(user) {
  const addresses = Array.isArray(user?.savedAddresses) ? user.savedAddresses : [];
  const candidates = [
    user?.sellerInfo,
    addresses.find(address => address.isDefault),
    user?.savedShippingInfo,
    ...addresses,
  ];
  const location = candidates.find(value => clean(value?.country) || clean(value?.countryCode));
  return location ? { country: clean(location.country), countryCode: clean(location.countryCode).toUpperCase() } : null;
}

export function sellerCountryFromDetection(data) {
  // The detection endpoint returns a fallback US/USD response on failure.
  // That fallback must never be presented as the seller's actual country.
  if (data?.detected !== true || !/^[a-z]{2}$/i.test(clean(data.country))) return null;
  const countryCode = clean(data.country).toUpperCase();
  return {
    country: clean(data.countryName) || regionNames?.of(countryCode) || countryCode,
    countryCode,
  };
}
