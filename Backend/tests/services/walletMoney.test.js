const {
  normalizeWalletCurrency,
  roundMoney,
  toStripeMinorUnits,
  fromStripeMinorUnits,
  formatWalletMoney,
  walletTopUpDescription,
  getWalletTransactionDescription,
  creditWalletInSession,
  debitWalletInSession,
  serializeWalletTransaction,
  validateWalletTopUpPaymentIntent,
  validateWalletTopUpCheckoutSession,
} = require('../../services/walletService');

describe('wallet money helpers', () => {
  test('keeps supported wallet balances in their own currency', () => {
    expect(normalizeWalletCurrency('pkr')).toBe('PKR');
    expect(normalizeWalletCurrency('EUR')).toBe('EUR');
    expect(() => normalizeWalletCurrency('JPY')).toThrow('not supported');
    expect(() => normalizeWalletCurrency(false)).toThrow('not supported');
    expect(() => normalizeWalletCurrency('')).toThrow('not supported');
  });

  test('rounds ledger values and converts Stripe amounts to integer minor units', () => {
    expect(roundMoney(19.999)).toBe(20);
    expect(roundMoney(1.005)).toBe(1.01);
    expect(toStripeMinorUnits(200, 'PKR')).toBe(20000);
    expect(toStripeMinorUnits(5.25, 'USD')).toBe(525);
    expect(toStripeMinorUnits(1.005, 'USD')).toBe(101);
    expect(toStripeMinorUnits(2.675, 'EUR')).toBe(268);
    expect(fromStripeMinorUnits(101, 'USD')).toBe(1.01);
    expect(fromStripeMinorUnits(268, 'EUR')).toBe(2.68);
  });

  test.each([true, false, '', '1', {}, [], -1, Number.POSITIVE_INFINITY])(
    'rejects malformed Wallet major-unit amount %p before Stripe conversion',
    (amount) => {
      expect(() => toStripeMinorUnits(amount, 'USD'))
        .toThrow(expect.objectContaining({ code: 'WALLET_MONEY_INVALID' }));
    },
  );

  test.each([true, false, '', '1', {}, [], -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects malformed Stripe minor-unit amount %p',
    (amount) => {
      expect(() => fromStripeMinorUnits(amount, 'USD'))
        .toThrow(expect.objectContaining({ code: 'WALLET_MONEY_INVALID' }));
    },
  );

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

  test('serializes exact stored transaction money without coercing or clamping metadata counters', () => {
    expect(serializeWalletTransaction({
      _id: 'wallet-transaction-valid',
      type: 'top_up',
      direction: 'credit',
      status: 'completed',
      amount: 12.34,
      currency: 'PKR',
      balanceAfter: 20,
      metadata: {
        availableCreditedMinor: 1000,
        liabilityAppliedMinor: 234,
        remainingLiabilityMinor: 500,
      },
    })).toMatchObject({
      amount: 12.34,
      currency: 'PKR',
      balanceAfter: 20,
      creditedAmount: 10,
      appliedToLiability: 2.34,
      remainingLiability: 5,
    });

    expect(serializeWalletTransaction({
      _id: 'wallet-transaction-legacy',
      type: 'order_payment',
      direction: 'debit',
      status: 'completed',
      amount: 1,
      currency: 'USD',
      balanceAfter: null,
      metadata: {},
    })).toMatchObject({
      balanceAfter: null,
      creditedAmount: 0,
      appliedToLiability: 0,
      remainingLiability: 0,
    });
  });

  test.each([
    '100',
    true,
    null,
    -1,
    1.5,
    7_036_874_417_766_401,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    'rejects corrupt stored Wallet transaction minor counter %p instead of presenting zero',
    (corruptMinor) => {
      expect(() => serializeWalletTransaction({
        _id: 'wallet-transaction-corrupt-metadata',
        type: 'top_up',
        direction: 'credit',
        status: 'completed',
        amount: 1,
        currency: 'USD',
        balanceAfter: 1,
        metadata: { availableCreditedMinor: corruptMinor },
      })).toThrow(expect.objectContaining({
        code: 'WALLET_TRANSACTION_MONEY_INVALID',
        statusCode: 503,
      }));
    },
  );

  test.each([null, false, ''])('rejects a present corrupt transaction metadata container %p', (metadata) => {
    expect(() => serializeWalletTransaction({
      _id: 'wallet-transaction-corrupt-metadata-container',
      type: 'top_up',
      direction: 'credit',
      status: 'completed',
      amount: 1,
      currency: 'USD',
      balanceAfter: 1,
      metadata,
    })).toThrow(expect.objectContaining({
      code: 'WALLET_TRANSACTION_MONEY_INVALID',
      statusCode: 503,
    }));
  });

  test.each([
    { field: 'amount', amount: '1', balanceAfter: 1, currency: 'USD' },
    { field: 'amount', amount: false, balanceAfter: 1, currency: 'USD' },
    { field: 'amount', amount: 1.001, balanceAfter: 1, currency: 'USD' },
    { field: 'balanceAfter', amount: 1, balanceAfter: -1, currency: 'USD' },
    { field: 'currency', amount: 1, balanceAfter: 1, currency: null },
    { field: 'currency', amount: 1, balanceAfter: 1, currency: 'usd' },
    { field: 'currency', amount: 1, balanceAfter: 1, currency: ' USD ' },
  ])('rejects corrupt stored Wallet transaction $field', ({ amount, balanceAfter, currency }) => {
    expect(() => serializeWalletTransaction({
      _id: 'wallet-transaction-corrupt-money',
      type: 'top_up',
      direction: 'credit',
      status: 'completed',
      amount,
      currency,
      balanceAfter,
      metadata: {},
    })).toThrow(expect.objectContaining({
      code: 'WALLET_TRANSACTION_MONEY_INVALID',
      statusCode: 503,
    }));
  });

  test.each(['1', true, false, null, {}, [], Number.POSITIVE_INFINITY])(
    'rejects malformed direct Wallet mutation amount %p before database work',
    async (amount) => {
      const input = {
        userId: '507f1f77bcf86cd799439012',
        amount,
        currency: 'USD',
        type: 'admin_adjustment',
        referenceType: 'admin',
        referenceId: 'invalid-direct-money',
        idempotencyKey: 'invalid-direct-money',
        description: 'Must fail before database work',
      };
      await expect(creditWalletInSession(input, null)).rejects.toMatchObject({
        code: 'WALLET_MONEY_INVALID',
        statusCode: 400,
      });
      await expect(debitWalletInSession(input, null)).rejects.toMatchObject({
        code: 'WALLET_MONEY_INVALID',
        statusCode: 400,
      });
    },
  );

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
    expect(() => validateWalletTopUpPaymentIntent(transaction, {
      ...intent,
      amount: '25000',
    })).toThrow(expect.objectContaining({ code: 'TOP_UP_AMOUNT_MISMATCH' }));
    expect(() => validateWalletTopUpPaymentIntent(transaction, {
      ...intent,
      livemode: undefined,
    })).toThrow(expect.objectContaining({ code: 'TOP_UP_MODE_MISMATCH' }));
    expect(() => validateWalletTopUpPaymentIntent(transaction, {
      ...intent,
      metadata: { ...intent.metadata, amountMinor: '025000' },
    })).toThrow(expect.objectContaining({ code: 'TOP_UP_AMOUNT_MISMATCH' }));

    const sessionTransaction = {
      ...transaction,
      paymentFlow: 'checkout_session',
      stripeSessionId: 'cs_wallet_123',
    };
    const checkoutSession = {
      id: 'cs_wallet_123',
      mode: 'payment',
      customer: transaction.stripeCustomerId,
      amount_total: 25000,
      currency: 'pkr',
      livemode: false,
      metadata: {
        type: 'wallet_top_up',
        paymentFlow: 'checkout_session',
        walletTransactionId: transaction._id,
        userId: transaction.user,
        stripeMode: 'test',
      },
    };
    expect(validateWalletTopUpCheckoutSession(sessionTransaction, checkoutSession)).toBe(true);
    expect(() => validateWalletTopUpCheckoutSession(sessionTransaction, {
      ...checkoutSession,
      amount_total: '25000',
    })).toThrow(expect.objectContaining({ code: 'TOP_UP_AMOUNT_MISMATCH' }));
    expect(() => validateWalletTopUpCheckoutSession(sessionTransaction, {
      ...checkoutSession,
      livemode: undefined,
    })).toThrow(expect.objectContaining({ code: 'TOP_UP_MODE_MISMATCH' }));
  });
});
