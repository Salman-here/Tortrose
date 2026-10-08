const fs = require('node:fs');
const { commonJsSource, ensureDecoder, VERSION, COMMONJS_HASH } = require('../../scripts/ensure-safe-uri-decoder');
const decode = require('decode-uri-component');
const queryString = require('query-string');

test('the fixed upstream decoder remains a synchronous CommonJS function for existing navigation', () => {
  expect(typeof decode).toBe('function');
  expect(ensureDecoder()).toEqual({ version: VERSION, sourceHash: COMMONJS_HASH });
  const source = fs.readFileSync(require.resolve('decode-uri-component'), 'utf8');
  expect(commonJsSource(source)).toBe(source);
});

test('an unexpected or changed decoder implementation fails closed instead of receiving a blind patch', () => {
  expect(() => commonJsSource('module.exports = () => "unreviewed";')).toThrow('Audited URI decoder source changed');
});

test.each([
  ['Black%20%26%20White', 'Black & White'],
  ['Pakistan%2FLahore', 'Pakistan/Lahore'],
  ['%E2%82%AC%20price', '€ price'],
  ['%D9%BE%D8%A7%DA%A9%D8%B3%D8%AA%D8%A7%D9%86', 'پاکستان'],
])('valid encoded navigation text %s preserves its original value', (encoded, expected) => {
  expect(decode(encoded)).toBe(expected);
  expect(queryString.parse(`option=${encoded}`).option).toBe(expected);
});

test('malformed encoded input completes without exponential fallback recursion', () => {
  const input = '%C0'.repeat(2000) + '%41';
  const decoded = decode(input);
  expect(typeof decoded).toBe('string');
  expect(decoded.endsWith('A')).toBe(true);
  expect(queryString.parse(`value=${input}`).value).toBe(decoded);
});

test('ordinary payment-return query parameters retain literal values and do not claim payment success', () => {
  const result = queryString.parse('purpose=subdomain&outcome=cancelled&note=check%20payment');
  expect(result).toMatchObject({ purpose: 'subdomain', outcome: 'cancelled', note: 'check payment' });
  expect(queryString.stringify({ currency: 'GBP', note: 'A & B' })).toBe('currency=GBP&note=A%20%26%20B');
});
