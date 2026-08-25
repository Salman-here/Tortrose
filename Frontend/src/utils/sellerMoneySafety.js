const SUPPORTED_CURRENCIES = new Set(['USD', 'PKR', 'EUR', 'GBP']);
const PLAIN_MONEY_PATTERN = /^\d+(?:\.\d{1,2})?$/;

export const exactCurrencyCode = (value) => (
  typeof value === 'string'
  && value === value.trim().toUpperCase()
  && SUPPORTED_CURRENCIES.has(value)
    ? value
    : null
);

export const parseExactMoneyInput = (value, { allowZero = true } = {}) => {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const text = String(value).trim();
  if (!text || text.length > 64 || !PLAIN_MONEY_PATTERN.test(text)) return null;

  const [wholeText, fractionText = ''] = text.split('.');
  try {
    const minorUnits = (BigInt(wholeText) * 100n) + BigInt(fractionText.padEnd(2, '0'));
    if (minorUnits > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    if (!allowZero && minorUnits === 0n) return null;
    return {
      amount: Number(minorUnits) / 100,
      minorUnits: Number(minorUnits),
    };
  } catch {
    return null;
  }
};

export const isExactNonNegativeJsonMoney = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
  const parsed = parseExactMoneyInput(value);
  return parsed !== null && parsed.amount === value;
};

export const isExactPositiveJsonMoney = (value) => (
  isExactNonNegativeJsonMoney(value) && value > 0
);

export const validateShippingCostInput = (type, rawValue, isActive) => {
  if (type === 'free') {
    const parsed = parseExactMoneyInput(rawValue);
    return parsed?.minorUnits === 0
      ? { valid: true, amount: 0, error: '' }
      : { valid: false, amount: null, error: 'Free shipping must remain 0.00.' };
  }

  const text = String(rawValue ?? '').trim();
  if (!text && !isActive) return { valid: true, amount: 0, error: '' };
  const parsed = parseExactMoneyInput(text);
  if (!parsed) {
    return { valid: false, amount: null, error: 'Enter a non-negative amount with no more than 2 decimal places.' };
  }
  if (isActive && parsed.minorUnits <= 0) {
    return { valid: false, amount: null, error: 'Paid shipping must cost at least 0.01.' };
  }
  return { valid: true, amount: parsed.amount, error: '' };
};

export const validateDeliveryDaysInput = (rawValue) => {
  const text = String(rawValue ?? '').trim();
  if (!/^\d+$/.test(text)) {
    return { valid: false, days: null, error: 'Enter a whole number of delivery days.' };
  }
  const days = Number(text);
  if (!Number.isSafeInteger(days) || days < 1) {
    return { valid: false, days: null, error: 'Delivery days must be at least 1.' };
  }
  return { valid: true, days, error: '' };
};

export const withdrawalNeedsLiveFx = (requestedCurrency, payoutCurrency) => (
  exactCurrencyCode(requestedCurrency) !== 'USD'
  || exactCurrencyCode(payoutCurrency) !== 'USD'
);

export const shouldRetainWithdrawalAttempt = (error) => (
  error?.response === undefined || error?.response === null
);

const validMoneyPair = (amount, currency) => (
  isExactPositiveJsonMoney(amount) && exactCurrencyCode(currency)
);

export const selectWithdrawalHistoryMoney = (request = {}) => {
  const rawVersion = request?.payoutWorkflow?.version ?? request?.payoutWorkflowVersion ?? 0;
  if (!Number.isSafeInteger(rawVersion) || rawVersion < 0) {
    return { requested: null, payout: null, showPayout: false, status: 'unavailable' };
  }

  const requestedCurrency = exactCurrencyCode(request.requestedCurrency);
  const payoutCurrency = exactCurrencyCode(request.payoutCurrency);
  const requestedValid = validMoneyPair(request.requestedAmount, requestedCurrency);
  const payoutValid = validMoneyPair(request.payoutAmount, payoutCurrency);

  if (rawVersion >= 1) {
    if (!requestedValid || !payoutValid) {
      return { requested: null, payout: null, showPayout: false, status: 'unavailable' };
    }
    const requested = { amount: request.requestedAmount, currency: requestedCurrency };
    const payout = { amount: request.payoutAmount, currency: payoutCurrency };
    return {
      requested,
      payout,
      showPayout: requested.currency !== payout.currency || requested.amount !== payout.amount,
      status: 'complete',
    };
  }

  const legacyCurrency = exactCurrencyCode(request.currency);
  const legacyRequested = requestedValid
    ? { amount: request.requestedAmount, currency: requestedCurrency }
    : (validMoneyPair(request.amount, legacyCurrency)
      ? { amount: request.amount, currency: legacyCurrency }
      : null);
  if (!legacyRequested) {
    return { requested: null, payout: null, showPayout: false, status: 'unavailable' };
  }

  const payout = payoutValid
    ? { amount: request.payoutAmount, currency: payoutCurrency }
    : null;
  return {
    requested: legacyRequested,
    payout,
    showPayout: Boolean(payout) && (
      legacyRequested.currency !== payout.currency
      || legacyRequested.amount !== payout.amount
    ),
    status: payout ? 'complete' : 'legacy',
  };
};
