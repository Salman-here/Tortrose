import {
  inspectManagedProduct,
  inspectProductBulkSelection,
  parseBulkPercentageInput,
  parseSignedBulkMoneyInput,
} from '../../src/utils/productBulkSafety';

const makeProduct = (overrides = {}) => ({
  _id: '64b000000000000000000001',
  price: 200,
  discountedPrice: 150,
  currency: 'PKR',
  priceCurrency: 'PKR',
  discountedPriceCurrency: 'PKR',
  stock: 3,
  ...overrides,
});

describe('mobile seller product bulk money safety', () => {
  it.each(['USD', 'PKR', 'EUR', 'GBP'])('accepts an exact complete %s product snapshot', (currency) => {
    expect(inspectManagedProduct(makeProduct({
      currency,
      priceCurrency: currency,
      discountedPriceCurrency: currency,
    }))).toMatchObject({
      valid: true,
      managementSafe: true,
      moneyValid: true,
      currency,
      price: 200,
      discountedPrice: 150,
      hasDiscount: true,
      stock: 3,
    });
  });

  it('fails closed for malformed money, currency, stock, identifiers, and duplicate selections', () => {
    for (const product of [
      makeProduct({ price: '200' }),
      makeProduct({ price: 200.001 }),
      makeProduct({ discountedPrice: 200 }),
      makeProduct({ priceCurrency: 'USD' }),
      makeProduct({ currency: 'CAD', priceCurrency: 'CAD', discountedPriceCurrency: 'CAD' }),
      makeProduct({ stock: '3' }),
      makeProduct({ _id: 'product-1' }),
    ]) {
      expect(inspectManagedProduct(product).valid).toBe(false);
    }
    const product = makeProduct();
    expect(inspectProductBulkSelection([product, product]).valid).toBe(false);
    expect(inspectProductBulkSelection(Array.from({ length: 251 }, (_, index) => makeProduct({
      _id: index.toString(16).padStart(24, '0'),
    }))).valid).toBe(false);
  });

  it('parses money only at exact minor-unit precision and bounded magnitude', () => {
    expect(parseSignedBulkMoneyInput('10.25')).toBe(10.25);
    expect(parseSignedBulkMoneyInput('-10.25', { allowNegative: true })).toBe(-10.25);
    expect(parseSignedBulkMoneyInput('0', { allowZero: true })).toBe(0);
    for (const value of ['', '0', '-1', '1.001', true, '999999999999999999999']) {
      expect(parseSignedBulkMoneyInput(value)).toBeNull();
    }
  });

  it('parses non-zero percentages without exponent or excessive precision', () => {
    expect(parseBulkPercentageInput('12.123456')).toBe(12.123456);
    expect(parseBulkPercentageInput('-100', { minimum: -100 })).toBe(-100);
    for (const value of ['', '0', '1e2', '12.1234567', true, Number.POSITIVE_INFINITY]) {
      expect(parseBulkPercentageInput(value)).toBeNull();
    }
  });
});
