import { useState, useEffect, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from "framer-motion"
import axios from 'axios'
import Loader from './common/Loader'
import ProductCard from './common/ProductCard'
import StoreSearch from './common/StoreSearch'
import { PackageX, RefreshCw, Filter, X, Sparkles } from 'lucide-react'
import ErrorPage from './layout/ErrorPage'
import { toast } from 'react-toastify'
import { useAuth } from '../contexts/AuthContext'
import CurrencySelector from './common/CurrencySelector'
import { useCurrency } from '../contexts/CurrencyContext'


function Products() {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [isFilterOpen, setIsFilterOpen] = useState(false)

  const priceRangeRef = useRef(null)
  const navigate = useNavigate()
  const location = useLocation()
  const { currentUser } = useAuth()
  const { formatPrice } = useCurrency()

  const { register, reset, watch, setValue } = useForm({
    defaultValues: { categories: [], brands: [], priceRange: ["0", "5000"] }
  })

  const filters = watch()
  const [categories, setCategories] = useState([])
  const [search, setSearch] = useState("")
  const [brands, setBrands] = useState([])

  useEffect(() => { if (search === '') fetchProducts() }, [search])

  const fetchProducts = async () => {
    setLoading(true); setError(null)
    try {
      const query = serializeFilters()
      navigate(`${location.pathname}?${query}`)
      const res = await axios.get(`${import.meta.env.VITE_API_URL}api/products/get-products?${query}`)
      setProducts(res.data.products || [])
    } catch (err) { console.log(err); setError(err) }
    finally { setLoading(false) }
  }

  useEffect(() => { fetchProducts() }, [])
  useEffect(() => { fetchProducts() }, [JSON.stringify(filters)])

  const serializeFilters = () => {
    let params = new URLSearchParams()
    Object.keys(filters).forEach((key) => {
      const value = filters[key]
      if (Array.isArray(value)) {
        if (key === 'priceRange') params.append(key, value.join(','))
        else value.forEach(item => params.append(key, item))
      }
    })
    if (search !== '') params.append('search', search)
    return params.toString()
  }

  useEffect(() => {
    const fetchFilters = async () => {
      try {
        const res = await axios.get(`${import.meta.env.VITE_API_URL}api/products/get-filters`)
        setCategories(res.data.categories); setBrands(res.data.brands)
      } catch (error) { setCategories([]); setBrands([]) }
    }
    fetchFilters()
    reset(parseQueryParams(location.search))
  }, [])

  const parseQueryParams = (search) => {
    const params = new URLSearchParams(search)
    return {
      categories: params.getAll('categories'),
      brands: params.getAll('brands'),
      search: params.get('search') || '',
      priceRange: params.get('priceRange') ? params.get('priceRange').split(',') : ["0", "5000"]
    }
  }

  if (error) return (
    <div className='w-full h flex justify-center items-center flex-col gap-4'>
      <h1 className='text-2xl font-bold'>Error Occurred</h1>
      <p className='text-xl font-semibold' style={{ color: 'hsl(var(--primary))' }}>{error.message}</p>
      <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.9 }}
        onClick={() => window.location.reload()}
        className='flex gap-3 px-4 py-2 rounded-xl font-semibold cursor-pointer glow-soft'
        style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }}>
        Reload <RefreshCw />
      </motion.button>
    </div>
  )

  const activeFilterCount = filters.categories.length + filters.brands.length +
    (filters.priceRange[0] !== '0' || filters.priceRange[1] !== '5000' ? 1 : 0)

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

      {/* Search */}
      <div>
        <label className='block text-xs font-semibold uppercase tracking-wider mb-2' style={{ color: 'hsl(var(--muted-foreground))' }}>Search</label>
        <form onSubmit={(e) => { e.preventDefault(); fetchProducts(); onClose && onClose(); }}>
          <input className='glass-input' placeholder='Search products...' type='text' value={search} onChange={(e) => setSearch(e.target.value)} />
        </form>
      </div>

      {/* Categories */}
      <div>
        <label className='block text-xs font-semibold uppercase tracking-wider mb-3' style={{ color: 'hsl(var(--muted-foreground))' }}>Categories</label>
        {!categories || categories.length === 0
          ? <p className='text-sm italic' style={{ color: 'hsl(var(--muted-foreground))' }}>No categories available</p>
          : <div className='flex flex-col gap-1'>
            {categories.map(category => (
              <label key={category} className='glass-checkbox-label flex items-center gap-3 cursor-pointer py-2 px-3 rounded-xl transition-all hover:bg-white/10'>
                <span className='glass-checkbox-box relative w-5 h-5 rounded-lg border border-white/25 bg-white/8 backdrop-blur-sm flex items-center justify-center shrink-0 transition-all'>
                  <input type='checkbox' value={category} {...register('categories')}
                    className='absolute inset-0 opacity-0 cursor-pointer peer' />
                  <svg className='w-3 h-3 hidden peer-checked:block' style={{ color: 'hsl(var(--primary))' }} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="2 6 5 9 10 3" />
                  </svg>
                </span>
                <span className='text-sm font-medium'>{category}</span>
              </label>
            ))}
          </div>
        }
      </div>

      {/* Brands */}
      <div>
        <label className='block text-xs font-semibold uppercase tracking-wider mb-3' style={{ color: 'hsl(var(--muted-foreground))' }}>Brands</label>
        {!brands || brands.length === 0
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
          </div>
        }
      </div>

      {/* Price Range */}
      <div>
        <label className='block text-xs font-semibold uppercase tracking-wider mb-3' style={{ color: 'hsl(var(--muted-foreground))' }}>Price Range</label>
        <input type='range' min={0} max={5000} defaultValue={0}
          {...register('priceRange')} ref={priceRangeRef}
          onChange={(e) => setValue('priceRange', [e.target.value, 5000])}
          className='w-full h-2 rounded-full appearance-none cursor-pointer accent-indigo-600'
          style={{ background: 'rgba(255,255,255,0.15)' }}
        />
        <div className='flex justify-between mt-2'>
          <span className='tag-pill text-xs font-semibold'>${filters.priceRange[0]}</span>
          <span className='tag-pill text-xs font-semibold'>${filters.priceRange[1]}</span>
        </div>
      </div>

      {/* Active Filters */}
      {activeFilterCount > 0 && (
        <div className='flex flex-wrap gap-2'>
          {filters.categories.map(c => (
            <span key={c} className='tag-pill text-xs font-medium'>{c}</span>
          ))}
          {filters.brands.map(b => (
            <span key={b} className='tag-pill text-xs font-medium' style={{ background: 'rgba(56, 189, 248, 0.1)', color: 'hsl(200, 80%, 50%)' }}>{b}</span>
          ))}
        </div>
      )}

      {/* Reset Button */}
      <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
        onClick={() => { reset({ categories: [], brands: [], search: '', priceRange: ['0', '5000'] }); if (priceRangeRef.current) priceRangeRef.current.value = 0; }}
        className='w-full py-2.5 rounded-xl glass-button font-semibold text-sm' style={{ color: 'hsl(var(--primary))' }}>
        Reset All Filters
      </motion.button>
    </div>
  )

  return (
    <div className='relative flex flex-col lg:flex-row min-h-screen'>
      {/* Mobile Filter Toggle */}
      <div className='lg:hidden fixed bottom-6 right-6 z-40'>
        <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
          onClick={() => setIsFilterOpen(true)}
          className='pl-4 pr-5 py-3 rounded-full shadow-xl flex items-center gap-2 font-semibold text-sm glow-soft'
          style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }}>
          <Filter size={18} />
          Filters {activeFilterCount > 0 && `(${activeFilterCount})`}
        </motion.button>
      </div>

      {/* Mobile Filter Overlay */}
      <AnimatePresence>
        {isFilterOpen && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/40 backdrop-blur-sm z-30 lg:hidden"
              onClick={() => setIsFilterOpen(false)} />
            <motion.aside
              initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }}
              transition={{ type: 'tween', ease: 'easeInOut', duration: 0.28 }}
              className='fixed top-0 left-0 h-full w-80 max-w-full glass-panel-strong z-40 overflow-y-auto lg:hidden'
              style={{ borderRadius: '0 28px 28px 0' }}>
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
      <main className='flex-1 p-4 lg:p-6'>
        <div className='mb-6 flex flex-col gap-4'>
          <StoreSearch />
          <div className='flex flex-col sm:flex-row justify-between items-center gap-3'>
            <div className='flex items-center gap-3'>
              <h1 className='text-2xl lg:text-3xl font-extrabold tracking-tight'>Products</h1>
              <Link to='/stores' className='tag-pill text-sm font-medium flex items-center gap-1'>
                Browse Stores →
              </Link>
            </div>
            <div className='flex items-center gap-3'>
              <span className='tag-pill text-sm font-medium'>
                {products.length} {products.length === 1 ? 'product' : 'products'}
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
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                className='flex flex-col items-center justify-center h-64'>
                <div className='glass-inner p-6 rounded-2xl mb-4'>
                  <PackageX size={48} strokeWidth={1.5} style={{ color: 'hsl(var(--muted-foreground))' }} />
                </div>
                <p className='text-lg font-semibold'>No products found</p>
                <p className='text-sm mt-1' style={{ color: 'hsl(var(--muted-foreground))' }}>Try adjusting your filters</p>
              </motion.div>
            ) : (
              <div className='grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4 lg:gap-5'>
                {products.map((prod, idx) => (
                  <ProductCard key={prod._id} idx={idx} {...prod} />
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}

export default Products
