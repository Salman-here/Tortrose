import { useState, useEffect, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from "framer-motion"
import axios from 'axios'
import Loader from './common/Loader'
import ProductCard from './common/ProductCard'
import { PackageX, RefreshCw, Filter, X, Gift } from 'lucide-react'
import ErrorPage from './layout/ErrorPage'
import SpinWheel from './common/SpinWheel'
import SpinBanner from './common/SpinBanner'
import { toast } from 'react-toastify'
import { useAuth } from '../contexts/AuthContext'


function Products() {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [isFilterOpen, setIsFilterOpen] = useState(false)
  const [showSpinWheel, setShowSpinWheel] = useState(false)
  const [spinResult, setSpinResult] = useState(null)
  const [displayProducts, setDisplayProducts] = useState([])

  const priceRangeRef = useRef(null)
  const navigate = useNavigate()
  const location = useLocation()
  const { currentUser } = useAuth()

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
      const res = await axios.get(`http://localhost:5000/api/products/get-products?${query}`)
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
    checkActiveSpin()
  }, [])

  useEffect(() => {
    applySpinDiscount()
  }, [products, spinResult])

  const checkActiveSpin = () => {
    // Check localStorage for existing spin (works for all users)
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
        // Don't show spin wheel even if checked out (must wait 24 hours)
        return;
      } else {
        // Clear expired spin (after 24 hours)
        localStorage.removeItem('spinResult');
        localStorage.removeItem('spinTimestamp');
        localStorage.removeItem('spinSelectedProducts');
      }
    }

    // Show spin wheel if no active spin
    setShowSpinWheel(true);
  };

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

  const handleSpinComplete = (result) => {
    // Store in localStorage
    localStorage.setItem('spinResult', JSON.stringify(result));
    localStorage.setItem('spinTimestamp', new Date().getTime().toString());
    localStorage.setItem('spinSelectedProducts', JSON.stringify([]));
    
    // Update state immediately for dynamic update
    setSpinResult(result);
    setShowSpinWheel(false);
    
    toast.success(`🎉 You won ${result.label}! Select up to 3 products now!`);
  };

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
        const res = await axios.get('http://localhost:5000/api/products/get-filters')
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

  return (
    <div className='relative flex flex-col lg:flex-row min-h-screen'>
      {/* Mobile Filter Toggle Button */}
      <div className='lg:hidden fixed bottom-6 right-6 z-40'>
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => setIsFilterOpen(true)}
          className='bg-blue-600 text-white p-4 rounded-full shadow-lg flex items-center justify-center'
        >
          <Filter size={24} />
        </motion.button>
      </div>

      {/* Filter Sidebar Overlay for Mobile */}
      <AnimatePresence>
        {isFilterOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.5 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black z-30 lg:hidden"
              onClick={() => setIsFilterOpen(false)}
            />
            <motion.aside
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'tween', ease: 'easeInOut' }}
              className='fixed top-0 left-0 h-full w-80 max-w-full bg-white z-40 overflow-y-auto lg:hidden shadow-xl'
            >
              <div className='p-6 flex flex-col gap-6'>
                <div className='flex justify-between items-center'>
                  <h1 className='text-2xl font-bold'>Filters</h1>
                  <button onClick={() => setIsFilterOpen(false)}>
                    <X size={24} />
                  </button>
                </div>

                {/* Search */}
                <form onSubmit={(e) => {
                  e.preventDefault()
                  fetchProducts()
                  setIsFilterOpen(false)
                }}>
                  <h2 className='text-md font-semibold mb-1'>SEARCH</h2>
                  <input
                    className='p-2 rounded w-full border border-gray-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500'
                    placeholder='Search products...'
                    type='text'
                    name='search'
                    onChange={(e) => {
                      setSearch(e.target.value)
                    }}
                  />
                </form>

                {/* Categories */}
                <div className='flex flex-col gap-1'>
                  <h2 className='text-md font-semibold mb-1'>CATEGORIES</h2>
                  {
                    categories.length === 0
                      ? <p className='text-gray-500'>No categories available.</p>
                      : categories.map(category => (
                        <label key={category} className='flex gap-2 items-center cursor-pointer py-1'>
                          <input type='checkbox' value={category} {...register('categories')} />
                          <span className='text-gray-700'>{category}</span>
                        </label>
                      ))
                  }
                </div>

                {/* Brands */}
                <div className='flex flex-col gap-1'>
                  <h2 className='text-md font-semibold mb-1'>BRANDS</h2>
                  {
                    brands.length === 0
                      ? <p className='text-gray-500'>No brands available.</p>
                      : brands.map(brand => (
                        <label key={brand} className='flex gap-2 items-center cursor-pointer py-1'>
                          <input type='checkbox' value={brand} {...register('brands')} />
                          <span className='text-gray-700'>{brand}</span>
                        </label>
                      ))
                  }
                </div>

                {/* Price Range */}
                <div>
                  <h2 className='text-md font-semibold mb-1'>PRICE RANGE</h2>
                  <input
                    type='range'
                    min={0}
                    max={5000}
                    defaultValue={0}
                    {...register('priceRange')}
                    ref={priceRangeRef}
                    onChange={(e) => {
                      setValue('priceRange', [e.target.value, 5000])
                    }}
                    className='w-full'
                  />
                  <p className='text-sm text-gray-600'>
                    ${filters.priceRange[0]} - ${filters.priceRange[1]}
                  </p>
                </div>

                {/* Reset Button */}
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => {
                    reset({
                      categories: [],
                      brands: [],
                      search: '',
                      priceRange: ["0", "5000"]
                    })
                    priceRangeRef.current.value = 0
                  }}
                  className='bg-green-600 text-white font-semibold text-lg py-2 rounded'
                >
                  Reset Filters
                </motion.button>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Filter Sidebar for Desktop */}
      <aside className='hidden lg:flex lg:flex-col m-5 rounded-xl gap-6 p-6 bg-white shadow-md w-80 flex-shrink-0'>
        <h1 className='text-2xl font-bold'>Filters</h1>

        {/* Search */}
        <form onSubmit={(e) => {
          e.preventDefault()
          fetchProducts()
        }}>
          <h2 className='text-md font-semibold mb-1'>SEARCH</h2>
          <input
            className='p-2 rounded w-full border border-gray-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500'
            placeholder='Search products...'
            type='text'
            name='search'
            onChange={(e) => {
              setSearch(e.target.value)
            }}
          />
        </form>

        {/* Categories */}
        <div className='flex flex-col gap-1'>
          <h2 className='text-md font-semibold mb-1'>CATEGORIES</h2>
          {
            categories.length === 0
              ? <p className='text-gray-500'>No categories available.</p>
              : categories.map(category => (
                <label key={category} className='flex gap-2 items-center cursor-pointer py-1'>
                  <input type='checkbox' value={category} {...register('categories')} />
                  <span className='text-gray-700'>{category}</span>
                </label>
              ))
          }
        </div>

        {/* Brands */}
        <div className='flex flex-col gap-1'>
          <h2 className='text-md font-semibold mb-1'>BRANDS</h2>
          {
            brands.length === 0
              ? <p className='text-gray-500'>No brands available.</p>
              : brands.map(brand => (
                <label key={brand} className='flex gap-2 items-center cursor-pointer py-1'>
                  <input type='checkbox' value={brand} {...register('brands')} />
                  <span className='text-gray-700'>{brand}</span>
                </label>
              ))
          }
        </div>

        {/* Price Range */}
        <div>
          <h2 className='text-md font-semibold mb-1'>PRICE RANGE</h2>
          <input
            type='range'
            min={0}
            max={5000}
            defaultValue={0}
            {...register('priceRange')}
            ref={priceRangeRef}
            onChange={(e) => {
              setValue('priceRange', [e.target.value, 5000])
            }}
            className='w-full'
          />
          <p className='text-sm text-gray-600'>
            ${filters.priceRange[0]} - ${filters.priceRange[1]}
          </p>
        </div>

        {/* Reset Button */}
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => {
            reset({
              categories: [],
              brands: [],
              search: '',
              priceRange: ["0", "5000"]
            })
            priceRangeRef.current.value = 0
          }}
          className='bg-green-600 text-white font-semibold text-lg py-2 rounded'
        >
          Reset Filters
        </motion.button>
      </aside>

      {/* Product Grid */}
      <main className='flex-1 p-4 lg:p-6'>
        {/* Spin Banner */}
        {spinResult && !spinResult.hasCheckedOut && (
          <SpinBanner 
            spinResult={spinResult} 
            selectedCount={JSON.parse(localStorage.getItem('spinSelectedProducts') || '[]').length}
          />
        )}

        {spinResult && spinResult.hasCheckedOut && (
          <SpinBanner spinResult={spinResult} />
        )}

        <div className='mb-6 flex justify-between items-center'>
          <h1 className='text-2xl lg:text-3xl font-bold'>Products</h1>
          <div className='text-sm text-gray-500'>
            {products.length} {products.length === 1 ? 'product' : 'products'} found
          </div>
        </div>

        {loading ? (
          <div className='flex justify-center items-center h-64'>
            <Loader />
          </div>
        ) : (
          <>
            {products.length === 0 ? (
              <div className='flex flex-col items-center justify-center h-64 text-gray-500'>
                <PackageX size={65} strokeWidth={1} />
                <p className='text-lg font-medium mt-4'>No products to show</p>
                <p className='text-sm mt-2'>Try adjusting your filters</p>
              </div>
            ) : (
              <div className='grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 lg:gap-6'>
                {displayProducts.map((prod, idx) => (
                  <ProductCard 
                    key={prod._id} 
                    idx={idx} 
                    {...prod}
                    spinResult={spinResult}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {/* Spin Wheel Modal */}
      <AnimatePresence>
        {showSpinWheel && (
          <SpinWheel 
            onSpinComplete={handleSpinComplete}
            onClose={() => setShowSpinWheel(false)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

export default Products