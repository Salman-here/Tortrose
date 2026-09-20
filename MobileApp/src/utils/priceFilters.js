// Filter thresholds only; order and payment money continue to use their own contracts.
export function parsePriceFilterInput(value, { minimum = false } = {}) {
  const text = String(value ?? '').trim();
  if (!text) return minimum ? 0 : null;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+|\d{1,3}(?:,\d{3})+(?:\.\d*)?)$/.test(text)) return NaN;
  const result = Number(text.replace(/,/g, ''));
  return Number.isFinite(result) && result >= 0 ? result : NaN;
}

export function priceFilterError(range) {
  if (!range || !Number.isFinite(range.min) || range.min < 0 || (range.max !== null && (!Number.isFinite(range.max) || range.max < 0))) return 'Enter valid, non-negative prices.';
  if (range.max !== null && range.min > range.max) return 'Minimum price cannot exceed maximum price.';
  return '';
}
