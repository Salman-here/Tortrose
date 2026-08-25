import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const contextUrl = new URL('../src/contexts/CurrencyContext.jsx', import.meta.url);
const currencySafetyUrl = new URL('../src/utils/currencySafety.js', import.meta.url);

const loadContextHelpers = async () => {
  const contextSource = readFileSync(contextUrl, 'utf8');
  const helperStart = contextSource.indexOf('const CURRENCIES =');
  const helperEnd = contextSource.indexOf('const DEFAULT_RATES =');
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helperSource = contextSource.slice(helperStart, helperEnd);
  const moduleSource = `
    import { roundCurrencyAmount } from ${JSON.stringify(currencySafetyUrl.href)};
    ${helperSource}
  `;
  return import(`data:text/javascript,${encodeURIComponent(moduleSource)}`);
};

const helpers = await loadContextHelpers();

const expectIntegrityFailure = (run, code) => {
  assert.throws(run, error => (
    error?.code === code
    && error?.statusCode === 409
  ));
};

test('strict currency presentation helpers preserve zero and reject masked money values', () => {
  assert.equal(helpers.requireExactPresentationMoney(0), 0);
  assert.equal(helpers.requireExactPresentationMoney(12.34), 12.34);

  for (const corrupt of [
    false,
    '',
    '12.34',
    NaN,
    Infinity,
    -1,
    0.001,
    1.004,
    Number.MAX_SAFE_INTEGER,
  ]) {
    expectIntegrityFailure(
      () => helpers.requireExactPresentationMoney(corrupt),
      'CURRENCY_PRESENTATION_DATA_INVALID',
    );
  }
});

test('strict currency presentation helpers reject blank, unsupported, and noncanonical codes', () => {
  for (const code of ['USD', 'PKR', 'EUR', 'GBP']) {
    assert.equal(helpers.requireCanonicalPresentationCurrency(code), code);
  }
  for (const corrupt of ['', '   ', 'CAD', 'usd', ' USD ', false, 1]) {
    expectIntegrityFailure(
      () => helpers.requireCanonicalPresentationCurrency(corrupt),
      'CURRENCY_PRESENTATION_DATA_INVALID',
    );
  }
});

test('product presentation resolves only genuine legacy fields and never relabels corruption', () => {
  assert.equal(helpers.resolveProductPresentationCurrency({ price: 10 }), 'USD');
  assert.equal(helpers.resolveProductPresentationCurrency({ currency: 'PKR', priceCurrency: 'PKR' }), 'PKR');
  assert.equal(helpers.resolveProductPresentationMoney({ price: 0 }), 0);
  assert.equal(helpers.resolveProductPresentationMoney({ price: null, priceOriginal: 12.5 }), 12.5);
  assert.equal(helpers.resolveProductPresentationMoney({}, 'discountedPrice'), 0);

  for (const corrupt of [null, '', 'usd', ' USD ', 'CAD', false]) {
    expectIntegrityFailure(
      () => helpers.resolveProductPresentationCurrency({ currency: corrupt }),
      'PRODUCT_CURRENCY_METADATA_INVALID',
    );
  }
  expectIntegrityFailure(
    () => helpers.resolveProductPresentationCurrency({ currency: 'USD', priceCurrency: 'PKR' }),
    'PRODUCT_CURRENCY_METADATA_INVALID',
  );
  for (const corrupt of [false, '', '10.00', NaN, Infinity, -1, 0.001]) {
    expectIntegrityFailure(
      () => helpers.resolveProductPresentationMoney({ price: corrupt }),
      'PRODUCT_PRICE_INVALID',
    );
  }
});

test('order-item presentation uses null legacy fallbacks but surfaces present corrupt snapshots', () => {
  assert.deepEqual(
    helpers.resolveOrderItemPresentationMoney({ price: 0, currency: null }, 'USD'),
    { amount: 0, sourceCurrency: 'USD' },
  );
  assert.deepEqual(
    helpers.resolveOrderItemPresentationMoney({
      price: null,
      sourcePrice: 1,
      priceOriginal: 1,
      sourceCurrency: null,
      priceCurrency: 'PKR',
    }, 'USD'),
    { amount: 1, sourceCurrency: 'PKR' },
  );
  assert.deepEqual(
    helpers.resolveOrderItemPresentationMoney({ price: null, sourcePrice: 2.5 }, null),
    { amount: 2.5, sourceCurrency: 'USD' },
  );

  for (const corrupt of [false, '', '1.00', NaN, Infinity, -1, 0.001]) {
    expectIntegrityFailure(
      () => helpers.resolveOrderItemPresentationMoney({ price: corrupt }, 'USD'),
      'ORDER_PRESENTATION_DATA_INVALID',
    );
    expectIntegrityFailure(
      () => helpers.resolveOrderItemPresentationMoney({ price: null, sourcePrice: corrupt }, 'USD'),
      'ORDER_PRESENTATION_DATA_INVALID',
    );
  }
  for (const corrupt of ['', 'CAD', 'usd', ' USD ']) {
    expectIntegrityFailure(
      () => helpers.resolveOrderItemPresentationMoney({ price: 10, currency: corrupt }, 'USD'),
      'ORDER_PRESENTATION_DATA_INVALID',
    );
    expectIntegrityFailure(
      () => helpers.resolveOrderItemPresentationMoney({
        price: null,
        sourcePrice: 10,
        sourceCurrency: corrupt,
      }, 'USD'),
      'ORDER_PRESENTATION_DATA_INVALID',
    );
  }
});

test('provider conversion and formatting paths no longer contain falsy money or currency masking', () => {
  const source = readFileSync(contextUrl, 'utf8');
  assert.doesNotMatch(source, /Number\(amount\s*\|\|\s*0\)/);
  assert.doesNotMatch(source, /convertCurrencyAmount\(amount\s*\|\|\s*0/);
  assert.doesNotMatch(source, /Number\(item\.(?:price|sourcePrice|priceOriginal)/);
  assert.doesNotMatch(source, /item\.(?:sourceCurrency|priceCurrency)\s*\|\|/);
  assert.match(source, /const convertAmount = [\s\S]*?requireExactPresentationMoney\(amount\)/);
  assert.match(source, /const convertAmountForMoneyAction = [\s\S]*?assertSafeCurrencyConversion\(source, target/);
  assert.match(source, /const formatOrderItemPrice = [\s\S]*?resolveOrderItemPresentationMoney/);
});
