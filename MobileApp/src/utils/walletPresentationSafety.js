import { roundCurrencyAmount, toCurrencyMinorUnits } from './currencySafety';

export const WALLET_PRESENTATION_CURRENCIES = Object.freeze(['USD', 'PKR', 'EUR', 'GBP']);

const WALLET_STATUSES = new Set(['active', 'locked']);
const TRANSACTION_TYPES = new Set([
  'top_up',
  'order_payment',
  'return_refund',
  'reversal',
  'admin_adjustment',
]);
const TRANSACTION_DIRECTIONS = new Set(['credit', 'debit']);
const TRANSACTION_STATUSES = new Set([
  'pending',
  'completed',
  'failed',
  'cancelled',
  'expired',
  'reversed',
]);

const hasOwn = (value, key) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.prototype.hasOwnProperty.call(value, key)
);

export const exactWalletMoneyIsValid = (value, { positive = false } = {}) => (
  typeof value === 'number'
  && Number.isFinite(value)
  && value >= (positive ? 0.01 : 0)
  && roundCurrencyAmount(value) === value
  && toCurrencyMinorUnits(value) / 100 === value
);

const riskAmountPairIsValid = (row, minorKey, amountKey) => {
  if (!hasOwn(row, minorKey) || !hasOwn(row, amountKey)) return false;
  const minor = row[minorKey];
  const amount = row[amountKey];
  return Number.isSafeInteger(minor)
    && minor >= 0
    && exactWalletMoneyIsValid(amount)
    && minor / 100 === amount;
};

const walletRiskIsValid = (risk) => {
  if (
    !risk
    || typeof risk !== 'object'
    || Array.isArray(risk)
    || typeof risk.restricted !== 'boolean'
    || !Number.isSafeInteger(risk.provisionalCount)
    || risk.provisionalCount < 0
    || typeof risk.canTopUpForSettlement !== 'boolean'
    || !risk.byCurrency
    || typeof risk.byCurrency !== 'object'
    || Array.isArray(risk.byCurrency)
  ) return false;

  const rows = Object.entries(risk.byCurrency);
  if (rows.some(([currency]) => !WALLET_PRESENTATION_CURRENCIES.includes(currency))) return false;
  return rows.every(([, row]) => (
    row
    && typeof row === 'object'
    && !Array.isArray(row)
    && riskAmountPairIsValid(row, 'heldMinor', 'held')
    && riskAmountPairIsValid(row, 'outstandingMinor', 'outstanding')
  ));
};

export const walletTransactionPresentationIsValid = (transaction) => {
  if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) return false;
  const transactionId = transaction._id;
  if (
    typeof transactionId !== 'string'
    || !transactionId.trim()
    || !TRANSACTION_TYPES.has(transaction.type)
    || !TRANSACTION_DIRECTIONS.has(transaction.direction)
    || !TRANSACTION_STATUSES.has(transaction.status)
    || !WALLET_PRESENTATION_CURRENCIES.includes(transaction.currency)
    || !exactWalletMoneyIsValid(transaction.amount, { positive: true })
    || (
      transaction.balanceAfter !== null
      && transaction.balanceAfter !== undefined
      && !exactWalletMoneyIsValid(transaction.balanceAfter)
    )
  ) return false;

  return ['creditedAmount', 'appliedToLiability', 'remainingLiability'].every((field) => (
    !hasOwn(transaction, field) || exactWalletMoneyIsValid(transaction[field])
  ));
};

export const inspectWalletSummaryPresentation = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const wallet = payload.wallet;
  const transactions = payload.transactions;
  if (
    !wallet
    || typeof wallet !== 'object'
    || Array.isArray(wallet)
    || !wallet.balances
    || typeof wallet.balances !== 'object'
    || Array.isArray(wallet.balances)
    || !WALLET_STATUSES.has(wallet.status)
    || !walletRiskIsValid(wallet.paymentRisk)
    || !Array.isArray(transactions)
  ) return null;

  if (!WALLET_PRESENTATION_CURRENCIES.every((currency) => (
    hasOwn(wallet.balances, currency)
    && exactWalletMoneyIsValid(wallet.balances[currency])
  ))) return null;

  const hasOutstandingLiability = Object.values(wallet.paymentRisk.byCurrency)
    .some((row) => row.outstandingMinor > 0);
  if (
    (wallet.status === 'active' && (
      wallet.paymentRisk.restricted
      || wallet.paymentRisk.canTopUpForSettlement
    ))
    || (
      wallet.paymentRisk.canTopUpForSettlement
      && (
        wallet.status !== 'locked'
        || wallet.paymentRisk.restricted !== true
        || !hasOutstandingLiability
      )
    )
  ) return null;

  if (!transactions.every(walletTransactionPresentationIsValid)) return null;
  const transactionIds = transactions.map((transaction) => transaction._id);
  if (new Set(transactionIds).size !== transactionIds.length) return null;
  return { wallet, transactions };
};
