import { shouldRetainIdempotencyKey, toCurrencyMinorUnits } from './currencySafety';

const hasOwn = (value, key) => (
  value !== null
  && typeof value === 'object'
  && Object.prototype.hasOwnProperty.call(value, key)
);

const toNonNegativeMinorUnits = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const minor = toCurrencyMinorUnits(value);
  if ((value !== 0 && minor === 0) || (minor / 100) !== value) return null;
  return minor;
};

const readRiskAmount = (risk, minorKey, amountKey) => {
  if (!risk || typeof risk !== 'object') return null;
  if (hasOwn(risk, minorKey)) {
    const minor = risk[minorKey];
    if (!Number.isSafeInteger(minor) || minor < 0) return null;
    const amount = minor / 100;
    return toCurrencyMinorUnits(amount) === minor ? amount : null;
  }
  return hasOwn(risk, amountKey) && toNonNegativeMinorUnits(risk[amountKey]) !== null
    ? Number(risk[amountKey])
    : null;
};

export const getWalletCurrencyRisk = (wallet, currency) => {
  const normalizedCurrency = String(currency || '').toUpperCase();
  const raw = wallet?.paymentRisk?.byCurrency?.[normalizedCurrency];
  return {
    held: readRiskAmount(raw, 'heldMinor', 'held'),
    outstanding: readRiskAmount(raw, 'outstandingMinor', 'outstanding'),
  };
};

export const canTopUpWalletCurrency = (wallet, currency) => {
  const status = String(wallet?.status || '').toLowerCase();
  if (status === 'active') return true;
  if (status !== 'locked' || wallet?.paymentRisk?.canTopUpForSettlement !== true) return false;
  const { outstanding } = getWalletCurrencyRisk(wallet, currency);
  return outstanding !== null && outstanding > 0;
};

export const isWalletRiskSettlementTopUp = (wallet, currency) => (
  String(wallet?.status || '').toLowerCase() === 'locked'
  && canTopUpWalletCurrency(wallet, currency)
);

export const shouldRetainWalletTopUpAttempt = (error = {}) => {
  const code = String(error?.response?.data?.code ?? error?.code ?? '');
  if (code === 'WALLET_TOP_UP_RETRY_REQUIRED') return false;
  return shouldRetainIdempotencyKey(error?.response?.status ?? error?.status)
    || [
      'PAYMENT_ATTEMPT_RECOVERY_PENDING',
      'PAYMENT_SETUP_RECOVERY_REQUIRED',
      'PAYMENT_ALREADY_SUCCEEDED',
    ].includes(code);
};

export const getTopUpCompletionBreakdown = (transaction) => {
  if (!transaction || String(transaction.status || '').toLowerCase() !== 'completed') return null;
  if (
    !hasOwn(transaction, 'creditedAmount')
    || !hasOwn(transaction, 'appliedToLiability')
    || !hasOwn(transaction, 'remainingLiability')
  ) return null;

  const amountMinor = toNonNegativeMinorUnits(transaction.amount);
  const creditedMinor = toNonNegativeMinorUnits(transaction.creditedAmount);
  const appliedMinor = toNonNegativeMinorUnits(transaction.appliedToLiability);
  const remainingMinor = toNonNegativeMinorUnits(transaction.remainingLiability);
  const currency = String(transaction.currency || '').toUpperCase();
  if (
    amountMinor === null
    || amountMinor <= 0
    || creditedMinor === null
    || appliedMinor === null
    || remainingMinor === null
    || BigInt(creditedMinor) + BigInt(appliedMinor) !== BigInt(amountMinor)
    || (remainingMinor > 0 && creditedMinor > 0)
    || !/^[A-Z]{3}$/.test(currency)
  ) return null;

  return {
    creditedAmount: creditedMinor / 100,
    appliedToLiability: appliedMinor / 100,
    remainingLiability: remainingMinor / 100,
    currency,
  };
};

export const findWalletTransaction = (payload, transactionId) => {
  const root = payload?.data || payload || {};
  const direct = root?.transaction;
  if (direct && (!transactionId || String(direct._id || direct.id) === String(transactionId))) return direct;
  const transactions = root?.transactions || root?.wallet?.transactions;
  if (!Array.isArray(transactions)) return null;
  return transactions.find(transaction => (
    String(transaction?._id || transaction?.id) === String(transactionId || '')
  )) || null;
};
