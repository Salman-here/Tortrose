import { motion, AnimatePresence } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import { Heart, ShoppingCart, Eye, Star, Zap, ChevronRight, Sparkles, Loader, Loader2, X } from "lucide-react";
import { useGlobal } from "../../contexts/GlobalContext";
import { useAuth } from "../../contexts/AuthContext";
import { useState } from "react";

const ProductCard = ({
  _id,
  name,
  image,
  images,
  category,
  price,
  discountedPrice,
  stock,
  rating,
  numReviews,
  isFeatured,
  idx,
  spinDiscountedPrice,
  hasSpinDiscount,
  spinResult
}) => {
  const {
    wishlistItems,
    handleAddToWishlist,
    handleDeleteFromWishlist,
    cartItems,
    handleAddToCart,
    isCartLoading,
    loadingProductId
  } = useGlobal();

  const { currentUser } = useAuth();
  const navigate = useNavigate();

  const [imageLoaded, setImageLoaded] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [activeImageIndex, setActiveImageIndex] = useState(0);

  const isInWishlist = wishlistItems?.some((item) => item._id === _id);
  const isInCart = cartItems?.cart?.some((item) => item.product._id === _id);

  // Determine which price to show
  const displayPrice = hasSpinDiscount ? spinDiscountedPrice : (discountedPrice || price);
  const originalDisplayPrice = hasSpinDiscount ? price : (discountedPrice ? price : null);

  const discountPercentage = originalDisplayPrice && displayPrice < originalDisplayPrice
    ? Math.round(((originalDisplayPrice - displayPrice) / originalDisplayPrice) * 100)
    : 0;

  // Handle wishlist toggle
  const handleWishlistToggle = () => {
    if (!currentUser) {
      navigate('/login');
      return;
    }
    if (isInWishlist) {
      handleDeleteFromWishlist(_id);
    } else {
      handleAddToWishlist(_id);
    }
  };

  // Handle add to cart with login check
  const handleAddToCartClick = () => {
    if (!currentUser) {
      navigate('/login');
      return;
    }
    handleAddToCart(_id);
  };

  // Animation variants
  const cardVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.4,
        ease: 'easeIn',
        delay: idx * 0.15 // Smooth ease-out
      }
    },
    hover: {
      y: -10,
      transition: {
        duration: 0.2,
        ease: "easeIn"
      }
    }
  };

  const badgeVariants = {
    hidden: { scale: 0, opacity: 0 },
    visible: {
      scale: 1,
      opacity: 1,
      transition: {
        type: "spring",
        stiffness: 500,
        damping: 15,
        duration: 0.4
      }
    }
  };

  const buttonVariants = {
    rest: {
      scale: 1,
      transition: {
        duration: 0.2,
        ease: "easeOut"
      }
    },
    hover: {
      scale: 1.05,
      transition: {
        type: "spring",
        stiffness: 400,
        damping: 17,
        duration: 0.3
      }
    },
    tap: {
      scale: 0.95,
      transition: {
        duration: 0.15
      }
    }
  };

  const imageVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        duration: 0.4,
        ease: "easeOut"
      }
    }
  };

  return (
    <motion.div
      variants={cardVariants}
      initial="hidden"
      animate="visible"
      whileHover="hover"
      onHoverStart={() => setIsHovered(true)}
      onHoverEnd={() => setIsHovered(false)}
      className="relative bg-white rounded-xl sm:rounded-2xl p-2 sm:p-3 md:p-4 shadow-sm hover:shadow-xl border border-gray-100 flex flex-col overflow-hidden group"
    // style={{
    //   background: "linear-gradient(to bottom, #ffffff, #fafafa)"
    // }}
    >
      {/* Subtle background highlight on hover */}
      <motion.div
        className="absolute inset-0 opacity-0 group-hover:opacity-100 pointer-events-none"
        initial={false}
        animate={{
          background: isHovered
            ? "radial-gradient(ellipse at center, rgba(99, 102, 241, 0.03) 0%, transparent 70%)"
            : "transparent"
        }}
        transition={{ duration: 0.4 }}
      />

      {/* Badges */}
      <div className="absolute top-1.5 left-1.5 sm:top-2 sm:left-2 md:top-3 md:left-3 z-2 flex flex-col items-start gap-1 sm:gap-1.5 md:gap-2">
        <AnimatePresence>
          {isFeatured && (
            <motion.span
              variants={badgeVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              className="px-1.5 py-0.5 sm:px-2 sm:py-1 bg-gradient-to-r from-purple-600 to-indigo-600 text-white text-[10px] sm:text-xs font-semibold rounded-full flex items-center gap-0.5 sm:gap-1 shadow-md"
            >
              <Zap size={8} className="sm:w-[10px] sm:h-[10px]" fill="currentColor" /> <span className="hidden sm:inline">Featured</span><span className="sm:hidden">⭐</span>
            </motion.span>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {hasSpinDiscount && spinResult && !spinResult.hasCheckedOut && (
            <motion.span
              variants={badgeVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              transition={{ delay: 0.1 }}
              className="px-1.5 py-0.5 sm:px-2 sm:py-1 bg-gradient-to-r from-yellow-500 to-orange-500 text-white text-[10px] sm:text-xs font-semibold rounded-full shadow-md animate-pulse"
            >
              🎉 <span className="hidden sm:inline">SPIN PRIZE!</span>
            </motion.span>
          )}
          {!hasSpinDiscount && discountPercentage > 0 && (
            <motion.span
              variants={badgeVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              transition={{ delay: 0.1 }}
              className="px-1.5 py-0.5 sm:px-2 sm:py-1 bg-gradient-to-r from-red-500 to-pink-500 text-white text-[10px] sm:text-xs font-semibold rounded-full shadow-md"
            >
              -{discountPercentage}%
            </motion.span>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {stock === 0 && (
            <motion.span
              variants={badgeVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              transition={{ delay: 0.2 }}
              className="px-1.5 py-0.5 sm:px-2 sm:py-1 bg-gray-600 text-white text-[10px] sm:text-xs font-semibold rounded-full shadow-md"
            >
              <span className="hidden sm:inline">Out of Stock</span><span className="sm:hidden">Sold</span>
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      {/* Action Buttons */}
      <motion.div
        className="absolute top-1.5 right-1.5 sm:top-2 sm:right-2 md:top-3 md:right-3 z-2 flex flex-col gap-1 sm:gap-1.5 md:gap-2"
        initial={{ opacity: 0, x: 10 }}
        animate={{
          opacity: isHovered ? 1 : 0.8,
          x: isHovered ? 0 : 5
        }}
        transition={{ duration: 0.3, ease: "easeOut" }}
      >
        <motion.button
          variants={buttonVariants}
          initial="rest"
          whileHover="hover"
          whileTap="tap"
          onClick={handleWishlistToggle}
          className={`p-1.5 sm:p-2 md:p-2.5 rounded-full shadow-md backdrop-blur-sm ${isInWishlist
            ? "bg-red-100 text-red-500"
            : "bg-white/90 text-gray-600 hover:bg-red-50 hover:text-red-500"
            } transition-colors`}
          title={isInWishlist ? "Remove from wishlist" : "Add to wishlist"}
        >
          <motion.div
            animate={{
              scale: isInWishlist ? [1, 1.2, 1] : 1
            }}
            transition={{ duration: 0.3 }}
          >
            <Heart
              size={14}
              className="sm:w-4 sm:h-4 md:w-[18px] md:h-[18px]"
              fill={isInWishlist ? "currentColor" : "none"}
            />
          </motion.div>
        </motion.button>

        <motion.button
          variants={buttonVariants}
          initial="rest"
          whileHover="hover"
          whileTap="tap"
          onClick={handleAddToCartClick}
          disabled={stock === 0}
          className={`p-1.5 sm:p-2 md:p-2.5 rounded-full shadow-md backdrop-blur-sm ${isInCart
            ? "bg-blue-100 text-blue-600"
            : "bg-white/90 text-gray-600 hover:bg-blue-50 hover:text-blue-600"
            } transition-colors`}
          title={isInCart ? "View in cart" : "Add to cart"}
        >
          <ShoppingCart
            size={14}
            className="sm:w-4 sm:h-4 md:w-[18px] md:h-[18px]"
            fill={isInCart ? "currentColor" : "none"}
          />
        </motion.button>

        <Link to={`/single-product/${_id}`}>
          <motion.button
            variants={buttonVariants}
            initial="rest"
            whileHover="hover"
            whileTap="tap"
            className="p-1.5 sm:p-2 md:p-2.5 bg-white/90 text-gray-600 rounded-full shadow-md backdrop-blur-sm hover:bg-gray-50 hover:text-gray-800 transition-colors"
            title="Quick view"
          >
            <Eye size={14} className="sm:w-4 sm:h-4 md:w-[18px] md:h-[18px]" />
          </motion.button>
        </Link>
      </motion.div>

      {/* Product Image */}
      <div className="relative overflow-hidden rounded-lg sm:rounded-xl mb-2 sm:mb-3 md:mb-4 aspect-square bg-gradient-to-br from-gray-100 to-gray-200">
        <Link to={`/single-product/${_id}`} className="block w-full h-full">
          <div className="relative w-full h-full flex items-center justify-center">
            <AnimatePresence mode="wait">
              <motion.img
                key={activeImageIndex}
                src={images?.[activeImageIndex]?.url || image}
                alt={name}
                className="w-full h-full object-contain"
                variants={imageVariants}
                initial="hidden"
                animate="visible"
                exit="hidden"
                onLoad={() => setImageLoaded(true)}
                onError={(e) => {
                  e.target.src = "https://via.placeholder.com/300x300?text=Image+Not+Found";
                }}
              />
            </AnimatePresence>

            {/* Loading shimmer effect */}
            {!imageLoaded && (
              <motion.div
                className="absolute inset-0 bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200 bg-[length:200%_100%]"
                animate={{
                  backgroundPosition: ['0% 0%', '100% 0%', '0% 0%'],
                }}
                transition={{
                  duration: 1.5,
                  ease: "linear",
                  repeat: Infinity,
                }}
              />
            )}

            {/* Image navigation if multiple images */}
            {images && images.length > 1 && (
              <div className="absolute bottom-2 left-1/2 transform -translate-x-1/2 flex gap-1.5">
                {images.map((_, index) => (
                  <button
                    key={index}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setActiveImageIndex(index);
                    }}
                    className={`w-2 h-2 rounded-full transition-all ${index === activeImageIndex
                      ? "bg-indigo-600 scale-125"
                      : "bg-white/80 hover:bg-white"
                      }`}
                  />
                ))}
              </div>
            )}

            {/* Out of stock overlay */}
            {stock === 0 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3 }}
                className="absolute inset-0 bg-black/50 flex items-center justify-center rounded-xl"
              >
                <span className="text-white font-semibold bg-black/70 px-3 py-2 rounded-lg backdrop-blur-sm">
                  Out of Stock
                </span>
              </motion.div>
            )}
          </div>
        </Link>
      </div>

      {/* Product Details */}
      <div className="flex flex-col flex-grow">
        <div className="mb-1 sm:mb-1.5 md:mb-2">
          <span className="text-[10px] sm:text-xs font-medium text-gray-500 uppercase tracking-wider">
            {category}
          </span>
        </div>

        <Link to={`/single-product/${_id}`}>
          <motion.h3
            className="font-semibold text-xs sm:text-sm md:text-base text-gray-900 mb-1 sm:mb-1.5 md:mb-2 line-clamp-2 hover:text-blue-600 transition-colors min-h-[2.5rem] sm:min-h-[3rem]"
            whileHover={{ x: 2 }}
            transition={{ type: "spring", stiffness: 500, damping: 15 }}
          >
            {name}
          </motion.h3>
        </Link>

        {/* Rating */}
        <div className="flex items-center gap-1 sm:gap-1.5 mb-2 sm:mb-2.5 md:mb-3">
          <div className="flex">
            {[...Array(5)].map((_, i) => (
              <motion.div
                key={i}
                whileHover={{ scale: 1.2, y: -2 }}
                transition={{ type: "spring", stiffness: 500, damping: 15 }}
              >
                <Star
                  size={10}
                  className={`sm:w-3 sm:h-3 md:w-[14px] md:h-[14px] ${i < Math.floor(rating || 0) ? "text-amber-400 fill-amber-400" : "text-gray-300"}`}
                />
              </motion.div>
            ))}
          </div>
          <span className="text-[10px] sm:text-xs text-gray-500 ml-0.5 sm:ml-1">
            ({rating?.toFixed(1) || 0})
          </span>
          <span className="text-[10px] sm:text-xs text-gray-400 hidden sm:inline">•</span>
          <span className="text-[10px] sm:text-xs text-gray-500 hidden sm:inline">
            {numReviews || 0} review{numReviews !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Price */}
        <div className="mt-auto flex items-center gap-1 sm:gap-1.5 md:gap-2 mb-2 sm:mb-3 md:mb-4">
          {hasSpinDiscount && spinResult && !spinResult.hasCheckedOut ? (
            <>
              <motion.span
                className="text-base sm:text-lg md:text-xl font-bold text-orange-600"
                initial={{ scale: 0.9 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 500, damping: 15 }}
              >
                ${displayPrice.toFixed(2)}
              </motion.span>
              <motion.span
                className="text-xs sm:text-sm text-gray-500 line-through"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.2, duration: 0.4 }}
              >
                ${price.toFixed(2)}
              </motion.span>
            </>
          ) : originalDisplayPrice ? (
            <>
              <motion.span
                className="text-base sm:text-lg md:text-xl font-bold text-gray-900"
                initial={{ scale: 0.9 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 500, damping: 15 }}
              >
                ${displayPrice.toFixed(2)}
              </motion.span>
              <motion.span
                className="text-xs sm:text-sm text-gray-500 line-through"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.2, duration: 0.4 }}
              >
                ${originalDisplayPrice.toFixed(2)}
              </motion.span>
            </>
          ) : (
            <span className="text-base sm:text-lg md:text-xl font-bold text-gray-900">
              ${displayPrice.toFixed(2)}
            </span>
          )}
        </div>

        {/* Add to cart button */}
        <motion.button
          variants={buttonVariants}
          initial="rest"
          whileHover={stock > 0 ? "hover" : ""}
          whileTap={stock > 0 ? "tap" : ""}
          onClick={() => stock > 0 && handleAddToCartClick()}
          disabled={stock === 0 || loadingProductId === _id}
          className={`relative py-2 sm:py-2.5 md:py-3 px-2 sm:px-3 md:px-4 rounded-lg sm:rounded-xl font-semibold text-center transition-colors overflow-hidden text-xs sm:text-sm md:text-base ${stock === 0
            ? "bg-gray-200 text-gray-500 cursor-not-allowed"
            : isInCart
              ? "bg-red-100 text-red-700 hover:bg-red-200"
              : "bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:from-blue-700 hover:to-indigo-700"
            }`}
        >
          {
            stock === 0 ? (
              <span className="hidden sm:inline">Out of Stock</span>
            ) :
              isCartLoading && loadingProductId === _id ? (
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3 }}
                  className="flex items-center justify-center gap-1 sm:gap-2"
                >
                  <span className="animate-spin"> <Loader2 size={14} className="sm:w-4 sm:h-4" /> </span>
                  <span className="hidden sm:inline">{isInCart ? 'Removing...' : 'Adding...'}</span>
                </motion.span>
              ) :


                isInCart ? (
                  <motion.span
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.3 }}
                    className="flex items-center justify-center gap-1 sm:gap-2"
                  >
                    <X size={14} className="sm:w-4 sm:h-4" /> <span className="hidden sm:inline">Remove</span>
                  </motion.span>
                ) : (
                  <motion.span
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.3 }}
                    className="flex items-center justify-center gap-1 sm:gap-2"
                  >
                    <ShoppingCart size={14} className="sm:w-4 sm:h-4" /> <span className="hidden sm:inline">Add to Cart</span><span className="sm:hidden">Add</span>
                  </motion.span>
                )
          }

          {/* Button shine effect on hover */}
          {stock > 0 && !isInCart && (
            <motion.span
              className="absolute inset-0 bg-white/20"
              initial={{ x: "-100%", opacity: 0 }}
              whileHover={{ x: "100%", opacity: 1 }}
              transition={{ duration: 0.6, ease: "easeInOut" }}
            />
          )}
        </motion.button>

        {/* View details link */}
        <motion.div
          className="mt-2 sm:mt-2.5 md:mt-3 flex justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: isHovered ? 1 : 0.7 }}
          transition={{ duration: 0.3 }}
        >
          <Link
            to={`/single-product/${_id}`}
            className="text-xs sm:text-sm text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-0.5 sm:gap-1 transition-colors"
          >
            <span className="hidden sm:inline">View details</span><span className="sm:hidden">Details</span>
            <motion.span
              animate={{ x: isHovered ? 3 : 0 }}
              transition={{ type: "spring", stiffness: 500, damping: 15 }}
            >
              <ChevronRight size={12} className="sm:w-[14px] sm:h-[14px]" />
            </motion.span>
          </Link>
        </motion.div>
      </div>
    </motion.div>
  );
};

export default ProductCard;