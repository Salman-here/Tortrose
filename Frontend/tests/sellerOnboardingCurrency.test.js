import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SELLER_PRODUCT_CURRENCY_CODES,
  sellerCountryFromDetection,
  sellerCountryFromProfile,
  sellerCurrencyChangeMessage,
  sellerCurrencyRecommendation,
} from '../src/utils/sellerOnboardingCurrency.js';

const becomeSellerSource = readFileSync(
  new URL('../src/pages/BecomeSeller.jsx', import.meta.url),
  'utf8'
);
const routesSource = readFileSync(
  new URL('../src/routes/AppRoutes.jsx', import.meta.url),
  'utf8'
);

test('the routed web seller setup exposes every supported native listing currency', () => {
  assert.deepEqual(SELLER_PRODUCT_CURRENCY_CODES, ['USD', 'PKR', 'EUR', 'GBP']);
  assert.match(becomeSellerSource, /name="productCurrency"/);
  assert.match(becomeSellerSource, /value=\{storeData\.productCurrency\}/);
  assert.match(becomeSellerSource, /Product Listing Currency/);
});

test('recommends the supported local currency for country codes and legacy country names', () => {
  for (const [countryCode, currency] of [
    ['PK', 'PKR'], ['US', 'USD'], ['GB', 'GBP'], ['DE', 'EUR'], ['NL', 'EUR'],
    ['HR', 'EUR'], ['BG', 'EUR'], ['IE', 'EUR'], ['EC', 'USD'],
  ]) {
    const result = sellerCurrencyRecommendation({ countryCode });
    assert.equal(result.currency, currency, countryCode);
    assert.equal(result.isLocalCurrency, true, countryCode);
  }
  assert.equal(sellerCurrencyRecommendation({ country: ' Pakistan ' }).currency, 'PKR');
  assert.equal(sellerCurrencyRecommendation({ country: 'United Kingdom' }).currency, 'GBP');
  assert.equal(sellerCurrencyRecommendation({ country: 'Germany' }).currency, 'EUR');
});

test('uses country instead of a newly registered account USD default', () => {
  const country = sellerCountryFromProfile({
    currency: 'USD', savedShippingInfo: { country: 'Pakistan', countryCode: 'PK' },
  });
  assert.equal(sellerCurrencyRecommendation(country).currency, 'PKR');
  assert.equal(sellerCountryFromProfile({ currency: 'USD' }), null);
});

test('distinguishes an unsupported local currency and a missing country', () => {
  const japan = sellerCurrencyRecommendation({ countryCode: 'JP', country: 'Japan', countryCurrency: 'JPY' });
  assert.equal(japan.currency, 'USD');
  assert.equal(japan.isLocalCurrency, false);
  assert.match(japan.message, /local currency is not currently supported/);
  assert.equal(sellerCurrencyRecommendation({}).hasCountry, false);
});

test('ignores failed geolocation US defaults and accepts real country detection', () => {
  assert.equal(sellerCountryFromDetection({ country: 'US', currency: 'USD', detected: false }), null);
  assert.deepEqual(sellerCountryFromDetection({ country: 'PK', countryName: 'Pakistan', detected: true }), {
    country: 'Pakistan', countryCode: 'PK',
  });
});

test('explains the selected currency and keeps web/mobile recommendation rules identical', () => {
  assert.match(sellerCurrencyChangeMessage('GBP'), /100 means 100 GBP/);
  assert.match(sellerCurrencyChangeMessage('PKR'), /seller reports will use PKR/);
  assert.equal(
    readFileSync(new URL('../src/utils/sellerOnboardingCurrency.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n'),
    readFileSync(new URL('../../MobileApp/src/utils/sellerOnboardingCurrency.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n'),
  );
});

test('web seller activation sends the visible listing currency to the backend', () => {
  assert.match(becomeSellerSource, /productCurrency:\s*storeData\.productCurrency/);
  assert.match(becomeSellerSource, /useCurrency\(\)/);
});

test('existing buyers bind seller WhatsApp OTP send and verify to their authenticated account', () => {
  const authenticatedOtpCalls = becomeSellerSource.match(
    /api\/seller-whatsapp\/(?:send-otp|verify-otp)[\s\S]{0,260}Authorization:\s*`Bearer \$\{token\}`/g
  ) || [];
  assert.equal(authenticatedOtpCalls.length, 2);
});

test('the live seller-signup alias resolves to the hardened BecomeSeller flow', () => {
  assert.match(routesSource, /path='\/become-seller'\s+element=\{<BecomeSeller\s*\/>\}/);
  assert.match(routesSource, /path='\/seller-signup'\s+element=\{<Navigate to='\/become-seller' replace\s*\/>\}/);
});
