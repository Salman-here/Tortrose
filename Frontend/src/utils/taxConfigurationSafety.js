import { exactCurrencyCode, parseExactMoneyInput } from './sellerMoneySafety.js';

const PERCENTAGE_PATTERN = /^\d+(?:\.\d{1,6})?$/u;

export const parseTaxConfigurationValue = (type, value) => {
  if (type === 'none') return { valid: true, value: 0, error: '' };
  if (type === 'fixed') {
    const parsed = parseExactMoneyInput(value);
    return parsed
      ? { valid: true, value: parsed.amount, error: '' }
      : { valid: false, value: null, error: 'Enter a non-negative fixed amount with no more than 2 decimal places.' };
  }
  if (type === 'percentage') {
    if (value === null || value === undefined || typeof value === 'boolean') {
      return { valid: false, value: null, error: 'Enter a percentage from 0 to 100.' };
    }
    const text = String(value).trim();
    if (!PERCENTAGE_PATTERN.test(text)) {
      return { valid: false, value: null, error: 'Use a percentage from 0 to 100 with no more than 6 decimal places.' };
    }
    const numeric = Number(text);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
      return { valid: false, value: null, error: 'Percentage must be between 0 and 100.' };
    }
    return { valid: true, value: numeric, error: '' };
  }
  return { valid: false, value: null, error: 'Choose a valid tax type.' };
};

export const taxConfigurationResponseIsValid = config => {
  if (!config || typeof config !== 'object' || !['none', 'percentage', 'fixed'].includes(config.type)) return false;
  const parsed = parseTaxConfigurationValue(config.type, config.value);
  if (!parsed.valid || parsed.value !== config.value) return false;
  if (config.type === 'fixed') return exactCurrencyCode(config.currency) !== null;
  return config.currency === 'USD';
};
