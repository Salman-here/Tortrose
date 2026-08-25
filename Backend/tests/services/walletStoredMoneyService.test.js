'use strict';

const {
  projectStoredWalletBalanceMinor,
  readStoredWalletBalance,
  readStoredWalletBalanceMinor,
} = require('../../services/walletStoredMoneyService');

describe('stored Wallet money boundary', () => {
  test('treats an absent historical currency bucket as exact zero', () => {
    const wallet = { balances: { USD: 10 } };
    expect(readStoredWalletBalance(wallet, 'PKR')).toBe(0);
    expect(readStoredWalletBalanceMinor(wallet, 'PKR')).toBe(0);
  });

  test('normalizes finite historical floating residue to exact minor units', () => {
    const wallet = { balances: { USD: 0.30000000000000004 } };
    expect(readStoredWalletBalance(wallet, 'USD')).toBe(0.3);
    expect(readStoredWalletBalanceMinor(wallet, 'USD')).toBe(30);
  });

  test.each([null, false, '10', -1, 1.001, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a present corrupt Wallet balance %p instead of converting it to zero',
    (value) => {
      const wallet = { balances: { USD: value } };
      expect(() => readStoredWalletBalance(wallet, 'USD')).toThrow(expect.objectContaining({
        code: 'WALLET_STORED_MONEY_INVALID',
        statusCode: 503,
      }));
      expect(() => readStoredWalletBalanceMinor(wallet, 'USD')).toThrow(expect.objectContaining({
        code: 'WALLET_STORED_MONEY_INVALID',
        statusCode: 503,
      }));
    },
  );

  test.each([null, false, '', 'usd', ' USD ', 'JPY'])('rejects invalid stored currency %p', (currency) => {
    expect(() => readStoredWalletBalance({ balances: {} }, currency)).toThrow(expect.objectContaining({
      code: 'WALLET_STORED_MONEY_INVALID',
      statusCode: 503,
    }));
  });

  test.each([null, { balances: null }, { balances: false }])(
    'rejects an invalid Wallet/balances container %p',
    (wallet) => {
      expect(() => readStoredWalletBalance(wallet, 'USD')).toThrow(expect.objectContaining({
        code: 'WALLET_STORED_MONEY_INVALID',
        statusCode: 503,
      }));
    },
  );

  test('rejects a credit whose projected balance exceeds reversible cent storage', () => {
    const wallet = { balances: { USD: 70_368_744_177_664 } };
    expect(() => projectStoredWalletBalanceMinor(wallet, 'USD', 1)).toThrow(expect.objectContaining({
      code: 'WALLET_STORED_MONEY_INVALID',
      statusCode: 503,
    }));
  });
});
