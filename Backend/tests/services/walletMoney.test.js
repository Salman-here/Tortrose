const {
  normalizeWalletCurrency,
  roundMoney,
  toStripeMinorUnits,
} = require('../../services/walletService');

describe('wallet money helpers', () => {
  test('keeps supported wallet balances in their own currency', () => {
    expect(normalizeWalletCurrency('pkr')).toBe('PKR');
    expect(normalizeWalletCurrency('EUR')).toBe('EUR');
    expect(() => normalizeWalletCurrency('JPY')).toThrow('not supported');
  });

  test('rounds ledger values and converts Stripe amounts to integer minor units', () => {
    expect(roundMoney(19.999)).toBe(20);
    expect(toStripeMinorUnits(200, 'PKR')).toBe(20000);
    expect(toStripeMinorUnits(5.25, 'USD')).toBe(525);
  });
});
