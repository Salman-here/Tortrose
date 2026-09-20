import { readPriceRange } from './priceFilters.js'

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
  const savedRangeBelongsToCurrency = !queryCurrency || queryCurrency === activeCurrency
  const rawRange = params.get('priceRange')?.split(',')
  const validRange = rawRange?.length === 2 && !readPriceRange(rawRange).error
  return {
    categories: params.getAll('categories'),
    brands: [...new Set(params.getAll('brandStores').filter(id => /^[a-f\d]{24}$/i.test(id)).map(id => id.toLowerCase()))],
    search: params.get('search') || '',
    priceRange: validRange && savedRangeBelongsToCurrency
      ? rawRange
      : ['0', '']
  }
}
