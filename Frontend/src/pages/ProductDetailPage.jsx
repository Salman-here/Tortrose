import axios from 'axios';
import React, { useRef, useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Heart, ShoppingCart, Star, ChevronRight, ChevronLeft, Zap, Sparkles, Share, Clock, User, Shield, Truck, RotateCcw, Loader2 } from 'lucide-react';
import Loader from '../components/common/Loader';
import StoreInfo from '../components/common/StoreInfo';
import { toast } from 'react-toastify';
import { useGlobal } from '../contexts/GlobalContext';
import { useCurrency } from '../contexts/CurrencyContext';

function ProductDetailPage() {
    const { id } = useParams();
    const { getCurrencySymbol, convertPrice } = useCurrency();
    const {
        wishlistItems,
        handleAddToWishlist,
        handleDeleteFromWishlist,
        cartItems,
        handleAddToCart,
        fetchCart,
        isCartLoading,
        loadingProductId
    } = useGlobal();

    const [product, setProduct] = useState({});
    const [mainImg, setMainImg] = useState(null);
    const [selectedIdx, setSelectedIdx] = useState(0);
    const [loading, setLoading] = useState(true);
    const [rating, setRating] = useState(5);
    const [imageLoading, setImageLoading] = useState(true);
    const [activeImageTab, setActiveImageTab] = useState(0);
    const [storeData, setStoreData] = useState(null);
    const commentRef = useRef();

    const isInWishlist = product && wishlistItems?.some((item) => item._id === product._id);
    const isInCart = product && cartItems?.cart?.some((item) => item.product?._id === product._id);
    
    // SPIN WHEEL DISABLED - getSpinDiscount and getDiscountedPrice removed
    // const getSpinDiscount = () => { ... }
    // const getDiscountedPrice = () => { ... }

    const displayPrice = product.discountedPrice || product.price;
    const originalPrice = product.price;
    // const hasSpinDiscount = false; // SPIN WHEEL DISABLED

    const discountPercentage = product.discountedPrice && product.discountedPrice < product.price
        ? Math.round(((product.price - product.discountedPrice) / product.price) * 100)
        : 0;

    const handleImgShow = (idx) => {
        setMainImg(product.images[idx].url);
        setSelectedIdx(idx);
    };

    const handleNextImage = () => {
        const nextIndex = (selectedIdx + 1) % product.images.length;
        handleImgShow(nextIndex);
    };

    const handlePrevImage = () => {
        const prevIndex = (selectedIdx - 1 + product.images.length) % product.images.length;
        handleImgShow(prevIndex);
    };

    const handleRating = (star) => setRating(star);

    const handleAddReview = async (e) => {
        e.preventDefault();
        if (!commentRef.current.value.trim()) return toast.error('Please write a review comment');

        try {
            const token = localStorage.getItem('jwtToken');
            const res = await axios.post(
                `${import.meta.env.VITE_API_URL}api/products/add-review/${product._id}`,
                { rating, comment: commentRef.current.value },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            toast.success(res.data.msg);
            fetchProduct();
            setRating(5);
            commentRef.current.value = '';
        } catch (err) {
            toast.error(err.response?.data?.msg || 'Error adding review');
        }
    };

    const fetchProduct = async () => {
        setLoading(true);
        try {
            const res = await axios.get(
                `${import.meta.env.VITE_API_URL}api/products/get-single-product/${id}`
            );
            setProduct(res.data.product);
            setMainImg(res.data.product.image);
            setImageLoading(true);
            
            // Fetch seller's store data
            if (res.data.product.seller) {
                try {
                    const storeRes = await axios.get(
                        `${import.meta.env.VITE_API_URL}api/stores/seller/${res.data.product.seller}`
                    );
                    setStoreData(storeRes.data.store);
                } catch (error) {
                    // Store not found is okay - seller might not have configured one
                    console.log('No store configured for this seller');
                }
            }

        } catch (err) {
            toast.error('Product not found');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchProduct();
    }, [id]);

    // Animation variants
    const fadeIn = {
        hidden: { opacity: 0, y: 20 },
        visible: {
            opacity: 1,
            y: 0,
            transition: { duration: 0.5, ease: "easeOut" }
        }
    };

    const staggerChildren = {
        visible: {
            transition: {
                staggerChildren: 0.1
            }
        }
    };

    const imageVariants = {
        hidden: { opacity: 0, scale: 0.9 },
        visible: {
            opacity: 1,
            scale: 1,
            transition: { duration: 0.4, ease: "easeOut" }
        }
    };

    if (loading) return (
        <div className='h flex justify-center items-center'>
            <Loader />
        </div>
    );

    return (
        <motion.div
            className="min-h-screen py-8"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
        >
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                {/* Breadcrumb */}
                <motion.div
                    className="flex items-center text-sm text-slate-500 mb-6"
                    variants={fadeIn}
                    initial="hidden"
                    animate="visible"
                >
                    <Link to={'/'}>
                        <button className='flex hover:text-indigo-600 items-center'>
                            <span className=" cursor-pointer">Home</span>
                        </button>
                    </Link>
                    <ChevronRight size={16} className="mx-2" />
                    <span className="">{product.category}</span>
                    <ChevronRight size={16} className="mx-2" />
                    <span className="text-slate-800 font-medium truncate">{product.name}</span>
                </motion.div>

                {/* Product Card */}
                <motion.div
                    className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-md border border-white/60 overflow-hidden mb-10"
                    variants={fadeIn}
                    initial="hidden"
                    animate="visible"
                >
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 p-6 md:p-8">
                        {/* Images Section */}
                        <div className="flex flex-col">
                            {/* Main Image */}
                            <div className="relative h-80 md:h-96 bg-gray-100 rounded-xl overflow-hidden flex items-center justify-center">
                                <AnimatePresence mode="wait">
                                    <motion.img
                                        key={mainImg}
                                        src={mainImg}
                                        alt={product.name}
                                        className="max-h-full w-full object-contain"
                                        variants={imageVariants}
                                        initial="hidden"
                                        animate="visible"
                                        exit="hidden"
                                        onLoad={() => setImageLoading(false)}
                                        onError={(e) => {
                                            e.target.onerror = null; // Prevent infinite loop
                                            e.target.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='500' height='500'%3E%3Crect width='500' height='500' fill='%23f3f4f6'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' font-family='sans-serif' font-size='24' fill='%239ca3af'%3EImage Not Found%3C/text%3E%3C/svg%3E";
                                        }}
                                    />
                                </AnimatePresence>

                                {/* Loading shimmer */}
                                {imageLoading && (
                                    <motion.div
                                        className="absolute inset-0 bg-linear-to-r from-slate-200 via-slate-300 to-slate-200 bg-size-[200%_100%]"
                                        animate={{
                                            backgroundPosition: ['0% 0%', '100% 0%', '0% 0%'],
                                        }}
                                        transition={{
                                            duration: 1.5,
                                            repeat: Infinity,
                                        }}
                                    />
                                )}

                                {/* Navigation Arrows */}
                                {product.images && product.images.length > 1 && (
                                    <>
                                        <motion.button
                                            onClick={handlePrevImage}
                                            className="absolute left-3 top-1/2 transform -translate-y-1/2 bg-white/80 hover:bg-white rounded-full p-2 shadow-md backdrop-blur-sm"
                                            whileHover={{ scale: 1.1 }}
                                            whileTap={{ scale: 0.95 }}
                                        >
                                            <ChevronLeft size={20} />
                                        </motion.button>
                                        <motion.button
                                            onClick={handleNextImage}
                                            className="absolute right-3 top-1/2 transform -translate-y-1/2 bg-white/80 hover:bg-white rounded-full p-2 shadow-md backdrop-blur-sm"
                                            whileHover={{ scale: 1.1 }}
                                            whileTap={{ scale: 0.95 }}
                                        >
                                            <ChevronRight size={20} />
                                        </motion.button>
                                    </>
                                )}

                                {/* Badges */}
                                <div className="absolute top-3 left-3 flex flex-col gap-2">
                                    {product.isFeatured && (
                                        <motion.span
                                            initial={{ scale: 0 }}
                                            animate={{ scale: 1 }}
                                            transition={{ type: "spring", stiffness: 500, damping: 15 }}
                                            className="px-3 py-1 bg-linear-to-r from-indigo-500 to-sky-400 text-white text-xs font-semibold rounded-full flex items-center gap-1"
                                        >
                                            <Zap size={12} fill="currentColor" /> Featured
                                        </motion.span>
                                    )}
                                    {/* SPIN WHEEL DISABLED - spin prize badge removed */}
                                    {/* {hasSpinDiscount && (
                                        <motion.span ...>🎉 SPIN PRIZE!</motion.span>
                                    )} */}
                                    {discountPercentage > 0 && (
                                        <motion.span
                                            initial={{ scale: 0 }}
                                            animate={{ scale: 1 }}
                                            transition={{ type: "spring", stiffness: 500, damping: 15, delay: 0.1 }}
                                            className="px-3 py-1 bg-linear-to-r from-red-500 to-pink-500 text-white text-xs font-semibold rounded-full"
                                        >
                                            -{discountPercentage}% OFF
                                        </motion.span>
                                    )}
                                </div>
                            </div>

                            {/* Thumbnails */}
                            {product.images && product.images.length > 1 && (
                                <div className="flex gap-3 mt-4 overflow-x-auto py-2">
                                    {product.images.map((img, idx) => (
                                        <motion.button
                                            key={idx}
                                            onClick={() => handleImgShow(idx)}
                                            whileHover={{ scale: 1.05 }}
                                            whileTap={{ scale: 0.95 }}
                                            className={`shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 transition-all ${idx === selectedIdx
                                                ? 'border-indigo-400 shadow-md'
                                                : 'border-slate-200 hover:border-slate-300'
                                                }`}
                                        >
                                            <img
                                                src={img.url}
                                                alt={`Thumbnail ${idx + 1}`}
                                                className="w-full h-full object-cover"
                                            />
                                        </motion.button>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Product Info */}
                        <motion.div
                            className="flex flex-col"
                            variants={staggerChildren}
                            initial="hidden"
                            animate="visible"
                        >
                            <motion.h1
                                className="text-3xl md:text-4xl font-bold text-gray-900 mb-2"
                                variants={fadeIn}
                            >
                                {product.name}
                            </motion.h1>

                            <motion.div
                                className="flex items-center gap-3 mb-4"
                                variants={fadeIn}
                            >
                                <div className="flex items-center">
                                    {[...Array(5)].map((_, i) => (
                                        <Star
                                            key={i}
                                            size={18}
                                            className={i < Math.floor(product.rating || 0) ? "text-amber-400 fill-amber-400" : "text-gray-300"}
                                        />
                                    ))}
                                    <span className="ml-2 text-sm text-gray-600">
                                        ({product.numReviews || 0} reviews)
                                    </span>
                                </div>
                                <span className="w-1 h-1 bg-gray-400 rounded-full"></span>
                                <span className={`text-sm font-medium ${product.stock > 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    {product.stock > 0 ? `In Stock (${product.stock})` : 'Out of Stock'}
                                </span>
                            </motion.div>

                            <motion.div
                                className="mb-6"
                                variants={fadeIn}
                            >
                                {/* SPIN WHEEL DISABLED - spin discount badge removed */}
                                {/* {hasSpinDiscount && (<div className="mb-2"><span>🎉 Spin Discount Applied!</span></div>)} */}
                                {discountPercentage > 0 ? (
                                    <div className="flex items-center gap-3">
                                        <span className="text-3xl font-bold text-gray-900">
                                            {getCurrencySymbol()}{convertPrice(displayPrice).toFixed(2)}
                                        </span>
                                        <span className="text-xl text-gray-500 line-through">
                                            {getCurrencySymbol()}{convertPrice(originalPrice).toFixed(2)}
                                        </span>
                                        <span className="px-2 py-1 text-sm font-semibold rounded bg-red-100 text-red-700">
                                            Save {discountPercentage}%
                                        </span>
                                    </div>
                                ) : (
                                    <span className="text-3xl font-bold text-gray-900">
                                        {getCurrencySymbol()}{convertPrice(displayPrice).toFixed(2)}
                                    </span>
                                )}
                            </motion.div>

                            <motion.p
                                className="text-gray-600 mb-6 leading-relaxed"
                                variants={fadeIn}
                            >
                                {product.description}
                            </motion.p>

                            <motion.div
                                className="grid grid-cols-2 gap-4 mb-6"
                                variants={fadeIn}
                            >
                                {/* <div className="flex items-center gap-2 text-sm text-gray-600">
                                    <Shield size={18} className="text-blue-500" />
                                    <span>2 Year Warranty</span>
                                </div> */}
                                {/* <div className="flex items-center gap-2 text-sm text-gray-600">
                                    <Truck size={18} className="text-green-500" />
                                    <span>Free Shipping</span>
                                </div> */}
                                <div className="flex items-center gap-2 text-sm text-gray-600">
                                    <RotateCcw size={18} className="text-indigo-500" />
                                    <span>30-Day Returns</span>
                                </div>
                                {/* <div className="flex items-center gap-2 text-sm text-gray-600">
                                    <Clock size={18} className="text-amber-500" />
                                    <span>Delivery in 2-4 days</span>
                                </div> */}
                            </motion.div>

                            {product.tags && product.tags.length > 0 && (
                                <motion.div
                                    className="flex flex-wrap gap-2 mb-6"
                                    variants={fadeIn}
                                >
                                    {product.tags.map((tag) => (
                                        <span key={tag} className="px-3 py-1 bg-sky-50 text-sky-700 text-sm font-medium rounded-full border border-sky-100">
                                            {tag}
                                        </span>
                                    ))}
                                </motion.div>
                            )}

                            <motion.div
                                className="flex gap-3 mb-6"
                                variants={fadeIn}
                            >
                                <motion.button
                                    disabled={product.stock === 0 || isCartLoading || loadingProductId === id}
                                    onClick={() => { handleAddToCart(id) }}
                                    whileHover={product.stock > 0 ? { scale: 1.02 } : {}}
                                    whileTap={product.stock > 0 ? { scale: 0.98 } : {}}
                                    className={`flex-1 px-6 py-3 rounded-xl font-semibold flex items-center justify-center gap-2 transition-all ${product.stock === 0
                                        ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                                        : isInCart
                                            ? 'bg-green-100 text-green-700 hover:bg-green-200'
                                            : 'bg-linear-to-r from-indigo-600 to-sky-500 text-white hover:from-indigo-700 hover:to-sky-600'
                                        }`}
                                >
                                    {
                                        product.stock === 0 ? (
                                            "Out of Stock"
                                        ) :
                                            isCartLoading && loadingProductId === id ? (
                                                <motion.span
                                                    initial={{ opacity: 0 }}
                                                    animate={{ opacity: 1 }}
                                                    transition={{ duration: 0.3 }}
                                                    className=" flex items-center justify-center  gap-2"
                                                >
                                                    <span className="animate-spin"> <Loader2 /> </span> <span>Adding to Cart...</span>
                                                </motion.span>
                                            ) :


                                                isInCart ? (
                                                    <motion.span
                                                        initial={{ opacity: 0 }}
                                                        animate={{ opacity: 1 }}
                                                        transition={{ duration: 0.3 }}
                                                        className="flex items-center justify-center gap-2"
                                                    >
                                                        <Sparkles size={16} /> Added to Cart
                                                    </motion.span>
                                                ) : (
                                                    <motion.span
                                                        initial={{ opacity: 0 }}
                                                        animate={{ opacity: 1 }}
                                                        transition={{ duration: 0.3 }}
                                                        className="flex items-center justify-center gap-2"
                                                    >
                                                        <ShoppingCart size={16} /> Add to Cart
                                                    </motion.span>
                                                )
                                    }
                                </motion.button>

                                <motion.button
                                    disabled={product.stock === 0}
                                    onClick={() => {
                                        if (isInWishlist) {
                                            handleDeleteFromWishlist(product._id);
                                        } else {
                                            handleAddToWishlist(product._id);
                                        }
                                    }}
                                    whileHover={product.stock > 0 ? { scale: 1.05 } : {}}
                                    whileTap={product.stock > 0 ? { scale: 0.95 } : {}}
                                    className={`p-3 rounded-xl font-semibold flex items-center justify-center transition-all ${product.stock === 0
                                        ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                                        : isInWishlist
                                            ? 'bg-red-100 text-red-600'
                                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                        }`}
                                >
                                    <Heart
                                        size={20}
                                        fill={isInWishlist ? "currentColor" : "none"}
                                    />
                                </motion.button>


                            </motion.div>

                            {/* Store Info */}
                            <motion.div
                                className="my-6"
                                variants={fadeIn}
                            >
                                <StoreInfo
                                    storeName={storeData?.storeName}
                                    storeSlug={storeData?.storeSlug}
                                    storeLogo={storeData?.logo}
                                    sellerUsername={product.seller?.username}
                                    storeId={storeData?._id}
                                    trustCount={storeData?.trustCount}
                                    verification={storeData?.verification}
                                />
                            </motion.div>

                            <motion.div
                                className="border-t pt-4"
                                variants={fadeIn}
                            >
                                <div className="flex items-center gap-2 text-sm text-gray-500">
                                    <span>Category:</span>
                                    <span className="font-medium text-gray-700">{product.category}</span>
                                </div>
                                <div className="flex items-center gap-2 text-sm text-gray-500">
                                    <span>Brand:</span>
                                    <span className="font-medium text-gray-700">{product.brand}</span>
                                </div>
                            </motion.div>
                        </motion.div>
                    </div>
                </motion.div>

                {/* Reviews Section */}
                <motion.div
                    className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-md border border-white/60 overflow-hidden p-6 md:p-8"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.2 }}
                >
                    <h2 className="text-2xl font-bold text-gray-900 mb-6">Customer Reviews</h2>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                        {/* Add Review */}
                        <motion.div
                            className="bg-white/60 backdrop-blur-sm p-6 rounded-xl border border-white/50"
                            initial={{ opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ duration: 0.5, delay: 0.3 }}
                        >
                            <h3 className="text-lg font-semibold text-gray-800 mb-4">Add Your Review</h3>

                            <form onSubmit={handleAddReview} className="space-y-4">
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">Your Rating</label>
                                    <div className="flex gap-1">
                                        {[1, 2, 3, 4, 5].map((star) => (
                                            <motion.button
                                                key={star}
                                                type="button"
                                                onClick={() => handleRating(star)}
                                                whileHover={{ scale: 1.2 }}
                                                whileTap={{ scale: 0.9 }}
                                                className="p-1"
                                            >
                                                <Star
                                                    size={28}
                                                    className={star <= rating ? "text-amber-400 fill-amber-400" : "text-gray-300"}
                                                />
                                            </motion.button>
                                        ))}
                                    </div>
                                </div>

                                <div>
                                    <label htmlFor="comment" className="block text-sm font-medium text-gray-700 mb-2">Your Review</label>
                                    <textarea
                                        ref={commentRef}
                                        id="comment"
                                        rows="4"
                                        className="w-full px-4 py-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 bg-white/70 transition-colors"
                                        placeholder="Share your experience with this product..."
                                    />
                                </div>

                                <motion.button
                                    type="submit"
                                    whileHover={{ scale: 1.02 }}
                                    whileTap={{ scale: 0.98 }}
                                    className="w-full bg-linear-to-r from-indigo-600 to-sky-500 hover:from-indigo-700 hover:to-sky-600 text-white font-semibold py-3 px-4 rounded-lg transition-all shadow-md shadow-indigo-300/30"
                                >
                                    Submit Review
                                </motion.button>
                            </form>
                        </motion.div>

                        {/* Existing Reviews */}
                        <div>
                            <h3 className="text-lg font-semibold text-gray-800 mb-4">
                                {product.reviews?.length || 0} Review{product.reviews?.length !== 1 ? 's' : ''}
                            </h3>

                            <div className="space-y-5 max-h-96 overflow-y-auto pr-2">
                                <AnimatePresence>
                                    {product.reviews && product.reviews.length > 0 ? (
                                        product.reviews.map((review, index) => {
                                            const date = new Date(review.createdAt);
                                            return (
                                                <motion.div
                                                    key={review._id || index}
                                                    initial={{ opacity: 0, y: 10 }}
                                                    animate={{ opacity: 1, y: 0 }}
                                                    exit={{ opacity: 0, y: -10 }}
                                                    transition={{ duration: 0.3, delay: index * 0.1 }}
                                                    className="bg-white/70 backdrop-blur-sm p-4 rounded-lg border border-white/60 shadow-sm"
                                                >
                                                    <div className="flex items-start gap-3">
                                                        <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center">
                                                            <img className='rounded-full' src={review.user.avatar || 'https://res.cloudinary.com/dus5sac8g/image/upload/v1756983317/Profile_Picture_dxq4w8.jpg'} alt="" />
                                                        </div>
                                                        <div className="flex-1">
                                                            <div className="flex items-center gap-2 mb-1">
                                                                <span className="font-medium text-gray-900">{review.user?.username || 'Anonymous'}</span>
                                                                <div className="flex gap-1">
                                                                    {[...Array(5)].map((_, i) => (
                                                                        <Star
                                                                            key={i}
                                                                            size={14}
                                                                            className={i < review.rating ? "text-amber-400 fill-amber-400" : "text-gray-300"}
                                                                        />
                                                                    ))}
                                                                </div>
                                                            </div>
                                                            <div className="text-xs text-gray-500 mb-2">
                                                                {date.toLocaleDateString()} at {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                            </div>
                                                            <p className="text-gray-700">{review.comment}</p>
                                                        </div>
                                                    </div>
                                                </motion.div>
                                            );
                                        })
                                    ) : (
                                        <motion.div
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                            className="text-center py-10 text-gray-500"
                                        >
                                            <Star size={40} className="mx-auto text-gray-300 mb-3" />
                                            <p>No reviews yet. Be the first to review this product!</p>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        </div>
                    </div>
                </motion.div>
            </div>
        </motion.div>
    );
}

export default ProductDetailPage;