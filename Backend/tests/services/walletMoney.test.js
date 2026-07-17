const {
  normalizeWalletCurrency,
  roundMoney,
  toStripeMinorUnits,
  formatWalletMoney,
  walletTopUpDescription,
  getWalletTransactionDescription,
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

  test('formats wallet amounts in their native currency without converting from USD', () => {
    expect(formatWalletMoney(300, 'PKR')).toBe('Rs300.00 PKR');
    expect(walletTopUpDescription(300, 'PKR')).toBe('Rozare Wallet top-up of Rs300.00 PKR');
  });

  test('repairs legacy top-up descriptions from authoritative amount and currency fields', () => {
    expect(getWalletTransactionDescription({
      type: 'top_up',
      amount: 300,
      currency: 'PKR',
      description: 'Rozare Wallet top-up of Rs83,370.00 PKR',
    })).toBe('Rozare Wallet top-up of Rs300.00 PKR');

    expect(getWalletTransactionDescription({
      type: 'order_payment',
      amount: 300,
      currency: 'PKR',
      description: 'Payment for order ROZ-123',
    })).toBe('Payment for order ROZ-123');
  });
});
