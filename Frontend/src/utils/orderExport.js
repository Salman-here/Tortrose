import { currencyCodeIsSupported } from './currencySafety.js';

const EXPORT_FORMATS = new Set(['csv', 'pdf', 'excel']);

export const buildOrderExportQuery = (serializedFilters, format, currency) => {
  const normalizedFormat = String(format || '').trim().toLowerCase();
  const normalizedCurrency = String(currency || '').trim().toUpperCase();
  if (!EXPORT_FORMATS.has(normalizedFormat)) throw new Error('Choose a supported export format.');
  if (!currencyCodeIsSupported(normalizedCurrency)) throw new Error('Choose a supported export currency.');
  const params = new URLSearchParams(serializedFilters || '');
  params.set('format', normalizedFormat);
  params.set('currency', normalizedCurrency);
  return params.toString();
};
export const orderExportErrorMessage = async (data, fallback = 'Failed to export orders') => {
  if (data && typeof data === 'object' && typeof data.msg === 'string' && data.msg.trim()) {
    return data.msg.trim();
  }

  let text = '';
  try {
    if (typeof data === 'string') text = data;
    else if (data && typeof data.text === 'function') text = await data.text();
  } catch (_) {
    return fallback;
  }
  const trimmed = String(text || '').trim();
  if (!trimmed) return fallback;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.msg === 'string' && parsed.msg.trim()) return parsed.msg.trim();
  } catch (_) {
    // A short plain-text API error is safe to present; HTML proxy responses are not.
  }
  return trimmed.length <= 240 && !/<(?:html|body|script)[\s>]/i.test(trimmed)
    ? trimmed
    : fallback;
};
