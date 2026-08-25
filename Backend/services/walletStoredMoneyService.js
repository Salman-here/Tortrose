'use strict';

const { fromMinorUnits, roundMoney, toMinorUnits } = require('./moneyMath');

const WALLET_CURRENCIES = Object.freeze(['USD', 'PKR', 'EUR', 'GBP']);
const MAX_LEGACY_BINARY_RESIDUE = 1e-9;

const storedWalletMoneyError = field => {
  const error = new Error(`Stored Wallet money is invalid at ${field}. Contact support before retrying.`);
  error.code = 'WALLET_STORED_MONEY_INVALID';
  error.statusCode = 503;
  return error;
};

const requireStoredWalletCurrency = currency => {
  // This boundary is used with already-normalized request currency or with a
  // persisted transaction currency. Silently uppercasing a corrupt persisted
  // value is unsafe because the following Mongo update would address a
  // different balance path (for example balances.usd instead of balances.USD).
  if (typeof currency !== 'string' || !WALLET_CURRENCIES.includes(currency)) {
    throw storedWalletMoneyError('currency');
  }
  return currency;
};

// Historical Wallets may omit a currency bucket that did not exist when they
// were created; absence therefore means exact zero. A present value must be a
// finite, non-negative Number. Null, strings, booleans and infinities are
// corruption and must never be converted into zero by a financial mutation.
const readStoredWalletBalance = (wallet, currency) => {
  const normalizedCurrency = requireStoredWalletCurrency(currency);
  if (!wallet || typeof wallet !== 'object') throw storedWalletMoneyError('wallet');
  if (
    wallet.balances !== undefined
    && (
      wallet.balances === null
      || typeof wallet.balances !== 'object'
      || Array.isArray(wallet.balances)
    )
  ) {
    throw storedWalletMoneyError('balances');
  }
  const value = wallet?.balances?.[normalizedCurrency];
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw storedWalletMoneyError(`balances.${normalizedCurrency}`);
  }
  try {
    const normalized = roundMoney(value);
    if (Math.abs(normalized - value) > MAX_LEGACY_BINARY_RESIDUE) {
      throw storedWalletMoneyError(`balances.${normalizedCurrency}`);
    }
    return normalized;
  } catch (_error) {
    throw storedWalletMoneyError(`balances.${normalizedCurrency}`);
  }
};

const readStoredWalletBalanceMinor = (wallet, currency) => {
  try {
    return toMinorUnits(readStoredWalletBalance(wallet, currency));
  } catch (error) {
    if (error?.code === 'WALLET_STORED_MONEY_INVALID') throw error;
    const normalizedCurrency = requireStoredWalletCurrency(currency);
    throw storedWalletMoneyError(`balances.${normalizedCurrency}`);
  }
};

const projectStoredWalletBalanceMinor = (wallet, currency, deltaMinor) => {
  const normalizedCurrency = requireStoredWalletCurrency(currency);
  if (typeof deltaMinor !== 'number' || !Number.isSafeInteger(deltaMinor)) {
    throw storedWalletMoneyError(`balances.${normalizedCurrency} delta`);
  }
  const currentMinor = readStoredWalletBalanceMinor(wallet, normalizedCurrency);
  const projectedMinor = currentMinor + deltaMinor;
  if (!Number.isSafeInteger(projectedMinor) || projectedMinor < 0) {
    throw storedWalletMoneyError(`balances.${normalizedCurrency} projected`);
  }
  try {
    // Number.isSafeInteger alone is not enough for major-unit Number storage;
    // fromMinorUnits also enforces the tighter reversible-cent boundary.
    fromMinorUnits(projectedMinor);
  } catch (_error) {
    throw storedWalletMoneyError(`balances.${normalizedCurrency} projected`);
  }
  return projectedMinor;
};

module.exports = {
  WALLET_CURRENCIES,
  requireStoredWalletCurrency,
  projectStoredWalletBalanceMinor,
  readStoredWalletBalance,
  readStoredWalletBalanceMinor,
};
