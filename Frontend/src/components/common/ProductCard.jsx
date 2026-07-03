import { Link, useNavigate } from "react-router-dom";
import { Heart, ShoppingCart, Eye, Star, Zap, ChevronRight, Loader2, X, Plus, Minus } from "lucide-react";
import { useGlobal } from "../../contexts/GlobalContext";
import { useAuth } from "../../contexts/AuthContext";
import { useCurrency } from "../../contexts/CurrencyContext";
import React, { useState, memo } from "react";
import { optimizeImage, buildSrcSet } from "../../utils/optimizeImage";
import { getStoreSubdomainUrl } from "../../utils/subdomainHelper";

const ProductCard = memo(({
  _id, name, image, images, category, price, discountedPrice, currency, priceCurrency,
  stock, rating, numReviews, isFeatured, idx, store, seller,
}) => {
  const { wishlistItems, handleAddToWishlist, handleDeleteFromWishlist, cartItems, handleAddToCart, handleQtyInc, handleQtyDec, isCartLoading, loadingProductId, qtyUpdateId } = useGlobal();
  const { currentUser } = useAuth();
  const { formatPrice } = useCurrency();
  const navigate = useNavigate();

  const [imageLoaded, setImageLoaded] = useState(false);
  const [activeImageIndex, setActiveImageIndex] = useState(0);

  const isInWishlist = wishlistItems?.some((item) => item?._id === _id);
  const cartItem = cartItems?.cart?.find((item) => item?.product?._id === _id);
  const isInCart = !!cartItem;
  const numericPrice = Number(price || 0);
  const numericDiscountedPrice = Number(discountedPrice || 0);
  const hasDiscount = numericDiscountedPrice > 0 && numericDiscountedPrice < numericPrice;
  const displayPrice = hasDiscount ? numericDiscountedPrice : numericPrice;
  const originalDisplayPrice = hasDiscount ? numericPrice : null;
  const productCurrency = currency || priceCurrency || 'USD';
  const discountPercentage = originalDisplayPrice && displayPrice < originalDisplayPrice
    ? Math.round(((originalDisplayPrice - displayPrice) / originalDisplayPrice) * 100) : 0;

  const handleWishlistToggle = () => {
    if (!currentUser) { navigate('/login'); return; }
    isInWishlist ? handleDeleteFromWishlist(_id) : handleAddToWishlist(_id);
  };

  const handleAddToCartClick = () => {
    handleAddToCart(_id);
  };

  // Handle product navigation - redirect to product's store subdomain if different
  const handleProductClick = (e) => {
    // Get store slug from populated seller.store or direct store prop
    const storeSlug = seller?.store?.storeSlug || store?.storeSlug || store?.slug;

    if (!storeSlug) {
      // No store found, navigate normally
      return;
    }

    const productUrl = getStoreSubdomainUrl(storeSlug);
    if (productUrl.startsWith('http')) {
      // Need to redirect to different subdomain
      e.preventDefault();
      window.location.href = `${productUrl}/single-product/${_id}`;
    }
    // Otherwise let Link handle it normally
  };

  return (
    <div
      className="relative glass-card water-shimmer p-1.5 sm:p-2 md:p-3 flex flex-col overflow-hidden group product-card-hover"
    >
      {/* Badges */}
      <div className="absolute top-1.5 left-1.5 sm:top-2 sm:left-2 md:top-3 md:left-3 z-[2] flex flex-col items-start gap-1 sm:gap-1.5">
        {isFeatured && (
          <span className="tag-pill text-[10px] sm:text-xs font-semibold flex items-center gap-0.5 shadow-md">
            <Zap size={8} fill="currentColor" /> <span className="hidden sm:inline">Featured</span><span className="sm:hidden">⭐</span>
          </span>
        )}
        {discountPercentage > 0 && (
          <span
            className="px-1.5 py-0.5 sm:px-2 sm:py-1 rounded-full text-[10px] sm:text-xs font-semibold shadow-md"
            style={{ background: 'hsl(var(--destructive))', color: 'white' }}>
            -{discountPercentage}%
          </span>
        )}
        {stock === 0 && (
          <span
            className="px-1.5 py-0.5 sm:px-2 sm:py-1 rounded-full text-[10px] sm:text-xs font-semibold shadow-md"
            style={{ background: 'rgba(0,0,0,0.6)', color: 'white' }}>
            <span className="hidden sm:inline">Out of Stock</span><span className="sm:hidden">Sold</span>
          </span>
        )}
      </div>

      {/* Action Buttons */}
      <div
        className="absolute top-1.5 right-1.5 sm:top-2 sm:right-2 md:top-3 md:right-3 z-[2] flex flex-col gap-1 sm:gap-1.5 opacity-0 group-hover:opacity-100 translate-x-2 group-hover:translate-x-0 transition-all duration-200"
      >
        {[
          { icon: <Heart size={14} className="sm:w-4 sm:h-4" fill={isInWishlist ? "currentColor" : "none"} />, onClick: handleWishlistToggle, active: isInWishlist, activeClass: 'text-red-500' },
          { icon: <ShoppingCart size={14} className="sm:w-4 sm:h-4" fill={isInCart ? "currentColor" : "none"} />, onClick: handleAddToCartClick, active: isInCart, activeClass: 'text-blue-500' },
        ].map((btn, i) => (
          <button key={i}
            onClick={btn.onClick}
            className={`p-1.5 sm:p-2 rounded-full glass-button transition-transform active:scale-90 hover:scale-110 ${btn.active ? btn.activeClass : ''}`}>
            {btn.icon}
          </button>
        ))}
        <Link to={`/single-product/${_id}`} onClick={handleProductClick}>
          <button
            className="p-1.5 sm:p-2 rounded-full glass-button transition-transform active:scale-90 hover:scale-110">
            <Eye size={14} className="sm:w-4 sm:h-4" />
          </button>
        </Link>
      </div>

      {/* Product Image */}
      <div className="relative overflow-hidden rounded-2xl mb-2 sm:mb-3 aspect-square glass-inner">
        <Link to={`/single-product/${_id}`} onClick={handleProductClick} className="block w-full h-full">
          <div className="relative w-full h-full flex items-center justify-center">
            <img
              key={activeImageIndex}
              src={optimizeImage(images?.[activeImageIndex]?.url || image, { width: 480 })}
              srcSet={buildSrcSet(images?.[activeImageIndex]?.url || image)}
              sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 240px"
              alt={name}
              loading={idx !== undefined && idx < 4 ? 'eager' : 'lazy'}
              fetchpriority={idx !== undefined && idx < 4 ? 'high' : 'auto'}
              decoding="async"
              width="300"
              height="300"
              className="w-full h-full object-contain transition-opacity duration-300"
              style={{ opacity: imageLoaded ? 1 : 0 }}
              onLoad={() => setImageLoaded(true)}
              onError={(e) => { e.target.onerror = null; e.target.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect width='300' height='300' fill='%23f3f4f6'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' font-family='sans-serif' font-size='18' fill='%239ca3af'%3EImage Not Found%3C/text%3E%3C/svg%3E"; }}
            />
            {!imageLoaded && (
              <div className="absolute inset-0 animate-pulse" style={{ background: 'rgba(255,255,255,0.08)' }} />
            )}
            {images && images.length > 1 && (
              <div className="absolute bottom-2 left-1/2 transform -translate-x-1/2 flex gap-1.5">
                {images.map((_, index) => (
                  <button key={index}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setActiveImageIndex(index); }}
                    className={`w-2 h-2 rounded-full transition-all ${index === activeImageIndex ? "scale-125" : "bg-white/60 hover:bg-white/80"}`}
                    style={index === activeImageIndex ? { background: 'hsl(var(--primary))' } : {}} />
                ))}
              </div>
            )}
            {stock === 0 && (
              <div className="absolute inset-0 bg-black/40 flex items-center justify-center rounded-2xl">
                <span className="text-white font-semibold px-3 py-2 rounded-xl" style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.15)' }}>Out of Stock</span>
              </div>
            )}
          </div>
        </Link>
      </div>

      {/* Product Details */}
      <div className="flex flex-col flex-grow">
        <span className="text-[10px] sm:text-xs font-medium uppercase tracking-wider mb-1"
          style={{ color: 'hsl(var(--muted-foreground))' }}>{category}</span>

        <Link to={`/single-product/${_id}`} onClick={handleProductClick}>
          <h3
            className="line-clamp-2 font-semibold text-xs sm:text-sm md:text-base mb-1 sm:mb-1.5 min-h-[2rem] sm:min-h-[2.5rem] md:min-h-[2.75rem] leading-snug break-words transition-colors"
            title={name}
            style={{ color: 'hsl(var(--foreground))' }}>
            {name}
          </h3>
        </Link>

        {/* Rating */}
        <div className="flex items-center gap-1 sm:gap-1.5 mb-2 sm:mb-2.5">
          <div className="flex">
            {[...Array(5)].map((_, i) => (
              <Star key={i} size={10} className={`sm:w-3 sm:h-3 ${i < Math.floor(rating || 0) ? "text-amber-400 fill-amber-400" : "text-slate-400/90"}`} />
            ))}
          </div>
          <span className="text-[10px] sm:text-xs ml-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>({rating?.toFixed(1) || 0})</span>
        </div>

        {/* Price */}
        <div className="mt-auto flex min-w-0 items-center gap-1 sm:gap-1.5 mb-2 sm:mb-3">
          {originalDisplayPrice ? (
            <>
              <span className="min-w-0 text-base sm:text-lg md:text-xl font-bold" style={{ color: 'hsl(var(--foreground))' }}>{formatPrice(displayPrice, { sourceCurrency: productCurrency })}</span>
              <span className="min-w-0 truncate text-xs sm:text-sm line-through" style={{ color: 'hsl(var(--muted-foreground))' }}>{formatPrice(originalDisplayPrice, { sourceCurrency: productCurrency })}</span>
            </>
          ) : (
            <span className="min-w-0 text-base sm:text-lg md:text-xl font-bold" style={{ color: 'hsl(var(--foreground))' }}>{formatPrice(displayPrice, { sourceCurrency: productCurrency })}</span>
          )}
        </div>

        {/* Add to cart button */}
        {isInCart && cartItem ? (
          <div className="flex items-center justify-between gap-2 py-1.5 px-2 rounded-xl glass-inner">
            <button
              onClick={() => handleQtyDec(cartItem._id)}
              disabled={qtyUpdateId === cartItem._id}
              className="p-1.5 rounded-lg glass-button transition active:scale-90 disabled:opacity-50"
              aria-label="Decrease quantity">
              {cartItem.qty <= 1 ? <X size={14} /> : <Minus size={14} />}
            </button>
            <span className="font-bold text-sm select-none" style={{ color: 'hsl(var(--foreground))' }}>
              {qtyUpdateId === cartItem._id ? <Loader2 size={14} className="animate-spin" /> : cartItem.qty}
            </span>
            <button
              onClick={() => handleQtyInc(cartItem._id)}
              disabled={qtyUpdateId === cartItem._id || cartItem.qty >= stock}
              className="p-1.5 rounded-lg transition active:scale-90 disabled:opacity-50"
              style={{ background: 'var(--logo-gradient)', color: 'white' }}
              aria-label="Increase quantity">
              <Plus size={14} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => stock > 0 && handleAddToCartClick()}
            disabled={stock === 0 || loadingProductId === _id}
            className={`relative py-2 sm:py-2.5 px-2 sm:px-3 rounded-xl font-semibold text-center text-xs sm:text-sm overflow-hidden transition-all active:scale-[0.98] hover:scale-[1.02] ${
              stock === 0 ? "glass-inner cursor-not-allowed opacity-50" : "glow-soft"
            }`}
            style={stock > 0 ? {
              background: 'var(--logo-gradient)',
              color: 'white',
              boxShadow: 'var(--logo-glow)',
            } : {}}
          >
            {stock === 0 ? <span>Out of Stock</span>
              : isCartLoading && loadingProductId === _id ? (
                <span className="flex items-center justify-center gap-1"><Loader2 size={14} className="animate-spin" /><span className="hidden sm:inline">Adding...</span></span>
              ) : (
                <span className="flex items-center justify-center gap-1"><ShoppingCart size={14} /> <span className="hidden sm:inline">Add to Cart</span><span className="sm:hidden">Add</span></span>
              )
            }
          </button>
        )}

        <div className="mt-2 flex justify-center opacity-60 group-hover:opacity-100 transition-opacity">
          <Link to={`/single-product/${_id}`} onClick={handleProductClick} className="text-xs sm:text-sm font-medium flex items-center gap-0.5 transition-colors"
            style={{ color: 'hsl(var(--primary))' }}>
            <span className="hidden sm:inline">View details</span><span className="sm:hidden">Details</span>
            <ChevronRight size={12} />
          </Link>
        </div>
      </div>
    </div>
  );
});

ProductCard.displayName = 'ProductCard';

export default ProductCard;
