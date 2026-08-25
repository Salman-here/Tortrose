import {
  SUPPORTED_CURRENCY_CODES,
  shouldRetainIdempotencyKey,
  toCurrencyMinorUnits,
} from './currencySafety.js';

const WALLET_CURRENCY_SET = new Set(SUPPORTED_CURRENCY_CODES);
const WALLET_STATUSES = new Set(['active', 'locked']);
const WALLET_LOCK_SOURCES = new Set(['payment_risk', 'manual', 'system']);
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
const TRANSACTION_REFERENCE_TYPES = new Set([
  'stripe_checkout',
  'stripe_payment_intent',
  'stripe_dispute',
  'stripe_refund',
  'order',
  'return_request',
  'admin',
  'system',
]);

const hasOwn = (value, key) => (
  value !== null
  && typeof value === 'object'
  && Object.prototype.hasOwnProperty.call(value, key)
);

const isPlainObject = value => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
);

const exactWalletCurrency = value => (
  typeof value === 'string'
  && WALLET_CURRENCY_SET.has(value)
  ? value
  : null
);

const exactObjectId = value => (
  typeof value === 'string'
  && /^[a-f\d]{24}$/.test(value)
  ? value
  : null
);

const isValidDateValue = value => (
  (typeof value === 'string' || value instanceof Date)
  && Number.isFinite(new Date(value).getTime())
);

const toNonNegativeMinorUnits = (value) => {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || Object.is(value, -0)
  ) return null;
  const minor = toCurrencyMinorUnits(value);
  if ((value !== 0 && minor === 0) || (minor / 100) !== value) return null;
  return minor;
};

const toPositiveMinorUnits = value => {
  const minor = toNonNegativeMinorUnits(value);
  return minor !== null && minor > 0 ? minor : null;
};

const walletPresentationError = message => {
  const error = new Error(message);
  error.code = 'WALLET_PRESENTATION_DATA_INVALID';
  return error;
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
    ? risk[amountKey]
    : null;
};

export const getWalletCurrencyRisk = (wallet, currency) => {
  const exactCurrency = exactWalletCurrency(currency);
  const raw = exactCurrency ? wallet?.paymentRisk?.byCurrency?.[exactCurrency] : null;
  return {
    held: readRiskAmount(raw, 'heldMinor', 'held'),
    outstanding: readRiskAmount(raw, 'outstandingMinor', 'outstanding'),
  };
};

export const canTopUpWalletCurrency = (wallet, currency) => {
  if (!exactWalletCurrency(currency)) return false;
  const status = wallet?.status;
  if (status === 'active') return true;
  if (status !== 'locked' || wallet?.paymentRisk?.canTopUpForSettlement !== true) return false;
  const { outstanding } = getWalletCurrencyRisk(wallet, currency);
  return outstanding !== null && outstanding > 0;
};

export const isWalletRiskSettlementTopUp = (wallet, currency) => (
  wallet?.status === 'locked'
  && canTopUpWalletCurrency(wallet, currency)
);

export const getWalletCreditCompletionBreakdown = (transaction) => {
  if (
    !transaction
    || transaction.direction !== 'credit'
    || transaction.status !== 'completed'
  ) return null;
  if (
    !hasOwn(transaction, 'creditedAmount')
    || !hasOwn(transaction, 'appliedToLiability')
    || !hasOwn(transaction, 'remainingLiability')
  ) return null;

  const amountMinor = toNonNegativeMinorUnits(transaction.amount);
  const creditedMinor = toNonNegativeMinorUnits(transaction.creditedAmount);
  const appliedMinor = toNonNegativeMinorUnits(transaction.appliedToLiability);
  const remainingMinor = toNonNegativeMinorUnits(transaction.remainingLiability);
  const currency = exactWalletCurrency(transaction.currency);
  if (
    amountMinor === null
    || amountMinor <= 0
    || creditedMinor === null
    || appliedMinor === null
    || remainingMinor === null
    || BigInt(creditedMinor) + BigInt(appliedMinor) !== BigInt(amountMinor)
    || (remainingMinor > 0 && creditedMinor > 0)
    || !currency
    || (creditedMinor === 0 && appliedMinor === 0 && remainingMinor === 0)
  ) return null;

  return {
    creditedAmount: creditedMinor / 100,
    appliedToLiability: appliedMinor / 100,
    remainingLiability: remainingMinor / 100,
    currency,
  };
};

export const getTopUpCompletionBreakdown = transaction => (
  transaction?.type === 'top_up'
    ? getWalletCreditCompletionBreakdown(transaction)
    : null
);

const inspectRiskCurrency = (risk, currency) => {
  const errors = [];
  if (!isPlainObject(risk)) {
    return { valid: false, errors: [`paymentRisk.byCurrency.${currency} must be an object.`] };
  }
  for (const field of ['heldMinor', 'outstandingMinor', 'held', 'outstanding']) {
    if (!hasOwn(risk, field)) errors.push(`paymentRisk.byCurrency.${currency}.${field} is missing.`);
  }
  const heldMinor = risk.heldMinor;
  const outstandingMinor = risk.outstandingMinor;
  const held = risk.held;
  const outstanding = risk.outstanding;
  if (!Number.isSafeInteger(heldMinor) || heldMinor < 0) {
    errors.push(`paymentRisk.byCurrency.${currency}.heldMinor is invalid.`);
  }
  if (!Number.isSafeInteger(outstandingMinor) || outstandingMinor < 0) {
    errors.push(`paymentRisk.byCurrency.${currency}.outstandingMinor is invalid.`);
  }
  if (
    toNonNegativeMinorUnits(held) === null
    || toNonNegativeMinorUnits(held) !== heldMinor
  ) errors.push(`paymentRisk.byCurrency.${currency}.held conflicts with heldMinor.`);
  if (
    toNonNegativeMinorUnits(outstanding) === null
    || toNonNegativeMinorUnits(outstanding) !== outstandingMinor
  ) errors.push(`paymentRisk.byCurrency.${currency}.outstanding conflicts with outstandingMinor.`);
  return { valid: errors.length === 0, errors };
};

export const inspectWalletTransaction = (transaction) => {
  const errors = [];
  if (!isPlainObject(transaction)) {
    return { valid: false, transaction: null, errors: ['Wallet transaction must be an object.'] };
  }

  const id = exactObjectId(transaction._id);
  const currency = exactWalletCurrency(transaction.currency);
  const amountMinor = toPositiveMinorUnits(transaction.amount);
  const balanceAfterMinor = transaction.balanceAfter === null
    ? null
    : toNonNegativeMinorUnits(transaction.balanceAfter);
  const creditedMinor = toNonNegativeMinorUnits(transaction.creditedAmount);
  const appliedMinor = toNonNegativeMinorUnits(transaction.appliedToLiability);
  const remainingMinor = toNonNegativeMinorUnits(transaction.remainingLiability);

  if (!id) errors.push('Wallet transaction id is invalid.');
  if (!TRANSACTION_TYPES.has(transaction.type)) errors.push('Wallet transaction type is invalid.');
  if (!TRANSACTION_DIRECTIONS.has(transaction.direction)) errors.push('Wallet transaction direction is invalid.');
  if (!TRANSACTION_STATUSES.has(transaction.status)) errors.push('Wallet transaction status is invalid.');
  if (amountMinor === null) errors.push('Wallet transaction amount is invalid.');
  if (!currency) errors.push('Wallet transaction currency is invalid.');
  if (transaction.balanceAfter !== null && balanceAfterMinor === null) {
    errors.push('Wallet transaction balanceAfter is invalid.');
  }
  if (transaction.status === 'completed' && balanceAfterMinor === null) {
    errors.push('A completed Wallet transaction requires an exact balanceAfter snapshot.');
  }
  if (creditedMinor === null) errors.push('Wallet transaction creditedAmount is invalid.');
  if (appliedMinor === null) errors.push('Wallet transaction appliedToLiability is invalid.');
  if (remainingMinor === null) errors.push('Wallet transaction remainingLiability is invalid.');
  if (typeof transaction.description !== 'string') errors.push('Wallet transaction description is invalid.');
  if (!TRANSACTION_REFERENCE_TYPES.has(transaction.referenceType)) {
    errors.push('Wallet transaction reference type is invalid.');
  }
  if (typeof transaction.failureReason !== 'string') errors.push('Wallet transaction failureReason is invalid.');
  if (!isValidDateValue(transaction.createdAt)) errors.push('Wallet transaction createdAt is invalid.');
  if (hasOwn(transaction, 'updatedAt') && !isValidDateValue(transaction.updatedAt)) {
    errors.push('Wallet transaction updatedAt is invalid.');
  }
  if (
    transaction.completedAt !== null
    && transaction.completedAt !== undefined
    && !isValidDateValue(transaction.completedAt)
  ) errors.push('Wallet transaction completedAt is invalid.');

  const expectedDirection = {
    top_up: 'credit',
    order_payment: 'debit',
    return_refund: 'credit',
    reversal: 'debit',
  }[transaction.type];
  if (expectedDirection && transaction.direction !== expectedDirection) {
    errors.push('Wallet transaction type conflicts with its direction.');
  }

  if (creditedMinor !== null && appliedMinor !== null && remainingMinor !== null) {
    const hasCreditBreakdown = creditedMinor > 0 || appliedMinor > 0 || remainingMinor > 0;
    if (transaction.status !== 'completed' && hasCreditBreakdown) {
      errors.push('An incomplete Wallet transaction cannot contain a settled credit breakdown.');
    }
    if (transaction.direction === 'debit' && hasCreditBreakdown) {
      errors.push('A Wallet debit cannot contain a credit breakdown.');
    }
    if (
      transaction.status === 'completed'
      && transaction.direction === 'credit'
      && hasCreditBreakdown
      && amountMinor !== null
    ) {
      if (BigInt(creditedMinor) + BigInt(appliedMinor) !== BigInt(amountMinor)) {
        errors.push('Wallet credit allocation does not conserve the transaction amount.');
      }
      if (remainingMinor > 0 && creditedMinor > 0) {
        errors.push('Wallet credit cannot become available while a liability remains.');
      }
    }
  }

  return {
    valid: errors.length === 0,
    transaction: errors.length === 0 ? transaction : null,
    errors,
  };
};

export const inspectWalletSummaryResponse = payload => {
  const errors = [];
  if (!isPlainObject(payload) || payload.success !== true) {
    return {
      valid: false,
      wallet: null,
      transactions: [],
      errors: ['Wallet response is not an authoritative success payload.'],
    };
  }
  const wallet = payload.wallet;
  if (!isPlainObject(wallet)) {
    return { valid: false, wallet: null, transactions: [], errors: ['Wallet snapshot is missing.'] };
  }
  if (!exactObjectId(wallet._id)) errors.push('Wallet id is invalid.');
  if (!WALLET_STATUSES.has(wallet.status)) errors.push('Wallet status is invalid.');
  if (typeof wallet.lockedReason !== 'string') errors.push('Wallet lockedReason is invalid.');
  if (wallet.lockSource !== null && !WALLET_LOCK_SOURCES.has(wallet.lockSource)) {
    errors.push('Wallet lockSource is invalid.');
  }
  if (hasOwn(wallet, 'updatedAt') && !isValidDateValue(wallet.updatedAt)) {
    errors.push('Wallet updatedAt is invalid.');
  }

  if (!isPlainObject(wallet.balances)) {
    errors.push('Wallet balances are missing.');
  } else {
    const balanceKeys = Object.keys(wallet.balances);
    if (balanceKeys.some(code => !WALLET_CURRENCY_SET.has(code))) {
      errors.push('Wallet balances contain an unsupported currency.');
    }
    for (const code of SUPPORTED_CURRENCY_CODES) {
      if (!hasOwn(wallet.balances, code) || toNonNegativeMinorUnits(wallet.balances[code]) === null) {
        errors.push(`Wallet ${code} balance is invalid.`);
      }
    }
  }

  const paymentRisk = wallet.paymentRisk;
  let outstandingMinor = 0n;
  let heldMinor = 0n;
  if (!isPlainObject(paymentRisk)) {
    errors.push('Wallet paymentRisk is missing.');
  } else {
    if (typeof paymentRisk.restricted !== 'boolean') errors.push('Wallet paymentRisk.restricted is invalid.');
    if (!Number.isSafeInteger(paymentRisk.provisionalCount) || paymentRisk.provisionalCount < 0) {
      errors.push('Wallet paymentRisk.provisionalCount is invalid.');
    }
    if (typeof paymentRisk.canTopUpForSettlement !== 'boolean') {
      errors.push('Wallet paymentRisk.canTopUpForSettlement is invalid.');
    }
    if (!isPlainObject(paymentRisk.byCurrency)) {
      errors.push('Wallet paymentRisk.byCurrency is invalid.');
    } else {
      for (const [code, risk] of Object.entries(paymentRisk.byCurrency)) {
        if (!WALLET_CURRENCY_SET.has(code)) {
          errors.push(`Wallet payment risk contains unsupported currency ${code}.`);
          continue;
        }
        const inspected = inspectRiskCurrency(risk, code);
        errors.push(...inspected.errors);
        if (inspected.valid) {
          outstandingMinor += BigInt(risk.outstandingMinor);
          heldMinor += BigInt(risk.heldMinor);
        }
      }
    }
    if (
      paymentRisk.restricted === false
      && (
        paymentRisk.provisionalCount !== 0
        || outstandingMinor !== 0n
        || heldMinor !== 0n
      )
    ) errors.push('Unrestricted Wallet payment risk contains an active liability.');
    if (heldMinor > 0n && paymentRisk.provisionalCount === 0) {
      errors.push('Wallet held payment-risk money has no provisional liability count.');
    }
    if (wallet.status === 'active' && paymentRisk.restricted !== false) {
      errors.push('An active Wallet cannot report restricted payment risk.');
    }
    if (
      paymentRisk.canTopUpForSettlement === true
      && (wallet.status !== 'locked' || outstandingMinor <= 0n)
    ) errors.push('Wallet liability top-up permission is inconsistent with its lock and outstanding balance.');
  }

  if (!Array.isArray(payload.transactions) || payload.transactions.length > 100) {
    errors.push('Wallet transactions are invalid.');
  }
  const transactions = Array.isArray(payload.transactions) ? payload.transactions : [];
  const transactionIds = new Set();
  for (const transaction of transactions) {
    const inspected = inspectWalletTransaction(transaction);
    errors.push(...inspected.errors);
    if (inspected.valid) {
      if (transactionIds.has(transaction._id)) errors.push('Wallet response contains duplicate transactions.');
      transactionIds.add(transaction._id);
    }
  }

  return {
    valid: errors.length === 0,
    wallet: errors.length === 0 ? wallet : null,
    transactions: errors.length === 0 ? transactions : [],
    errors,
  };
};

export const inspectWalletTopUpCreateResponse = (payload, { amount, currency } = {}) => {
  const errors = [];
  const expectedAmountMinor = toPositiveMinorUnits(amount);
  const expectedCurrency = exactWalletCurrency(currency);
  if (!isPlainObject(payload) || payload.success !== true) {
    errors.push('Wallet top-up response is not an authoritative success payload.');
  }
  const inspectedTransaction = inspectWalletTransaction(payload?.transaction);
  errors.push(...inspectedTransaction.errors);
  const transaction = inspectedTransaction.transaction;
  const transactionId = exactObjectId(payload?.transactionId);
  const topUpId = exactObjectId(payload?.topUpId);
  if (!transactionId || !topUpId || transactionId !== topUpId || transaction?._id !== transactionId) {
    errors.push('Wallet top-up response identifiers conflict.');
  }
  if (
    expectedAmountMinor === null
    || expectedCurrency === null
    || toPositiveMinorUnits(transaction?.amount) !== expectedAmountMinor
    || transaction?.currency !== expectedCurrency
    || transaction?.type !== 'top_up'
    || transaction?.direction !== 'credit'
  ) errors.push('Wallet top-up response does not match the requested money.');

  let kind = null;
  let redirectUrl = null;
  if (typeof payload?.url === 'string' && payload.url) {
    try {
      const parsed = new URL(payload.url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('unsafe URL');
      redirectUrl = parsed.toString();
    } catch (_error) {
      errors.push('Wallet top-up checkout URL is invalid.');
    }
    if (
      payload.completed === true
      || payload.stripePaymentReceived === true
      || transaction?.status !== 'pending'
    ) {
      errors.push('Wallet top-up redirect response has an invalid transaction state.');
    }
    kind = 'redirect';
  } else if (payload?.completed === true) {
    if (transaction?.status !== 'completed') errors.push('Completed Wallet top-up response is inconsistent.');
    kind = 'completed';
  } else if (payload?.stripePaymentReceived === true) {
    if (!transactionId || transaction?.status !== 'pending') {
      errors.push('Wallet top-up payment-received response is inconsistent.');
    }
    kind = 'payment_received';
  } else {
    errors.push('Wallet top-up response has no recognized next state.');
  }

  return {
    valid: errors.length === 0,
    kind: errors.length === 0 ? kind : null,
    transaction: errors.length === 0 ? transaction : null,
    transactionId: errors.length === 0 ? transactionId : null,
    redirectUrl: errors.length === 0 ? redirectUrl : null,
    errors,
  };
};

export const inspectWalletTopUpStatusResponse = (payload, expectedTransactionId) => {
  const errors = [];
  const summary = inspectWalletSummaryResponse(payload);
  errors.push(...summary.errors);
  const expectedId = exactObjectId(expectedTransactionId);
  const transactionId = exactObjectId(payload?.transactionId);
  if (!expectedId || !transactionId || expectedId !== transactionId) {
    errors.push('Wallet top-up status identifier is invalid.');
  }
  const transaction = summary.transactions.find(row => row._id === expectedId) || null;
  if (!transaction || transaction.type !== 'top_up' || transaction.direction !== 'credit') {
    errors.push('Wallet top-up status transaction is missing.');
  }
  if (
    transaction
    && (
      payload.status !== transaction.status
      || toPositiveMinorUnits(payload.amount) !== toPositiveMinorUnits(transaction.amount)
      || payload.currency !== transaction.currency
    )
  ) errors.push('Wallet top-up status money conflicts with its transaction.');
  if (typeof payload?.webhookProcessed !== 'boolean') {
    errors.push('Wallet top-up webhook status is invalid.');
  }
  if (typeof payload?.stripePaymentReceived !== 'boolean') {
    errors.push('Wallet top-up Stripe payment status is invalid.');
  }
  if (typeof payload?.failureReason !== 'string') errors.push('Wallet top-up failureReason is invalid.');
  if (transaction?.status === 'completed') {
    const balanceMinor = toNonNegativeMinorUnits(payload.walletBalanceAfter);
    if (
      payload.webhookProcessed !== true
      || balanceMinor === null
      || balanceMinor !== toNonNegativeMinorUnits(transaction.balanceAfter)
    ) errors.push('Completed Wallet top-up balance snapshot is invalid.');
  } else if (payload?.walletBalanceAfter !== null) {
    errors.push('Incomplete Wallet top-up cannot report a completed balance.');
  }

  return {
    valid: errors.length === 0,
    status: errors.length === 0 ? transaction.status : null,
    transaction: errors.length === 0 ? transaction : null,
    wallet: errors.length === 0 ? summary.wallet : null,
    transactions: errors.length === 0 ? summary.transactions : [],
    failureReason: errors.length === 0 ? payload.failureReason : '',
    errors,
  };
};

export const findWalletTransaction = (payload, transactionId) => {
  const expectedId = exactObjectId(transactionId);
  if (!expectedId) return null;
  const root = payload?.data || payload || {};
  const direct = root?.transaction;
  const inspectedDirect = inspectWalletTransaction(direct);
  if (inspectedDirect.valid && direct._id === expectedId) return direct;
  const transactions = root?.transactions || root?.wallet?.transactions;
  if (!Array.isArray(transactions)) return null;
  return transactions.find(transaction => (
    transaction?._id === expectedId
    && inspectWalletTransaction(transaction).valid
  )) || null;
};

export const requireWalletSummaryResponse = payload => {
  const inspected = inspectWalletSummaryResponse(payload);
  if (!inspected.valid) {
    throw walletPresentationError(`Wallet response could not be verified: ${inspected.errors[0]}`);
  }
  return inspected;
};

export const shouldRetainWalletTopUpAttempt = (error) => {
  const code = String(error?.response?.data?.code || '');
  // This code is an authoritative statement that the prior Stripe/top-up
  // lifecycle is terminal and a new request key is required. Other 409s can
  // describe an in-flight recovery race and must replay the same key.
  if (code === 'WALLET_TOP_UP_RETRY_REQUIRED') return false;
  return shouldRetainIdempotencyKey(error?.response?.status)
    || [
      'PAYMENT_ATTEMPT_RECOVERY_PENDING',
      'PAYMENT_SETUP_RECOVERY_REQUIRED',
      'PAYMENT_ALREADY_SUCCEEDED',
    ].includes(code);
};
