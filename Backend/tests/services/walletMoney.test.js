const {
  normalizeWalletCurrency,
  roundMoney,
  toStripeMinorUnits,
  formatWalletMoney,
  walletTopUpDescription,
  getWalletTransactionDescription,
  validateWalletTopUpPaymentIntent,
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

  test('validates native Wallet top-up ownership, amount, currency, and mode', () => {
    const transaction = {
      _id: '507f1f77bcf86cd799439011',
      user: '507f1f77bcf86cd799439012',
      paymentFlow: 'payment_sheet',
      stripePaymentIntentId: 'pi_wallet_123',
      stripeCustomerId: 'cus_wallet_123',
      stripeMode: 'test',
      amount: 250,
      currency: 'PKR',
    };
    const intent = {
      id: 'pi_wallet_123',
      customer: 'cus_wallet_123',
      amount: 25000,
      currency: 'pkr',
      livemode: false,
      metadata: {
        type: 'wallet_top_up',
        paymentFlow: 'payment_sheet',
        walletTransactionId: transaction._id,
        userId: transaction.user,
        amountMinor: '25000',
        stripeMode: 'test',
      },
    };

    expect(validateWalletTopUpPaymentIntent(transaction, intent)).toBe(true);
    expect(() => validateWalletTopUpPaymentIntent(transaction, {
      ...intent,
      customer: 'cus_other',
    })).toThrow(expect.objectContaining({ code: 'TOP_UP_CUSTOMER_MISMATCH' }));
    expect(() => validateWalletTopUpPaymentIntent(transaction, {
      ...intent,
      livemode: true,
    })).toThrow(expect.objectContaining({ code: 'TOP_UP_MODE_MISMATCH' }));
  });
});
