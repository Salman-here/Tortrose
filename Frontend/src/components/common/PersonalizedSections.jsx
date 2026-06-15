import React, { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Link } from 'react-router-dom'
import { Sparkles, TrendingUp, DollarSign, Clock, Gift, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react'
import axios from 'axios'
import { useAuth } from '../../contexts/AuthContext'
import { useCurrency } from '../../contexts/CurrencyContext'
import { useBuyerLocation } from '../../contexts/BuyerLocationContext'
import { getStoreSubdomainUrl } from '../../utils/subdomainHelper'
import {
  addRecentlyViewedProduct,
  clearRecentlyViewedProducts,
  readRecentlyViewedProductIds,
  writeRecentlyViewedProductIds,
} from '../../utils/recentlyViewedProducts'

const SliderProductCard = ({ product, formatPrice }) => {
  const productPrice = Number(product.price || 0)
  const discountedPrice = Number(product.discountedPrice || 0)
  const hasDiscount = discountedPrice > 0 && discountedPrice < productPrice
  const displayPrice = hasDiscount ? discountedPrice : productPrice
  const productCurrency = product.currency || product.priceCurrency || 'USD'
  const discountPercentage = hasDiscount
    ? Math.round(((productPrice - discountedPrice) / productPrice) * 100)
    : 0

  // Handle product navigation - redirect to product's store subdomain
  const handleProductClick = (e) => {
    // Get store slug from populated seller.store
    const storeSlug = product.seller?.store?.storeSlug;

    if (!storeSlug) {
      // No store found, navigate normally
      return;
    }

    const productUrl = getStoreSubdomainUrl(storeSlug);
    if (productUrl.startsWith('http')) {
      // Need to redirect to different subdomain
      e.preventDefault();
      window.location.href = `${productUrl}/single-product/${product._id}`;
    }
    // Otherwise let Link handle it normally
  };

  return (
    <motion.div
      whileHover={{ y: -6, scale: 1.02 }}
      transition={{ duration: 0.25 }}
      className="w-[155px] xs:w-[188px] sm:w-[208px] lg:w-[224px] xl:w-[236px] shrink-0 snap-start"
    >
      <Link to={`/single-product/${product._id}`} onClick={handleProductClick} className="block h-full">
        <article className="glass-card h-full overflow-hidden p-2 sm:p-2.5">
          <div className="relative overflow-hidden rounded-[1.25rem] glass-inner aspect-[4/4.8]">
            <img
              src={product.images?.[0]?.url || product.image}
              alt={product.name}
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-500 group-hover/card:scale-105"
            />

            {discountPercentage > 0 && (
              <span
                className="absolute left-2 top-2 rounded-full px-2 py-1 text-[10px] font-bold"
                style={{ background: 'hsl(var(--destructive))', color: 'hsl(var(--destructive-foreground))' }}
              >
                -{discountPercentage}%
              </span>
            )}

            <div className="absolute inset-x-0 bottom-0 p-2">
              <span
                className="inline-flex max-w-full rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]"
                style={{
                  background: 'hsl(var(--background) / 0.78)',
                  color: 'hsl(var(--muted-foreground))',
                  border: '1px solid hsl(var(--border) / 0.65)',
                  backdropFilter: 'blur(12px)',
                }}
              >
                <span className="truncate">{product.category}</span>
              </span>
            </div>
          </div>

          <div className="flex h-[116px] flex-col justify-between px-1 pb-1 pt-3">
            <div>
              <h3 className="line-clamp-2 text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                {product.name}
              </h3>
              <p className="mt-1 text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                {product.numReviews || 0} reviews • {product.stock > 0 ? `${product.stock} in stock` : 'Out of stock'}
              </p>
            </div>

            <div className="flex items-end justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-base font-bold" style={{ color: 'hsl(var(--foreground))' }}>
                  {formatPrice(displayPrice, { sourceCurrency: productCurrency })}
                </p>
                {hasDiscount && (
                  <p className="truncate text-xs line-through" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {formatPrice(product.price, { sourceCurrency: productCurrency })}
                  </p>
                )}
              </div>
              <span className="text-xs font-semibold" style={{ color: 'hsl(var(--primary))' }}>
                View →
              </span>
            </div>
          </div>
        </article>
      </Link>
    </motion.div>
  )
}

const ProductSlider = ({ products, formatPrice }) => {
  const scrollRef = useRef(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(true)
  const [isDragging, setIsDragging] = useState(false)
  const [startX, setStartX] = useState(0)
  const [scrollLeftStart, setScrollLeftStart] = useState(0)

  const checkScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 4)
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 4)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    checkScroll()
    el.addEventListener('scroll', checkScroll, { passive: true })
    window.addEventListener('resize', checkScroll)
    return () => {
      el.removeEventListener('scroll', checkScroll)
      window.removeEventListener('resize', checkScroll)
    }
  }, [checkScroll, products])

  const scroll = (direction) => {
    const el = scrollRef.current
    if (!el) return
    const scrollAmount = Math.max(el.clientWidth * 0.82, 320)
    el.scrollBy({ left: direction * scrollAmount, behavior: 'smooth' })
  }

  const handleWheel = (e) => {
    const el = scrollRef.current
    if (!el || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    e.preventDefault()
    el.scrollBy({ left: e.deltaY, behavior: 'smooth' })
  }

  const handleMouseDown = (e) => {
    setIsDragging(true)
    setStartX(e.pageX - scrollRef.current.offsetLeft)
    setScrollLeftStart(scrollRef.current.scrollLeft)
  }
  const handleMouseMove = (e) => {
    if (!isDragging) return
    e.preventDefault()
    const x = e.pageX - scrollRef.current.offsetLeft
    const walk = (x - startX) * 1.5
    scrollRef.current.scrollLeft = scrollLeftStart - walk
  }
  const handleMouseUp = () => setIsDragging(false)

  return (
    <div className="relative group/slider">
      <AnimatePresence>
        {canScrollLeft && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            onClick={() => scroll(-1)}
            className="absolute -left-3 sm:-left-4 top-1/2 -translate-y-1/2 z-10 w-9 h-9 sm:w-11 sm:h-11 rounded-full flex items-center justify-center shadow-xl cursor-pointer"
            style={{
              background: 'hsl(var(--background))',
              border: '1px solid hsl(var(--border))',
              boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
            }}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.95 }}
          >
            <ChevronLeft size={18} style={{ color: 'hsl(var(--foreground))' }} />
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {canScrollRight && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            onClick={() => scroll(1)}
            className="absolute -right-3 sm:-right-4 top-1/2 -translate-y-1/2 z-10 w-9 h-9 sm:w-11 sm:h-11 rounded-full flex items-center justify-center shadow-xl cursor-pointer"
            style={{
              background: 'hsl(var(--background))',
              border: '1px solid hsl(var(--border))',
              boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
            }}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.95 }}
          >
            <ChevronRight size={18} style={{ color: 'hsl(var(--foreground))' }} />
          </motion.button>
        )}
      </AnimatePresence>

      {canScrollLeft && (
        <div className="absolute left-0 top-0 bottom-0 w-8 sm:w-16 z-[5] pointer-events-none"
          style={{ background: 'linear-gradient(to right, hsl(var(--background) / 0.9), transparent)' }} />
      )}
      {canScrollRight && (
        <div className="absolute right-0 top-0 bottom-0 w-8 sm:w-16 z-[5] pointer-events-none"
          style={{ background: 'linear-gradient(to left, hsl(var(--background) / 0.9), transparent)' }} />
      )}

      <div
        ref={scrollRef}
        className={`flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 scroll-smooth px-1 sm:gap-4 ${isDragging ? 'cursor-grabbing select-none' : 'cursor-grab'}`}
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none', WebkitOverflowScrolling: 'touch' }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <style>{`.group\\/slider div::-webkit-scrollbar { display: none; }`}</style>
        {products.map((product) => (
          <div key={product._id} className="shrink-0">
            <SliderProductCard product={product} formatPrice={formatPrice} />
          </div>
        ))}
      </div>
    </div>
  )
}

const CollapsibleSection = ({ icon: Icon, title, subtitle, color, bgStyle, action, children }) => {
  const [open, setOpen] = useState(false)
  return (
    <section className="glass-panel overflow-hidden rounded-2xl" style={bgStyle}>
      <div className="w-full flex items-center gap-2 p-4 sm:p-6 pb-3">
        <button
          type="button"
          onClick={() => setOpen(prev => !prev)}
          className="min-w-0 flex flex-1 items-center justify-between cursor-pointer select-none text-left"
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="glass-inner p-2 rounded-xl" style={{ background: `${color}15` }}>
              <Icon size={20} style={{ color }} />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg sm:text-xl font-bold">{title}</h2>
              {subtitle && (
                <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{subtitle}</p>
              )}
            </div>
          </div>
          <motion.div animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.25 }}>
            <ChevronDown size={18} style={{ color: 'hsl(var(--muted-foreground))' }} />
          </motion.div>
        </button>
        {action && (
          <div className="shrink-0 pl-1">
            {action}
          </div>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="px-4 sm:px-6 pb-4 sm:pb-6">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}

const PersonalizedSections = () => {
  const { currentUser } = useAuth()
  const { formatPrice } = useCurrency()
  const { appendLocationParams } = useBuyerLocation()

  const [pickedForYou, setPickedForYou] = useState([])
  const [trending, setTrending] = useState([])
  const [priceDrops, setPriceDrops] = useState([])
  const [recentlyViewed, setRecentlyViewed] = useState([])
  const [loading, setLoading] = useState(true)

  const fetchPersonalizedData = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: '50', sortBy: 'relevance', sortOrder: 'desc' })
      appendLocationParams(params)
      const res = await axios.get(`${import.meta.env.VITE_API_URL}api/products/get-products?${params.toString()}`)
      const allProducts = res.data.products || []

      const viewedIds = readRecentlyViewedProductIds()
      const productById = new Map(allProducts.map(product => [product._id, product]))

      const missingViewedIds = viewedIds.filter(productId => !productById.has(productId))
      if (missingViewedIds.length > 0) {
        const recentlyViewedParams = new URLSearchParams({
          ids: missingViewedIds.join(','),
          limit: String(Math.max(missingViewedIds.length, 1)),
        })
        appendLocationParams(recentlyViewedParams)
        const recentlyViewedRes = await axios.get(
          `${import.meta.env.VITE_API_URL}api/products/get-products?${recentlyViewedParams.toString()}`
        )
        const recentlyViewedProducts = recentlyViewedRes.data.products || []
        recentlyViewedProducts.forEach((product) => {
          if (product?._id) productById.set(product._id, product)
        })
      }

      const availableViewedIds = viewedIds.filter(productId => productById.has(productId))
      if (availableViewedIds.length !== viewedIds.length) {
        writeRecentlyViewedProductIds(availableViewedIds, { notify: false })
      }

      const viewed = availableViewedIds
        .map(productId => productById.get(productId))
        .filter(Boolean)
        .slice(0, 10)
      setRecentlyViewed(viewed)

      const preferredCategories = [...new Set(viewed.map(p => p.category))]
      const preferredBrands = [...new Set(viewed.map(p => p.brand))]

      let picked = []
      if (preferredCategories.length > 0) {
        picked = allProducts
          .filter(p => preferredCategories.includes(p.category) || preferredBrands.includes(p.brand))
          .filter(p => !viewedIds.includes(p._id))
          .slice(0, 12)
      }
      if (picked.length < 4) {
        const randomPicks = allProducts
          .filter(p => !picked.find(pp => pp._id === p._id))
          .sort(() => Math.random() - 0.5)
          .slice(0, 12 - picked.length)
        picked = [...picked, ...randomPicks]
      }
      setPickedForYou(picked)

      const trendingProducts = [...allProducts]
        .sort((a, b) => (b.numReviews * b.rating) - (a.numReviews * a.rating))
        .slice(0, 12)
      setTrending(trendingProducts)

      const discounted = allProducts
        .filter(p => p.discountedPrice > 0 && p.discountedPrice < p.price)
        .sort((a, b) => {
          const discountA = ((a.price - a.discountedPrice) / a.price) * 100
          const discountB = ((b.price - b.discountedPrice) / b.price) * 100
          return discountB - discountA
        })
        .slice(0, 12)
      setPriceDrops(discounted)
    } catch (error) {
      console.error('Error fetching personalized data:', error)
    } finally {
      setLoading(false)
    }
  }, [appendLocationParams])

  useEffect(() => {
    fetchPersonalizedData()
  }, [currentUser, fetchPersonalizedData])

  useEffect(() => {
    const trackView = (productId) => {
      addRecentlyViewedProduct(productId)
    }
    window.trackProductView = trackView
  }, [])

  useEffect(() => {
    const refreshRecentlyViewed = (event) => {
      if (event?.type === 'storage' && event.key && event.key !== 'viewedProducts') return
      fetchPersonalizedData()
    }
    window.addEventListener('rozare:recentlyViewedChanged', refreshRecentlyViewed)
    window.addEventListener('storage', refreshRecentlyViewed)
    return () => {
      window.removeEventListener('rozare:recentlyViewedChanged', refreshRecentlyViewed)
      window.removeEventListener('storage', refreshRecentlyViewed)
    }
  }, [fetchPersonalizedData])

  const handleClearRecentlyViewed = () => {
    clearRecentlyViewedProducts()
    setRecentlyViewed([])
  }

  const hasSections = pickedForYou.length > 0 || priceDrops.length > 0 || trending.length > 0 || recentlyViewed.length > 0;

  if (!hasSections && !loading) return null;

  return (
    <div className="space-y-6 sm:space-y-8">
      {loading ? (
        [1, 2, 3].map(i => (
          <section key={i} className="glass-panel overflow-hidden rounded-2xl p-4 sm:p-6 animate-pulse">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-white/10" />
              <div className="space-y-2">
                <div className="h-4 w-40 rounded bg-white/10" />
                <div className="h-3 w-56 rounded bg-white/10" />
              </div>
            </div>
          </section>
        ))
      ) : (
        <>
          {pickedForYou.length > 0 && (
            <CollapsibleSection icon={Sparkles} title="Picked for You" subtitle={currentUser ? "Based on your interests" : "Products you might love"} color="hsl(280, 70%, 60%)">
              <ProductSlider products={pickedForYou} formatPrice={formatPrice} />
            </CollapsibleSection>
          )}
          {priceDrops.length > 0 && (
            <CollapsibleSection icon={DollarSign} title="Price Drops" subtitle="Hot deals on watched items" color="hsl(0, 70%, 55%)" bgStyle={{ background: 'rgba(239, 68, 68, 0.05)' }}>
              <ProductSlider products={priceDrops} formatPrice={formatPrice} />
            </CollapsibleSection>
          )}
          {trending.length > 0 && (
            <CollapsibleSection icon={TrendingUp} title="Trending Now" subtitle="Most popular products" color="hsl(150, 60%, 45%)">
              <ProductSlider products={trending} formatPrice={formatPrice} />
            </CollapsibleSection>
          )}
          {recentlyViewed.length > 0 && (
            <CollapsibleSection
              icon={Clock}
              title="Recently Viewed"
              subtitle="Continue where you left off"
              color="hsl(200, 80%, 55%)"
              action={(
                <button
                  type="button"
                  onClick={handleClearRecentlyViewed}
                  className="rounded-full px-3 py-1.5 text-xs font-semibold transition hover:scale-[1.03]"
                  style={{
                    background: 'hsl(var(--background) / 0.72)',
                    border: '1px solid hsl(var(--border) / 0.75)',
                    color: 'hsl(var(--muted-foreground))',
                    backdropFilter: 'blur(12px)',
                  }}
                >
                  Clear
                </button>
              )}
            >
              <ProductSlider products={recentlyViewed} formatPrice={formatPrice} />
            </CollapsibleSection>
          )}
          {pickedForYou.length > 4 && (
            <CollapsibleSection icon={Gift} title="Gift Ideas" subtitle="Perfect presents for loved ones" color="hsl(330, 80%, 60%)" bgStyle={{ background: 'rgba(236, 72, 153, 0.05)' }}>
              <ProductSlider products={pickedForYou.slice(0, 6).sort(() => Math.random() - 0.5)} formatPrice={formatPrice} />
            </CollapsibleSection>
          )}
        </>
      )}
    </div>
  )
}

export default PersonalizedSections
