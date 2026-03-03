import { useState, useEffect, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from "framer-motion"
import axios from 'axios'
import Loader from './common/Loader'
import ProductCard from './common/ProductCard'
import StoreSearch from './common/StoreSearch'
import { PackageX, RefreshCw, Filter, X } from 'lucide-react'
import ErrorPage from './layout/ErrorPage'
// import SpinWheel from './common/SpinWheel' // SPIN WHEEL DISABLED
// import SpinBanner from './common/SpinBanner' // SPIN WHEEL DISABLED
import { toast } from 'react-toastify'
import { useAuth } from '../contexts/AuthContext'
import CurrencySelector from './common/CurrencySelector'
import { useCurrency } from '../contexts/CurrencyContext'


function Products() {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [isFilterOpen, setIsFilterOpen] = useState(false)
  // const [showSpinWheel, setShowSpinWheel] = useState(false) // SPIN WHEEL DISABLED
  // const [spinResult, setSpinResult] = useState(null) // SPIN WHEEL DISABLED
  // const [displayProducts, setDisplayProducts] = useState([]) // SPIN WHEEL DISABLED

  const priceRangeRef = useRef(null)
  // const isInitialMount = useRef(true) // SPIN WHEEL DISABLED
  const navigate = useNavigate()
  const location = useLocation()
  const { currentUser } = useAuth()
  const { formatPrice } = useCurrency()

  const {
    register,
    reset,
    watch,
    setValue
  } = useForm({
    defaultValues: {
      categories: [],
      brands: [],
      priceRange: ["0", "5000"]
    }
  })

  const filters = watch()
  const [categories, setCategories] = useState([])
  const [search, setSearch] = useState("")
  const [brands, setBrands] = useState([])

  useEffect(() => {
    if (search === '') fetchProducts()
  }, [search])

  const fetchProducts = async () => {
    setLoading(true)
    setError(null)
    try {
      const query = serializeFilters()
      navigate(`${location.pathname}?${query}`)
      const res = await axios.get(`${import.meta.env.VITE_API_URL}api/products/get-products?${query}`)
      setProducts(res.data.products)
    } catch (err) {
      console.log(err)
      setError(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchProducts()
    // checkActiveSpin() // SPIN WHEEL DISABLED
  }, [])

  // SPIN WHEEL DISABLED - re-check spin useEffect removed
  // useEffect(() => {
  //   if (isInitialMount.current) { isInitialMount.current = false; return; }
  //   if (currentUser) { checkActiveSpin() }
  // }, [currentUser])

  // SPIN WHEEL DISABLED - applySpinDiscount useEffect removed
  // useEffect(() => {
  //   applySpinDiscount()
  // }, [products, spinResult])

  /* SPIN WHEEL DISABLED - checkActiveSpin function
  const checkActiveSpin = async () => {
    // If user is logged in, check database first
    if (currentUser) {
      console.log('🔍 Checking spin for logged-in user:', currentUser.email);
      try {
        const token = localStorage.getItem('jwtToken');
        const res = await axios.get(`${import.meta.env.VITE_API_URL}api/user/spin/get`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        const { spinResult: dbSpinResult, spinTimestamp: dbSpinTimestamp, spinSelectedProducts: dbSpinProducts } = res.data.spinData;
        console.log('📊 Database spin data:', { dbSpinResult, dbSpinTimestamp, dbSpinProducts });
        
        if (dbSpinResult && dbSpinTimestamp) {
          const now = new Date().getTime();
          const hoursPassed = (now - dbSpinTimestamp) / (1000 * 60 * 60);
          console.log(`⏰ Hours since last spin: ${hoursPassed.toFixed(2)}`);
          
          if (hoursPassed < 24) {
            // Valid spin in database (within 24 hours)
            console.log('✅ Valid spin found in database');
            setSpinResult(dbSpinResult);
            // Sync to localStorage for consistency
            localStorage.setItem('spinResult', JSON.stringify(dbSpinResult));
            localStorage.setItem('spinTimestamp', dbSpinTimestamp.toString());
            localStorage.setItem('spinSelectedProducts', JSON.stringify(dbSpinProducts || []));
            
            // Don't show spinner - user already has an active spin (even if checked out)
            // They must wait 24 hours from their last spin
            return;
          } else {
            console.log('⏰ Spin expired (>24 hours)');
          }
        } else {
          console.log('❌ No spin data in database');
        }
        
        // If we reach here, user has no active spin in DB (or it expired)
        // Check if this account has EVER spun before (even if expired)
        const hasSpunBefore = dbSpinTimestamp && dbSpinTimestamp > 0;
        
        if (hasSpunBefore) {
          // This account has spun before - clear any guest spin data
          // Don't transfer guest spins to accounts that have already used their spin
          console.log('🚫 Account has spun before - clearing guest spin data');
          localStorage.removeItem('spinResult');
          localStorage.removeItem('spinTimestamp');
          localStorage.removeItem('spinSelectedProducts');
          // User can spin again since their spin expired
        } else {
          // This is a brand new account that has NEVER spun
          // Check if there's valid guest spin data to transfer
          const storedSpin = localStorage.getItem('spinResult');
          const storedTimestamp = localStorage.getItem('spinTimestamp');
          
          if (storedSpin && storedTimestamp) {
            const now = new Date().getTime();
            const spinTime = parseInt(storedTimestamp);
            const hoursPassed = (now - spinTime) / (1000 * 60 * 60);
            
            if (hoursPassed < 24) {
              // Valid guest spin - save it to this NEW account
              console.log('💾 New account - transferring guest spin');
              const spinData = JSON.parse(storedSpin);
              setSpinResult(spinData);
              
              try {
                const token = localStorage.getItem('jwtToken');
                await axios.post(`${import.meta.env.VITE_API_URL}api/user/spin/save`, {
                  spinResult: spinData,
                  spinTimestamp: spinTime,
                  spinSelectedProducts: JSON.parse(localStorage.getItem('spinSelectedProducts') || '[]')
                }, {
                  headers: { Authorization: `Bearer ${token}` }
                });
                console.log('✅ Guest spin saved to new account');
              } catch (error) {
                console.error('❌ Error saving guest spin to account:', error);
              }
              return; // Don't show spinner - user has active spin
            } else {
              // Expired guest spin - clear it
              console.log('🗑️ Clearing expired guest spin');
              localStorage.removeItem('spinResult');
              localStorage.removeItem('spinTimestamp');
              localStorage.removeItem('spinSelectedProducts');
            }
          }
        }
        
        // Clear any remaining localStorage data to be safe
        localStorage.removeItem('spinResult');
        localStorage.removeItem('spinTimestamp');
        localStorage.removeItem('spinSelectedProducts');
      } catch (error) {
        console.error('❌ Error fetching spin data:', error);
      }
    }
    
    // For non-logged-in users, check localStorage
    const storedSpin = localStorage.getItem('spinResult');
    const spinTimestamp = localStorage.getItem('spinTimestamp');
    
    if (storedSpin && spinTimestamp) {
      const now = new Date().getTime();
      const spinTime = parseInt(spinTimestamp);
      const hoursPassed = (now - spinTime) / (1000 * 60 * 60);
      
      // If less than 24 hours
      if (hoursPassed < 24) {
        const spinData = JSON.parse(storedSpin);
        setSpinResult(spinData);
        
        // If user is logged in, save to database
        if (currentUser) {
          try {
            const token = localStorage.getItem('jwtToken');
            await axios.post(`${import.meta.env.VITE_API_URL}api/user/spin/save`, {
              spinResult: spinData,
              spinTimestamp: spinTime,
              spinSelectedProducts: JSON.parse(localStorage.getItem('spinSelectedProducts') || '[]')
            }, {
              headers: { Authorization: `Bearer ${token}` }
            });
          } catch (error) {
            console.error('Error saving spin to database:', error);
          }
        }
        return;
      } else {
        // Clear expired spin
        localStorage.removeItem('spinResult');
        localStorage.removeItem('spinTimestamp');
        localStorage.removeItem('spinSelectedProducts');
      }
    }

    // Check if spinner was already shown in this session
    const spinnerShownThisSession = sessionStorage.getItem('spinnerShown');
    
    // Auto-show spin wheel only if no active spin AND not shown in this session
    if (!spinnerShownThisSession) {
      setShowSpinWheel(true);
      sessionStorage.setItem('spinnerShown', 'true');
    }
  };
  SPIN WHEEL DISABLED */

  /* SPIN WHEEL DISABLED - applySpinDiscount function
  const applySpinDiscount = () => {
    if (!spinResult || spinResult.hasCheckedOut) {
      setDisplayProducts(products);
      return;
    }

    const discountedProducts = products.map(product => {
      let newPrice = product.price;

      if (spinResult.type === 'free') {
        newPrice = 0;
      } else if (spinResult.type === 'fixed') {
        newPrice = spinResult.value;
      } else if (spinResult.type === 'percentage') {
        newPrice = product.price * (1 - spinResult.value / 100);
      }

      return {
        ...product,
        originalPrice: product.price,
        spinDiscountedPrice: Math.max(0, newPrice),
        hasSpinDiscount: true
      };
    });

    setDisplayProducts(discountedProducts);
  };
  SPIN WHEEL DISABLED */

  /* SPIN WHEEL DISABLED - handleSpinComplete function
  const handleSpinComplete = async (result) => {
    const timestamp = new Date().getTime();
    console.log('🎰 Spin completed:', result);
    
    // Store in localStorage
    localStorage.setItem('spinResult', JSON.stringify(result));
    localStorage.setItem('spinTimestamp', timestamp.toString());
    localStorage.setItem('spinSelectedProducts', JSON.stringify([]));
    
    // If user is logged in, also save to database
    if (currentUser) {
      console.log('💾 Saving spin to database for user:', currentUser.email);
      try {
        const token = localStorage.getItem('jwtToken');
        const saveRes = await axios.post(`${import.meta.env.VITE_API_URL}api/user/spin/save`, {
          spinResult: result,
          spinTimestamp: timestamp,
          spinSelectedProducts: []
        }, {
          headers: { Authorization: `Bearer ${token}` }
        });
        console.log('✅ Spin saved to database:', saveRes.data);
      } catch (error) {
        console.error('❌ Error saving spin to database:', error);
      }
    } else {
      console.log('👤 User not logged in, spin saved to localStorage only');
    }
    
    // Update state immediately for dynamic update
    setSpinResult(result);
    setShowSpinWheel(false);
    
    // Format the toast message with proper currency conversion
    let prizeText = result.label;
    if (result.type === 'fixed') {
      prizeText = `All products ${formatPrice(result.value)}`;
    } else if (result.type === 'free') {
      prizeText = 'All products FREE';
    }
    
    toast.success(`🎉 You won ${prizeText}! Select up to 3 products now!`);
  };
  SPIN WHEEL DISABLED */

  useEffect(() => {
    fetchProducts()
  }, [JSON.stringify(filters)])

  const serializeFilters = () => {
    let params = new URLSearchParams()
    Object.keys(filters).forEach((key) => {
      const value = filters[key]
      if (Array.isArray(value)) {
        if (key === 'priceRange') {
          params.append(key, value.join(','))
        } else {
          value.forEach(item => params.append(key, item))
        }
      }
    })
    if (search !== '') params.append('search', search)
    return params.toString()
  }

  useEffect(() => {
    const fetchFilters = async () => {
      try {
        const res = await axios.get(`${import.meta.env.VITE_API_URL}api/products/get-filters`)
        setCategories(res.data.categories)
        setBrands(res.data.brands)
      } catch (error) {
        console.error(error)
        setCategories([])
        setBrands([])
      }
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

  if (error) return <div className='w-full h flex justify-center items-center flex-col gap-4'>
    <h1 className='text-2xl'>
      Error Occured
    </h1>
    <p className='text-xl font-semibold text-blue-600'>
      {error.message}
    </p>
    <motion.button
      whileHover={{ scale: 1.05 }}
      onClick={() => {
        window.location.reload()
      }}
      whileTap={{ scale: 0.9 }}
      className='flex gap-3 bg-blue-800 text-white px-3 py-2 rounded font-semibold cursor-pointer'>
      Reload <RefreshCw />
    </motion.button>
  </div>

  // Active filter count for badge
  const activeFilterCount = filters.categories.length + filters.brands.length +
    (filters.priceRange[0] !== '0' || filters.priceRange[1] !== '5000' ? 1 : 0)

  // Shared sidebar content to avoid duplication
  const FilterSidebarContent = ({ onClose }) => (
    <div className='flex flex-col gap-6 p-6'>
      {/* Header */}
      <div className='flex justify-between items-center'>
        <div className='flex items-center gap-2'>
          <div className='p-1.5 rounded-lg bg-indigo-100'>
            <Filter size={16} className='text-indigo-600' />
          </div>
          <h1 className='text-lg font-bold text-slate-800'>Filters</h1>
          {activeFilterCount > 0 && (
            <span className='ml-1 text-xs font-bold bg-indigo-500 text-white rounded-full px-2 py-0.5'>
              {activeFilterCount}
            </span>
          )}
        </div>
        {onClose && (
          <button onClick={onClose} className='p-1.5 rounded-lg hover:bg-slate-100 transition-colors'>
            <X size={20} className='text-slate-500' />
          </button>
        )}
      </div>

      {/* Search */}
      <div>
        <label className='block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2'>Search</label>
        <form onSubmit={(e) => { e.preventDefault(); fetchProducts(); onClose && onClose(); }}>
          <input
            className='w-full px-3 py-2.5 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 text-sm text-slate-700 placeholder-slate-400 transition-all'
            placeholder='Search products...'
            type='text'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>
      </div>

      {/* Categories */}
      <div>
        <label className='block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3'>Categories</label>
        {!categories || categories.length === 0
          ? <p className='text-sm text-slate-400 italic'>No categories available</p>
          : <div className='flex flex-col gap-1'>
            {categories.map(category => (
              <label key={category} className='flex items-center gap-3 cursor-pointer py-1.5 px-2 rounded-lg hover:bg-indigo-50 group transition-colors'>
                <input type='checkbox' value={category} {...register('categories')}
                  className='w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer' />
                <span className='text-sm text-slate-700 group-hover:text-indigo-700 transition-colors'>{category}</span>
              </label>
            ))}
          </div>
        }
      </div>

      {/* Brands */}
      <div>
        <label className='block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3'>Brands</label>
        {!brands || brands.length === 0
          ? <p className='text-sm text-slate-400 italic'>No brands available</p>
          : <div className='flex flex-col gap-1'>
            {brands.map(brand => (
              <label key={brand} className='flex items-center gap-3 cursor-pointer py-1.5 px-2 rounded-lg hover:bg-indigo-50 group transition-colors'>
                <input type='checkbox' value={brand} {...register('brands')}
                  className='w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer' />
                <span className='text-sm text-slate-700 group-hover:text-indigo-700 transition-colors'>{brand}</span>
              </label>
            ))}
          </div>
        }
      </div>

      {/* Price Range */}
      <div>
        <label className='block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3'>Price Range</label>
        <input type='range' min={0} max={5000} defaultValue={0}
          {...register('priceRange')} ref={priceRangeRef}
          onChange={(e) => setValue('priceRange', [e.target.value, 5000])}
          className='w-full h-2 rounded-full appearance-none cursor-pointer accent-indigo-600 bg-slate-200'
        />
        <div className='flex justify-between mt-2'>
          <span className='text-xs font-semibold text-indigo-600 bg-indigo-50 px-2 py-1 rounded-lg'>
            ${filters.priceRange[0]}
          </span>
          <span className='text-xs font-semibold text-slate-500 bg-slate-100 px-2 py-1 rounded-lg'>
            ${filters.priceRange[1]}
          </span>
        </div>
      </div>

      {/* Active Filters Pills */}
      {activeFilterCount > 0 && (
        <div className='flex flex-wrap gap-2'>
          {filters.categories.map(c => (
            <span key={c} className='inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700'>
              {c}
            </span>
          ))}
          {filters.brands.map(b => (
            <span key={b} className='inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-sky-100 text-sky-700'>
              {b}
            </span>
          ))}
        </div>
      )}

      {/* Reset Button */}
      <motion.button
        whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
        onClick={() => { reset({ categories: [], brands: [], search: '', priceRange: ['0', '5000'] }); if (priceRangeRef.current) priceRangeRef.current.value = 0; }}
        className='w-full py-2.5 rounded-xl border-2 border-indigo-200 text-indigo-600 font-semibold text-sm hover:bg-indigo-50 transition-all'>
        Reset All Filters
      </motion.button>
    </div>
  )

  return (
    <div className='relative flex flex-col lg:flex-row min-h-screen'>
      {/* Mobile Filter Toggle Button */}
      <div className='lg:hidden fixed bottom-6 right-6 z-40'>
        <motion.button
          whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
          onClick={() => setIsFilterOpen(true)}
          className='bg-linear-to-r from-indigo-500 to-sky-400 text-white pl-4 pr-5 py-3 rounded-full shadow-xl shadow-indigo-300/40 flex items-center gap-2 font-semibold text-sm'
        >
          <Filter size={18} />
          Filters {activeFilterCount > 0 && `(${activeFilterCount})`}
        </motion.button>
      </div>

      {/* Filter Sidebar Overlay for Mobile */}
      <AnimatePresence>
        {isFilterOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/50 backdrop-blur-sm z-30 lg:hidden"
              onClick={() => setIsFilterOpen(false)}
            />
            <motion.aside
              initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }}
              transition={{ type: 'tween', ease: 'easeInOut', duration: 0.28 }}
              className='fixed top-0 left-0 h-full w-80 max-w-full bg-white z-40 overflow-y-auto lg:hidden shadow-2xl'
            >
              <FilterSidebarContent onClose={() => setIsFilterOpen(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Filter Sidebar for Desktop */}
      <aside className='hidden lg:block m-5 rounded-2xl bg-white shadow-sm border border-slate-100 w-72 shrink-0 self-start sticky top-24 overflow-y-auto max-h-[calc(100vh-7rem)] filter-sb'>
        <FilterSidebarContent onClose={null} />
      </aside>

      {/* Product Grid */}
      <main className='flex-1 p-4 lg:p-6'>
        {/* Store Search */}
        <div className='mb-6 flex flex-col gap-4'>
          <StoreSearch />
          <div className='flex flex-col sm:flex-row justify-between items-center gap-3'>
            <div className='flex items-center gap-3'>
              <h1 className='text-2xl lg:text-3xl font-bold text-slate-800'>Products</h1>
              <Link to='/stores'
                className='text-sm font-medium text-indigo-600 hover:text-indigo-700 transition-colors flex items-center gap-1 bg-indigo-50 px-3 py-1.5 rounded-full'>
                Browse Stores →
              </Link>
            </div>
            <div className='flex items-center gap-3'>
              <span className='text-sm text-slate-500 bg-slate-100 px-3 py-1.5 rounded-full font-medium'>
                {products.length} {products.length === 1 ? 'product' : 'products'}
              </span>
              <CurrencySelector />
            </div>
          </div>
        </div>

        {loading ? (
          <div className='flex justify-center items-center h-64'>
            <Loader />
          </div>
        ) : (
          <>
            {products.length === 0 ? (
              <motion.div
                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                className='flex flex-col items-center justify-center h-64 text-slate-400'>
                <div className='p-6 rounded-2xl bg-slate-100 mb-4'>
                  <PackageX size={48} strokeWidth={1.5} />
                </div>
                <p className='text-lg font-semibold text-slate-600'>No products found</p>
                <p className='text-sm mt-1'>Try adjusting your filters or search term</p>
              </motion.div>
            ) : (
              <div className='grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4 lg:gap-6'>
                {products.map((prod, idx) => (
                  <ProductCard
                    key={prod._id}
                    idx={idx}
                    {...prod}
                    // spinResult={spinResult} // SPIN WHEEL DISABLED
                  />
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {/* SPIN WHEEL DISABLED - SpinWheel modal removed */}
      {/* <AnimatePresence>
        {showSpinWheel && (
          <SpinWheel onSpinComplete={handleSpinComplete} onClose={() => setShowSpinWheel(false)} />
        )}
      </AnimatePresence> */}
    </div>
  )
}

export default Products