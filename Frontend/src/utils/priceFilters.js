// Catalog thresholds only; this does not alter order or payment money.
export function readPriceRange(values) {
  const [minimum = '', maximum = ''] = values || []
  const parse = (raw, empty) => {
    const text = String(raw ?? '').trim()
    if (!text) return empty
    if (!/^(?:\d+(?:\.\d*)?|\.\d+|\d{1,3}(?:,\d{3})+(?:\.\d*)?)$/.test(text)) return NaN
    const amount = Number(text.replace(/,/g, ''))
    return Number.isFinite(amount) && amount <= Number.MAX_SAFE_INTEGER / 100 ? amount : NaN
  }
  const min = parse(minimum, 0), max = parse(maximum, null)
  const error = !Number.isFinite(min) || (max !== null && !Number.isFinite(max))
    ? 'Enter valid, non-negative prices.'
    : max !== null && min > max ? 'Minimum price cannot exceed maximum price.' : ''
  return { min, max, error }
}

export function stepPriceRange(values, field, direction) {
  const range = readPriceRange(values)
  if (range.error) return values
  const min = range.min, max = range.max
  const step = amount => Math.max(0, Math.min(Number.MAX_SAFE_INTEGER / 100, Math.round((amount + direction) * 100) / 100))
  if (field === 'min') return [String(Math.min(max ?? Infinity, step(min))), max === null ? '' : String(max)]
  if (max === null && direction < 0) return values
  return [String(min), String(Math.max(min, step(max ?? min)))]
}
