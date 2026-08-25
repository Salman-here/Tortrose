'use strict';

const mongoose = require('mongoose');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');

const userId = new mongoose.Types.ObjectId();

const validTransaction = overrides => new WalletTransaction({
  user: userId,
  type: 'admin_adjustment',
  direction: 'credit',
  status: 'completed',
  amount: 10,
  currency: 'USD',
  balanceAfter: 10,
  referenceType: 'admin',
  referenceId: 'wallet-model-validation',
  idempotencyKey: 'wallet-model-validation',
  ...overrides,
});

describe('wallet money persistence validation', () => {
  test.each([true, false, '', ' ', {}, [], Number.POSITIVE_INFINITY, 1.001, Number.MAX_SAFE_INTEGER])(
    'rejects malformed Wallet balances: %p',
    async (amount) => {
      const wallet = new Wallet({ user: userId, balances: { USD: amount } });
      await expect(wallet.validate()).rejects.toBeDefined();
    },
  );

  test.each([true, false, '', ' ', {}, [], Number.POSITIVE_INFINITY, 0, -1, 1.001, Number.MAX_SAFE_INTEGER])(
    'rejects malformed Wallet transaction amounts: %p',
    async (amount) => {
      await expect(validTransaction({ amount }).validate()).rejects.toBeDefined();
    },
  );

  test.each([true, false, '', ' ', {}, [], Number.POSITIVE_INFINITY, -1, 1.001, Number.MAX_SAFE_INTEGER])(
    'rejects malformed Wallet transaction balances: %p',
    async (balanceAfter) => {
      await expect(validTransaction({ balanceAfter }).validate()).rejects.toBeDefined();
    },
  );

  test('accepts every supported currency with exact cent values and a null pending balance', async () => {
    await expect(new Wallet({
      user: userId,
      balances: { USD: 1.01, PKR: 2.02, EUR: 3.03, GBP: 4.04 },
    }).validate()).resolves.toBeUndefined();
    await expect(validTransaction({ currency: 'PKR', amount: 277.51, balanceAfter: null }).validate())
      .resolves.toBeUndefined();
  });
});
