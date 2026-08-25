import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from "framer-motion"
import axios from 'axios'
import Loader from './common/Loader'
import ProductCard from './common/ProductCard'
import StoreSearch from './common/StoreSearch'
import { PackageX, RefreshCw, Filter, X, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import PersonalizedSections from './common/PersonalizedSections'
import CurrencySelector from './common/CurrencySelector'
import { useCurrency } from '../contexts/CurrencyContext'
import { useBuyerLocation } from '../contexts/BuyerLocationContext'
import SEOHead from './common/SEOHead'
import { PRESET_CATEGORIES, isPresetCategory } from '../utils/categories'
import { trackSearch } from '../utils/tiktokPixel'
import BuyerLocationSelector from './common/BuyerLocationSelector'

const PRODUCTS_PER_PAGE = 24
const PRODUCTS_CACHE_KEY = 'rozare:last-products-response'
const DEFAULT_OTHER_BRANDS_FILTER = '__other_brands__'
const PRICE_FILTER_MAX = Object.freeze({
  USD: 5000,
  PKR: 1500000,
  EUR: 5000,
  GBP: 5000,
})

const getPriceFilterMax = (currency) => PRICE_FILTER_MAX[currency] || PRICE_FILTER_MAX.USD

const parseQueryParams = (search, activeCurrency) => {
  const params = new URLSearchParams(search)
  const queryCurrency = String(params.get('currency') || '').trim().toUpperCase()
  const priceFilterMax = getPriceFilterMax(activeCurrency)
  const savedRangeBelongsToCurrency = !queryCurrency || queryCurrency === activeCurrency
  return {
    categories: params.getAll('categories'),
    brands: params.getAll('brands'),
    search: params.get('search') || '',
    priceRange: params.get('priceRange') && savedRangeBelongsToCurrency
      ? params.get('priceRange').split(',')
      : ['0', String(priceFilterMax)]
  }
}

const readProductsCache = () => {
  try {
    const cached = sessionStorage.getItem(PRODUCTS_CACHE_KEY)
    return cached ? JSON.parse(cached) : null
  } catch (_) {
    return null
  } 
}

const writeProductsCache = (data) => {
  try {
    sessionStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify(data))
  } catch (_) {}
}

function Products() {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [serviceNotice, setServiceNotice] = useState(null)
  const [isFilterOpen, setIsFilterOpen] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [totalProducts, setTotalProducts] = useState(0)
  const [sortBy, setSortBy] = useState('relevance')
  const [sortOrder, setSortOrder] = useState('desc')

  const priceRangeRef = useRef(null)
  const navigate = useNavigate()
  const location = useLocation()
  const { currency, getCurrencySymbol } = useCurrency()
  const { appendLocationParams, locationQueryString } = useBuyerLocation()
  const priceFilterMax = getPriceFilterMax(currency)

  const { register, reset, watch, setValue } = useForm({
    defaultValues: { categories: [], brands: [], priceRange: ['0', String(priceFilterMax)] }
  })

  const filters = watch()
  const [categories, setCategories] = useState([])
  const [search, setSearch] = useState("")
  const [brands, setBrands] = useState([])
  const [otherBrandsCount, setOtherBrandsCount] = useState(0)
  const [otherBrandsValue, setOtherBrandsValue] = useState(DEFAULT_OTHER_BRANDS_FILTER)
  const filtersRef = useRef(filters)
  const searchRef = useRef(search)
  const currentPageRef = useRef(currentPage)
  const sortByRef = useRef(sortBy)
  const sortOrderRef = useRef(sortOrder)
  const currencyRef = useRef(currency)
  const fetchProductsRef = useRef(null)
  const initialFetchDone = useRef(false)

  const serializeFilters = useCallback(() => {
    const f = filtersRef.current
    let params = new URLSearchParams()
    Object.keys(f || {}).forEach((key) => {
      const value = f[key]
      if (Array.isArray(value)) {
        if (key === 'priceRange') {
          const min = String(value[0] ?? '0')
          const max = String(value[1] ?? priceFilterMax)
          if (min !== '0' || max !== String(priceFilterMax)) params.append(key, `${min},${max}`)
        }
        else value.forEach(item => params.append(key, item))
      }
    })
    if (searchRef.current !== '') params.append('search', searchRef.current)
    params.append('page', currentPageRef.current)
    params.append('limit', PRODUCTS_PER_PAGE)
    params.append('sortBy', sortByRef.current)
    params.append('sortOrder', sortOrderRef.current)
    params.append('currency', currency)
    appendLocationParams(params)
    return params.toString()
  }, [appendLocationParams, currency, priceFilterMax])

  const fetchProducts = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const query = serializeFilters()
      navigate(query ? `${location.pathname}?${query}` : location.pathname, { replace: true })
      const res = await axios.get(`${import.meta.env.VITE_API_URL}api/products/get-products?${query}`)
      setProducts(res.data.products || [])
      setTotalPages(res.data.pagination?.totalPages || 1)
      setTotalProducts(res.data.pagination?.totalProducts || 0)
      setServiceNotice(null)
      writeProductsCache(res.data)
      if (searchRef.current?.trim()) {
        trackSearch({
          searchString: searchRef.current.trim(),
          products: res.data.products || [],
        })
      }
    } catch (err) {
      console.log(err)
      const cached = readProductsCache()
      if (cached?.products?.length) {
        setProducts(cached.products || [])
        setTotalPages(cached.pagination?.totalPages || 1)
        setTotalProducts(cached.pagination?.totalProducts || cached.products.length || 0)
        setError(null)
        setServiceNotice('Connection is recovering. Showing the latest saved products for now.')
      } else {
        setError(err)
      }
    }
    finally { setLoading(false) }
  }, [serializeFilters, navigate, location.pathname])
  fetchProductsRef.current = fetchProducts

  const fetchFilters = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      appendLocationParams(params)
      const suffix = params.toString()
      const res = await axios.get(`${import.meta.env.VITE_API_URL}api/products/get-filters${suffix ? `?${suffix}` : ''}`)
      setCategories(res.data.categories || [])
      setBrands(res.data.brands || [])
      setOtherBrandsCount(res.data.otherBrandsCount || 0)
      setOtherBrandsValue(res.data.brandFilter?.otherValue || DEFAULT_OTHER_BRANDS_FILTER)
    } catch (error) { setCategories([]); setBrands([]); setOtherBrandsCount(0) }
  }, [appendLocationParams])

  useEffect(() => {
    searchRef.current = search
    if (initialFetchDone.current && search === '') fetchProductsRef.current?.()
  }, [search])

  const serializedFilters = JSON.stringify(filters || {})
  useEffect(() => {
    const prev = JSON.stringify(filtersRef.current)
    const nextFilters = JSON.parse(serializedFilters)
    filtersRef.current = nextFilters
    if (initialFetchDone.current && prev !== serializedFilters) {
      setCurrentPage(1) // Reset to page 1 when filters change
      fetchProductsRef.current?.()
    }
  }, [serializedFilters])
  
  // Fetch products when page, sort, or sortOrder changes
  useEffect(() => {
    currentPageRef.current = currentPage
    sortByRef.current = sortBy
    sortOrderRef.current = sortOrder
    if (initialFetchDone.current) {
      fetchProductsRef.current?.()
    }
  }, [currentPage, sortBy, sortOrder])

  useEffect(() => {
    fetchFilters()
    const parsedFilters = parseQueryParams(location.search, currency)
    const params = new URLSearchParams(location.search)
    const parsedPage = Math.max(1, parseInt(params.get('page'), 10) || 1)
    const parsedSortBy = params.get('sortBy') || 'relevance'
    const parsedSortOrder = params.get('sortOrder') || 'desc'
    filtersRef.current = parsedFilters
    searchRef.current = parsedFilters.search || ''
    currentPageRef.current = parsedPage
    sortByRef.current = parsedSortBy
    sortOrderRef.current = parsedSortOrder
    reset(parsedFilters)
    setSearch(parsedFilters.search || '')
    setCurrentPage(parsedPage)
    setSortBy(parsedSortBy)
    setSortOrder(parsedSortOrder)
    initialFetchDone.current = true
    fetchProducts()
    // Initial URL hydration is deliberately mount-only. Location, buyer
    // location, and currency changes have dedicated synchronized effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!initialFetchDone.current) return
    setCurrentPage(1)
    currentPageRef.current = 1
    fetchFilters()
    fetchProducts()
    // Fetch callbacks also change with currency; the currency effect below
    // owns that transition so a location update is not double-requested.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationQueryString])

  useEffect(() => {
    if (!initialFetchDone.current || currencyRef.current === currency) return
    currencyRef.current = currency
    const nextFilters = {
      ...filtersRef.current,
      priceRange: ['0', String(priceFilterMax)],
    }
    filtersRef.current = nextFilters
    setValue('priceRange', nextFilters.priceRange, { shouldDirty: false })
    if (priceRangeRef.current) priceRangeRef.current.value = 0
    setCurrentPage(1)
    currentPageRef.current = 1
    fetchProducts()
  }, [currency, fetchProducts, priceFilterMax, setValue])

  const goToPage = (page) => {
    setCurrentPage(page)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const pageNumbers = useMemo(() => {
    const pages = []
    const maxVisible = 5
    let start = Math.max(1, currentPage - Math.floor(maxVisible / 2))
    let end = Math.min(totalPages, start + maxVisible - 1)
    if (end - start + 1 < maxVisible) start = Math.max(1, end - maxVisible + 1)
    for (let i = start; i <= end; i++) pages.push(i)
    return pages
  }, [currentPage, totalPages])
  
  const handleSortChange = (newSort) => {
    const [sortField, order] = newSort.split('-')
    setSortBy(sortField)
    setSortOrder(order || 'desc')
    setCurrentPage(1) // Reset to page 1 when sorting changes
  }

  if (error) return (
    <div className='w-full h flex justify-center items-center flex-col gap-4'>
      <h1 className='text-2xl font-bold'>Error Occurred</h1>
      <p className='text-xl font-semibold' style={{ color: 'hsl(var(--primary))' }}>{error.message}</p>
      <button
        onClick={() => window.location.reload()}
        className='flex gap-3 px-4 py-2 rounded-xl font-semibold cursor-pointer glow-soft transition-transform active:scale-95 hover:scale-105'
        style={{ background: 'var(--logo-gradient)', boxShadow: 'var(--logo-glow)', color: 'white' }}>
        Reload <RefreshCw />
      </button>
    </div>
  )

  const filterCategories = filters.categories || []
  const filterBrands = filters.brands || []
  const filterPriceRange = filters.priceRange || ['0', String(priceFilterMax)]

  const activeFilterCount = filterCategories.length + filterBrands.length +
    (filterPriceRange[0] !== '0' || String(filterPriceRange[1]) !== String(priceFilterMax) ? 1 : 0)

  const FilterSidebarContent = ({ onClose }) => (
    <div className='flex flex-col gap-6 p-6'>
      <div className='flex justify-between items-center'>
        <div className='flex items-center gap-2'>
          <div className='glass-inner p-1.5 rounded-xl'>
            <Filter size={16} style={{ color: 'hsl(var(--primary))' }} />
          </div>
          <h1 className='text-lg font-bold'>Filters</h1>
          {activeFilterCount > 0 && (
            <span className='tag-pill text-xs font-bold'>{activeFilterCount}</span>
          )}
        </div>
        {onClose && (
          <button onClick={onClose} className='p-1.5 rounded-xl glass-button'>
            <X size={20} />
          </button>
        )}
      </div>

      <BuyerLocationSelector compact />

      {/* Search */}
      <div>
        <label className='block text-xs font-semibold uppercase tracking-wider mb-2' style={{ color: 'hsl(var(--muted-foreground))' }}>Search</label>
        <form onSubmit={(e) => { e.preventDefault(); fetchProducts(); onClose && onClose(); }}>
          <input className='glass-input' placeholder='Search products...' type='text' value={search} onChange={(e) => setSearch(e.target.value)} />
        </form>
      </div>

      {/* Sort By */}
      <div>
        <label className='block text-xs font-semibold uppercase tracking-wider mb-2' style={{ color: 'hsl(var(--muted-foreground))' }}>Sort By</label>
        <select
          value={`${sortBy}-${sortOrder}`}
          onChange={(e) => { handleSortChange(e.target.value); onClose && onClose(); }}
          className='glass-input text-sm font-medium w-full cursor-pointer'
        >
          <option value="relevance-desc">✨ Recommended</option>
          <option value="price-asc">💰 Price: Low to High</option>
          <option value="price-desc">💎 Price: High to Low</option>
          <option value="rating-desc">⭐ Highest Rated</option>
          <option value="newest-desc">🆕 Newest First</option>
          <option value="popular-desc">🔥 Most Popular</option>
          <option value="sales-desc">🏆 Best Selling</option>
        </select>
      </div>

      {/* Categories — fixed preset list + Other */}
      <div>
        <label className='block text-xs font-semibold uppercase tracking-wider mb-3' style={{ color: 'hsl(var(--muted-foreground))' }}>Categories</label>
        {(() => {
          const otherCategories = (categories || []).filter(c => !isPresetCategory(c))
          const isPresetSelected = (c) => filterCategories.some(s => s.toLowerCase() === c.toLowerCase())
          const isOtherSelected = otherCategories.length > 0 && otherCategories.every(c => filterCategories.includes(c))
          const togglePreset = (c) => {
            const exists = isPresetSelected(c)
            const next = exists
              ? filterCategories.filter(s => s.toLowerCase() !== c.toLowerCase())
              : [...filterCategories, c]
            setValue('categories', next, { shouldDirty: true })
          }
          const toggleOther = () => {
            const without = filterCategories.filter(c => isPresetCategory(c))
            const next = isOtherSelected ? without : [...without, ...otherCategories]
            setValue('categories', next, { shouldDirty: true })
          }
          return (
            <div className='flex flex-col gap-1'>
              {PRESET_CATEGORIES.map(category => (
                <label key={category} className='glass-checkbox-label flex items-center gap-3 cursor-pointer py-2 px-3 rounded-xl transition-all hover:bg-white/10'>
                  <span className='glass-checkbox-box relative w-5 h-5 rounded-lg border border-white/25 bg-white/8 backdrop-blur-sm flex items-center justify-center shrink-0 transition-all'>
                    <input type='checkbox' checked={isPresetSelected(category)} onChange={() => togglePreset(category)}
                      className='absolute inset-0 opacity-0 cursor-pointer peer' />
                    <svg className='w-3 h-3 hidden peer-checked:block' style={{ color: 'hsl(var(--primary))' }} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="2 6 5 9 10 3" />
                    </svg>
                  </span>
                  <span className='text-sm font-medium'>{category}</span>
                </label>
              ))}
              {otherCategories.length > 0 && (
                <label className='glass-checkbox-label flex items-center gap-3 cursor-pointer py-2 px-3 rounded-xl transition-all hover:bg-white/10'>
                  <span className='glass-checkbox-box relative w-5 h-5 rounded-lg border border-white/25 bg-white/8 backdrop-blur-sm flex items-center justify-center shrink-0 transition-all'>
                    <input type='checkbox' checked={isOtherSelected} onChange={toggleOther}
                      className='absolute inset-0 opacity-0 cursor-pointer peer' />
                    <svg className='w-3 h-3 hidden peer-checked:block' style={{ color: 'hsl(var(--primary))' }} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="2 6 5 9 10 3" />
                    </svg>
                  </span>
                  <span className='text-sm font-medium'>Other</span>
                  <span className='text-[10px] ml-auto opacity-70'>{otherCategories.length}</span>
                </label>
              )}
            </div>
          )
        })()}
      </div>

      {/* Brands */}
      <div>
        <label className='block text-xs font-semibold uppercase tracking-wider mb-3' style={{ color: 'hsl(var(--muted-foreground))' }}>Brands</label>
        {(!brands || brands.length === 0) && !otherBrandsCount
          ? <p className='text-sm italic' style={{ color: 'hsl(var(--muted-foreground))' }}>No brands available</p>
          : <div className='flex flex-col gap-1'>
            {brands.map(brand => (
              <label key={brand} className='glass-checkbox-label flex items-center gap-3 cursor-pointer py-2 px-3 rounded-xl transition-all hover:bg-white/10'>
                <span className='glass-checkbox-box relative w-5 h-5 rounded-lg border border-white/25 bg-white/8 backdrop-blur-sm flex items-center justify-center shrink-0 transition-all'>
                  <input type='checkbox' value={brand} {...register('brands')}
                    className='absolute inset-0 opacity-0 cursor-pointer peer' />
                  <svg className='w-3 h-3 hidden peer-checked:block' style={{ color: 'hsl(200, 80%, 55%)' }} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="2 6 5 9 10 3" />
                  </svg>
                </span>
                <span className='text-sm font-medium'>{brand}</span>
              </label>
            ))}
            {otherBrandsCount > 0 && (
              <label className='glass-checkbox-label flex items-center gap-3 cursor-pointer py-2 px-3 rounded-xl transition-all hover:bg-white/10'>
                <span className='glass-checkbox-box relative w-5 h-5 rounded-lg border border-white/25 bg-white/8 backdrop-blur-sm flex items-center justify-center shrink-0 transition-all'>
                  <input type='checkbox' value={otherBrandsValue} {...register('brands')}
                    className='absolute inset-0 opacity-0 cursor-pointer peer' />
                  <svg className='w-3 h-3 hidden peer-checked:block' style={{ color: 'hsl(200, 80%, 55%)' }} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="2 6 5 9 10 3" />
                  </svg>
                </span>
                <span className='text-sm font-medium'>Other brands</span>
                <span className='text-[10px] ml-auto opacity-70'>{otherBrandsCount}</span>
              </label>
            )}
          </div>
        }
      </div>

      {/* Price Range */}
      <div>
        <label className='block text-xs font-semibold uppercase tracking-wider mb-3' style={{ color: 'hsl(var(--muted-foreground))' }}>Price Range</label>
        <input type='range' min={0} max={priceFilterMax} defaultValue={0}
          {...register('priceRange')} ref={priceRangeRef}
          onChange={(e) => setValue('priceRange', [e.target.value, String(priceFilterMax)])}
          className='w-full h-2 rounded-full appearance-none cursor-pointer accent-indigo-600'
          style={{ background: 'rgba(255,255,255,0.15)' }}
        />
        <div className='flex justify-between mt-2'>
          <span className='tag-pill text-xs font-semibold'>{getCurrencySymbol()}{filterPriceRange[0]} {currency}</span>
          <span className='tag-pill text-xs font-semibold'>{getCurrencySymbol()}{filterPriceRange[1]} {currency}</span>
        </div>
      </div>

      {/* Active Filters */}
      {activeFilterCount > 0 && (
        <div className='flex flex-wrap gap-2'>
          {filterCategories.map(c => (
            <span key={c} className='tag-pill text-xs font-medium'>{c}</span>
          ))}
          {filterBrands.map(b => (
            <span key={b} className='tag-pill text-xs font-medium' style={{ background: 'rgba(56, 189, 248, 0.1)', color: 'hsl(200, 80%, 50%)' }}>{b === otherBrandsValue ? 'Other brands' : b}</span>
          ))}
        </div>
      )}

      {/* Reset Button */}
      <button
        onClick={() => {
          reset({ categories: [], brands: [], search: '', priceRange: ['0', String(priceFilterMax)] })
          setSearch('')
          setCurrentPage(1)
          if (priceRangeRef.current) priceRangeRef.current.value = 0
        }}
        className='w-full py-2.5 rounded-xl glass-button font-semibold text-sm transition-transform active:scale-[0.97] hover:scale-[1.02]' style={{ color: 'hsl(var(--primary))' }}>
        Reset All Filters
      </button>
    </div>
  )

  const isProductsRoute = location.pathname === '/products'
  const seoTitle = isProductsRoute ? 'All Products - Browse the Rozare Catalog' : null
  const seoCanonical = isProductsRoute ? '/products' : '/'
  const seoDescription = isProductsRoute
    ? 'Browse the Rozare product catalog: electronics, fashion, home decor, beauty, accessories and more from independent sellers and brands.'
    : 'Shop products from independent sellers and brands on Rozare. Discover electronics, fashion, home decor, beauty and more with secure checkout, coupons, wishlists, and seller-managed shipping.'
  const collectionUrl = `https://rozare.com${isProductsRoute ? '/products' : '/'}`

  return (
    <div className='relative flex flex-col lg:flex-row min-h-screen'>
      <SEOHead
        title={seoTitle}
        description={seoDescription}
        canonical={seoCanonical}
        keywords="shop online, buy products online, online shopping website, rozare products, all products, product catalog, trending products, new arrivals, independent sellers, brands, affordable shopping, discount shopping, coupons, electronics store, fashion store, home decor shop, beauty products, jewelry store, shoes online, clothing online, accessories, gadgets, gifts online, promotional offers"
        jsonLd={[
          ...(!isProductsRoute ? [{
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: 'Rozare',
            alternateName: 'Rozare Marketplace',
            url: 'https://rozare.com',
            description: 'Rozare is an AI-powered marketplace where shoppers discover products from independent sellers and brands.',
            potentialAction: {
              '@type': 'SearchAction',
              target: {
                '@type': 'EntryPoint',
                urlTemplate: 'https://rozare.com/?search={search_term_string}',
              },
              'query-input': 'required name=search_term_string',
            },
          }] : []),
          {
            '@context': 'https://schema.org',
            '@type': 'CollectionPage',
            name: isProductsRoute ? 'All Products - Rozare' : 'Rozare Marketplace',
            description: isProductsRoute
              ? 'Complete catalog of products available on Rozare marketplace.'
              : 'Browse and shop products available on Rozare marketplace.',
            url: collectionUrl,
            isPartOf: { '@type': 'WebSite', name: 'Rozare', url: 'https://rozare.com' },
          },
          ...(isProductsRoute ? [{
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
              { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://rozare.com/' },
              { '@type': 'ListItem', position: 2, name: 'All Products', item: 'https://rozare.com/products' },
            ],
          }] : []),
        ]}
      />
      {/* Mobile Filter Toggle (bottom-LEFT to avoid overlap with chat FAB) */}
      <div className='lg:hidden fixed bottom-5 left-4 z-40'>
        <button
          onClick={() => setIsFilterOpen(true)}
          className='pl-4 pr-5 py-3 rounded-full shadow-xl flex items-center gap-2 font-semibold text-sm glow-soft transition-transform active:scale-95 hover:scale-105'
          style={{ background: 'var(--logo-gradient)', color: 'white', boxShadow: 'var(--logo-glow)' }}>
          <Filter size={18} />
          Filters {activeFilterCount > 0 && `(${activeFilterCount})`}
        </button>
      </div>

      {/* Mobile Filter Drawer — floating glass panel that sits BELOW the navbar */}
      <AnimatePresence>
        {isFilterOpen && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[40] lg:hidden"
              onClick={() => setIsFilterOpen(false)} />
            <motion.aside
              initial={{ x: '-110%', opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: '-110%', opacity: 0 }}
              transition={{ type: 'spring', stiffness: 320, damping: 34 }}
              className='fixed left-3 sm:left-4 w-[86vw] max-w-[340px] glass-panel-strong z-[45] overflow-y-auto lg:hidden flex flex-col filter-sb'
              style={{
                top: 'calc(90px + env(safe-area-inset-top))',
                maxHeight: 'calc(100dvh - 110px - env(safe-area-inset-top) - env(safe-area-inset-bottom))',
                borderRadius: '24px',
                boxShadow: '0 20px 50px -12px rgba(0,0,0,0.45)',
              }}>
              <FilterSidebarContent onClose={() => setIsFilterOpen(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>


      {/* Desktop Filter Sidebar */}
      <aside className='hidden lg:block m-5 glass-panel w-72 shrink-0 self-start sticky top-24 overflow-y-auto max-h-[calc(100vh-7rem)] filter-sb'>
        <FilterSidebarContent onClose={null} />
      </aside>

      {/* Product Grid */}
      <main className='min-w-0 flex-1 p-4 lg:p-6'>
        {/* Personalized Sections */}
        <PersonalizedSections />

        {serviceNotice && (
          <div
            className='mt-6 rounded-2xl px-4 py-3 text-sm font-medium'
            style={{
              background: 'rgba(14,165,233,0.10)',
              border: '1px solid rgba(14,165,233,0.22)',
              color: 'hsl(var(--foreground))',
            }}
          >
            {serviceNotice}
          </div>
        )}

        <div className='mb-6 mt-8 flex flex-col gap-4'>
          {/* Product search */}
          <form
            onSubmit={(e) => { e.preventDefault(); fetchProducts(); }}
            className='relative w-full'
          >
            <Search size={18} className='absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none' style={{ color: 'hsl(var(--muted-foreground))' }} />
            <input
              type='text'
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder='Search products by name, brand, or category…'
              className='w-full pl-11 pr-28 py-3 rounded-2xl text-sm outline-none transition-all focus:ring-2'
              style={{
                background: 'var(--glass-bg-strong)',
                border: '1px solid var(--glass-border)',
                color: 'hsl(var(--foreground))',
                boxShadow: 'var(--glass-shadow-soft)',
                '--tw-ring-color': 'rgba(14,165,233,0.35)',
              }}
            />
            {search && (
              <button type='button' onClick={() => { setSearch(''); }}
                className='absolute right-24 top-1/2 -translate-y-1/2 p-1 rounded-full hover:bg-white/10'
                aria-label='Clear search'>
                <X size={16} style={{ color: 'hsl(var(--muted-foreground))' }} />
              </button>
            )}
            <button
              type='submit'
              className='absolute right-2 top-1/2 -translate-y-1/2 px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold'
              style={{ background: 'var(--logo-gradient)', color: 'white', boxShadow: 'var(--logo-glow)' }}
            >
              Search
            </button>
          </form>

          <StoreSearch />
          <div className='flex flex-col sm:flex-row justify-between items-center gap-3'>
            <div className='flex items-center gap-3'>
              <h1 className='text-2xl lg:text-3xl font-extrabold tracking-tight'>All Products</h1>
              <Link to='/stores' className='tag-pill text-sm font-medium flex items-center gap-1'>
                Browse Stores →
              </Link>
            </div>
            <div className='flex items-center gap-3'>
              <span className='tag-pill text-sm font-medium'>
                {totalProducts} {totalProducts === 1 ? 'product' : 'products'}
              </span>
              <CurrencySelector />
            </div>
          </div>
        </div>

        {loading ? (
          <div className='flex justify-center items-center h-64'><Loader /></div>
        ) : (
          <>
            {products.length === 0 ? (
              <div className='flex flex-col items-center justify-center h-64'>
                <div className='glass-inner p-6 rounded-2xl mb-4'>
                  <PackageX size={48} strokeWidth={1.5} style={{ color: 'hsl(var(--muted-foreground))' }} />
                </div>
                <p className='text-lg font-semibold'>No products found</p>
                <p className='text-sm mt-1' style={{ color: 'hsl(var(--muted-foreground))' }}>Try adjusting your filters</p>
              </div>
            ) : (
              <>
                <div className='grid grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(180px,1fr))] xl:grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-2.5 sm:gap-3 lg:gap-4 items-start'>
                  {products.map((prod, idx) => (
                    <div key={prod._id} className='mx-auto w-full max-w-[220px] min-w-0 xl:max-w-[232px]'>
                      <ProductCard idx={idx} {...prod} />
                    </div>
                  ))}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className='flex items-center justify-center gap-2 mt-10 mb-6 flex-wrap'>
                    <button
                      onClick={() => goToPage(currentPage - 1)}
                      disabled={currentPage === 1}
                      className='p-2 rounded-xl glass-button disabled:opacity-30 disabled:cursor-not-allowed transition-transform active:scale-90 hover:scale-105'
                    >
                      <ChevronLeft size={18} />
                    </button>

                    {pageNumbers[0] > 1 && (
                      <>
                        <button onClick={() => goToPage(1)} className='w-10 h-10 rounded-xl glass-button text-sm font-semibold transition-transform active:scale-90 hover:scale-105'>1</button>
                        {pageNumbers[0] > 2 && <span className='px-1' style={{ color: 'hsl(var(--muted-foreground))' }}>…</span>}
                      </>
                    )}

                    {pageNumbers.map(page => (
                      <button
                        key={page}
                        onClick={() => goToPage(page)}
                        className={`w-10 h-10 rounded-xl text-sm font-semibold transition-transform active:scale-90 hover:scale-105 ${
                          page === currentPage ? 'glow-soft text-white' : 'glass-button'
                        }`}
                        style={page === currentPage ? {
                          background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))',
                        } : {}}
                      >
                        {page}
                      </button>
                    ))}

                    {pageNumbers[pageNumbers.length - 1] < totalPages && (
                      <>
                        {pageNumbers[pageNumbers.length - 1] < totalPages - 1 && <span className='px-1' style={{ color: 'hsl(var(--muted-foreground))' }}>…</span>}
                        <button onClick={() => goToPage(totalPages)} className='w-10 h-10 rounded-xl glass-button text-sm font-semibold transition-transform active:scale-90 hover:scale-105'>{totalPages}</button>
                      </>
                    )}

                    <button
                      onClick={() => goToPage(currentPage + 1)}
                      disabled={currentPage === totalPages}
                      className='p-2 rounded-xl glass-button disabled:opacity-30 disabled:cursor-not-allowed transition-transform active:scale-90 hover:scale-105'
                    >
                      <ChevronRight size={18} />
                    </button>

                    <span className='ml-3 text-xs font-medium' style={{ color: 'hsl(var(--muted-foreground))' }}>
                      Page {currentPage} of {totalPages}
                    </span>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}

export default Products
