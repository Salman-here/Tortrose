const PRICE_FILTER_MAX = Object.freeze({
  USD: 5000,
  PKR: 1500000,
  EUR: 5000,
  GBP: 5000,
})

export const getPriceFilterMax = (currency) => PRICE_FILTER_MAX[currency] || PRICE_FILTER_MAX.USD

export const filterValues = value => Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []
export const filterValueSelected = (values, value) => filterValues(values).some(item => String(item).toLowerCase() === String(value).toLowerCase())
export const toggleFilterValue = (values, value) => filterValueSelected(values, value)
  ? filterValues(values).filter(item => String(item).toLowerCase() !== String(value).toLowerCase())
  : [...filterValues(values), value]

export const parseQueryParams = (search, activeCurrency) => {
  const params = new URLSearchParams(search)
  const queryCurrency = String(params.get('currency') || '').trim().toUpperCase()
  const priceFilterMax = getPriceFilterMax(activeCurrency)
  const savedRangeBelongsToCurrency = !queryCurrency || queryCurrency === activeCurrency
  const rawRange = params.get('priceRange')?.split(',')
  const validRange = rawRange?.length === 2 && rawRange.every(v => Number.isFinite(Number(v)) && Number(v) >= 0)
    && Number(rawRange[0]) <= Number(rawRange[1])
  return {
    categories: params.getAll('categories'),
    brands: params.getAll('brands'),
    search: params.get('search') || '',
    priceRange: validRange && savedRangeBelongsToCurrency
      ? rawRange
      : ['0', String(priceFilterMax)]
  }
}
