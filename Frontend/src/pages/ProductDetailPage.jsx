import axios from 'axios';
import React, { useRef, useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Heart, ShoppingCart, Star, ChevronRight, ChevronLeft, Zap, Sparkles, Share2, RotateCcw, Loader2, Home, Tag, Package } from 'lucide-react';
import Loader from '../components/common/Loader';
import StoreInfo from '../components/common/StoreInfo';
import SEOHead from '../components/common/SEOHead';
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
    const [storeData, setStoreData] = useState(null);
    const commentRef = useRef();

    const isInWishlist = product && wishlistItems?.some((item) => item._id === product._id);
    const isInCart = product && cartItems?.cart?.some((item) => item.product?._id === product._id);

    const displayPrice = product.discountedPrice || product.price;
    const originalPrice = product.price;

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
            if (res.data.product.seller) {
                try {
                    const storeRes = await axios.get(
                        `${import.meta.env.VITE_API_URL}api/stores/seller/${res.data.product.seller}`
                    );
                    setStoreData(storeRes.data.store);
                } catch (error) {
                    console.log('No store configured for this seller');
                }
            }
        } catch (err) {
            toast.error('Product not found');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { fetchProduct(); }, [id]);

    const fadeIn = {
        hidden: { opacity: 0, y: 20 },
        visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" } }
    };

    const staggerChildren = {
        visible: { transition: { staggerChildren: 0.1 } }
    };

    const imageVariants = {
        hidden: { opacity: 0, scale: 0.95 },
        visible: { opacity: 1, scale: 1, transition: { duration: 0.4, ease: "easeOut" } }
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
                <SEOHead
                    title={product.name}
                    description={product.description?.slice(0, 155) || `Buy ${product.name} on Tortrose.`}
                    canonical={`/product/${id}`}
                    ogType="product"
                    ogImage={product.image}
                    jsonLd={{
                        "@context": "https://schema.org",
                        "@type": "Product",
                        "name": product.name,
                        "description": product.description,
                        "image": product.image,
                        "offers": {
                            "@type": "Offer",
                            "price": product.discountedPrice || product.price,
                            "priceCurrency": "USD",
                            "availability": product.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock"
                        },
                        ...(product.rating && {
                            "aggregateRating": {
                                "@type": "AggregateRating",
                                "ratingValue": product.rating,
                                "reviewCount": product.numReviews || 0
                            }
                        })
                    }}
                />
                {/* Breadcrumb */}
                <motion.div
                    className="flex items-center text-sm mb-6"
                    style={{ color: 'hsl(var(--muted-foreground))' }}
                    variants={fadeIn}
                    initial="hidden"
                    animate="visible"
                >
                    <Link to="/" className="flex items-center gap-1 transition-colors hover:text-[hsl(220,70%,55%)]">
                        <Home size={15} />
                        <span>Home</span>
                    </Link>
                    <ChevronRight size={14} className="mx-1.5 opacity-50" />
                    <span>{product.category}</span>
                    <ChevronRight size={14} className="mx-1.5 opacity-50" />
                    <span className="font-medium truncate" style={{ color: 'hsl(var(--foreground))' }}>{product.name}</span>
                </motion.div>

                {/* Product Card */}
                <motion.div
                    className="glass-panel-strong water-shimmer relative overflow-hidden mb-10"
                    variants={fadeIn}
                    initial="hidden"
                    animate="visible"
                >
                    {/* Decorative orbs */}
                    <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full opacity-20 blur-3xl pointer-events-none"
                         style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))' }} />
                    <div className="absolute -bottom-16 -left-16 w-40 h-40 rounded-full opacity-15 blur-3xl pointer-events-none"
                         style={{ background: 'linear-gradient(135deg, hsl(200, 80%, 55%), hsl(170, 70%, 45%))' }} />

                    <div className="relative grid grid-cols-1 lg:grid-cols-2 gap-8 p-6 md:p-8">
                        {/* Images Section */}
                        <div className="flex flex-col">
                            {/* Main Image */}
                            <div className="relative h-80 md:h-96 glass-inner rounded-2xl overflow-hidden flex items-center justify-center">
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
                                            e.target.onerror = null;
                                            e.target.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='500' height='500'%3E%3Crect width='500' height='500' fill='%23f3f4f6'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' font-family='sans-serif' font-size='24' fill='%239ca3af'%3EImage Not Found%3C/text%3E%3C/svg%3E";
                                        }}
                                    />
                                </AnimatePresence>

                                {/* Loading shimmer */}
                                {imageLoading && (
                                    <motion.div
                                        className="absolute inset-0 rounded-2xl"
                                        style={{ background: 'linear-gradient(90deg, rgba(255,255,255,0.05), rgba(255,255,255,0.15), rgba(255,255,255,0.05))', backgroundSize: '200% 100%' }}
                                        animate={{ backgroundPosition: ['0% 0%', '100% 0%', '0% 0%'] }}
                                        transition={{ duration: 1.5, repeat: Infinity }}
                                    />
                                )}

                                {/* Navigation Arrows */}
                                {product.images && product.images.length > 1 && (
                                    <>
                                        <motion.button
                                            onClick={handlePrevImage}
                                            className="absolute left-3 top-1/2 -translate-y-1/2 glass-button p-2 rounded-full"
                                            whileHover={{ scale: 1.1 }}
                                            whileTap={{ scale: 0.95 }}
                                        >
                                            <ChevronLeft size={20} />
                                        </motion.button>
                                        <motion.button
                                            onClick={handleNextImage}
                                            className="absolute right-3 top-1/2 -translate-y-1/2 glass-button p-2 rounded-full"
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
                                            className="tag-pill flex items-center gap-1"
                                        >
                                            <Zap size={12} fill="currentColor" /> Featured
                                        </motion.span>
                                    )}
                                    {discountPercentage > 0 && (
                                        <motion.span
                                            initial={{ scale: 0 }}
                                            animate={{ scale: 1 }}
                                            transition={{ type: "spring", stiffness: 500, damping: 15, delay: 0.1 }}
                                            className="px-3 py-1 text-xs font-semibold rounded-full"
                                            style={{ background: 'rgba(239, 68, 68, 0.15)', color: 'hsl(0, 72%, 55%)', border: '1px solid rgba(239, 68, 68, 0.25)' }}
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
                                            className="shrink-0 w-16 h-16 rounded-xl overflow-hidden transition-all"
                                            style={{
                                                border: idx === selectedIdx
                                                    ? '2px solid hsl(220, 70%, 55%)'
                                                    : '2px solid var(--glass-border)',
                                                boxShadow: idx === selectedIdx
                                                    ? '0 0 12px -2px hsl(220, 70%, 55%, 0.3)'
                                                    : 'none'
                                            }}
                                        >
                                            <img src={img.url} alt={`Thumbnail ${idx + 1}`} className="w-full h-full object-cover" />
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
                                className="text-3xl md:text-4xl font-extrabold tracking-tight mb-2"
                                style={{ color: 'hsl(var(--foreground))' }}
                                variants={fadeIn}
                            >
                                {product.name}
                            </motion.h1>

                            <motion.div className="flex items-center gap-3 mb-4 flex-wrap" variants={fadeIn}>
                                <div className="flex items-center">
                                    {[...Array(5)].map((_, i) => (
                                        <Star key={i} size={18}
                                            className={i < Math.floor(product.rating || 0) ? "" : ""}
                                            style={{ color: i < Math.floor(product.rating || 0) ? 'hsl(45, 93%, 47%)' : 'hsl(var(--muted-foreground))', fill: i < Math.floor(product.rating || 0) ? 'hsl(45, 93%, 47%)' : 'none' }}
                                        />
                                    ))}
                                    <span className="ml-2 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        ({product.numReviews || 0} reviews)
                                    </span>
                                </div>
                                <span className="w-1 h-1 rounded-full" style={{ background: 'hsl(var(--muted-foreground))' }} />
                                <span className="text-sm font-medium"
                                    style={{ color: product.stock > 0 ? 'hsl(150, 60%, 40%)' : 'hsl(0, 72%, 55%)' }}>
                                    {product.stock > 0 ? `In Stock (${product.stock})` : 'Out of Stock'}
                                </span>
                            </motion.div>

                            <motion.div className="mb-6" variants={fadeIn}>
                                {discountPercentage > 0 ? (
                                    <div className="flex items-center gap-3 flex-wrap">
                                        <span className="text-3xl font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>
                                            {getCurrencySymbol()}{convertPrice(displayPrice).toFixed(2)}
                                        </span>
                                        <span className="text-xl line-through" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            {getCurrencySymbol()}{convertPrice(originalPrice).toFixed(2)}
                                        </span>
                                        <span className="tag-pill text-xs font-semibold"
                                            style={{ background: 'rgba(239, 68, 68, 0.1)', color: 'hsl(0, 72%, 55%)', borderColor: 'rgba(239, 68, 68, 0.2)' }}>
                                            Save {discountPercentage}%
                                        </span>
                                    </div>
                                ) : (
                                    <span className="text-3xl font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>
                                        {getCurrencySymbol()}{convertPrice(displayPrice).toFixed(2)}
                                    </span>
                                )}
                            </motion.div>

                            <motion.p
                                className="text-sm mb-6 leading-relaxed"
                                style={{ color: 'hsl(var(--muted-foreground))' }}
                                variants={fadeIn}
                            >
                                {product.description}
                            </motion.p>

                            <motion.div className="flex items-center gap-3 mb-6" variants={fadeIn}>
                                <div className="glass-inner flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm" style={{ color: 'hsl(var(--foreground))' }}>
                                    <RotateCcw size={16} style={{ color: 'hsl(var(--primary))' }} />
                                    <span>30-Day Returns</span>
                                </div>
                            </motion.div>

                            {product.tags && product.tags.length > 0 && (
                                <motion.div className="flex flex-wrap gap-2 mb-6" variants={fadeIn}>
                                    {product.tags.map((tag) => (
                                        <span key={tag} className="tag-pill text-xs font-medium"
                                            style={{ background: 'rgba(56, 189, 248, 0.1)', color: 'hsl(200, 80%, 50%)', borderColor: 'rgba(56, 189, 248, 0.18)' }}>
                                            <Tag size={11} /> {tag}
                                        </span>
                                    ))}
                                </motion.div>
                            )}

                            <motion.div className="flex gap-3 mb-6" variants={fadeIn}>
                                <motion.button
                                    disabled={product.stock === 0 || isCartLoading || loadingProductId === id}
                                    onClick={() => { handleAddToCart(id) }}
                                    whileHover={product.stock > 0 ? { scale: 1.02 } : {}}
                                    whileTap={product.stock > 0 ? { scale: 0.98 } : {}}
                                    className="flex-1 px-6 py-3 rounded-xl font-semibold flex items-center justify-center gap-2 transition-all text-sm"
                                    style={
                                        product.stock === 0
                                            ? { background: 'rgba(255,255,255,0.08)', color: 'hsl(var(--muted-foreground))', cursor: 'not-allowed' }
                                            : isInCart
                                                ? { background: 'rgba(16, 185, 129, 0.15)', color: 'hsl(150, 60%, 40%)', border: '1px solid rgba(16, 185, 129, 0.25)' }
                                                : { background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.35)' }
                                    }
                                >
                                    {product.stock === 0 ? "Out of Stock" :
                                        isCartLoading && loadingProductId === id ? (
                                            <span className="flex items-center gap-2">
                                                <Loader2 size={16} className="animate-spin" /> Adding...
                                            </span>
                                        ) : isInCart ? (
                                            <span className="flex items-center gap-2">
                                                <Sparkles size={16} /> Added to Cart
                                            </span>
                                        ) : (
                                            <span className="flex items-center gap-2">
                                                <ShoppingCart size={16} /> Add to Cart
                                            </span>
                                        )
                                    }
                                </motion.button>

                                <motion.button
                                    disabled={product.stock === 0}
                                    onClick={() => {
                                        if (isInWishlist) handleDeleteFromWishlist(product._id);
                                        else handleAddToWishlist(product._id);
                                    }}
                                    whileHover={product.stock > 0 ? { scale: 1.05 } : {}}
                                    whileTap={product.stock > 0 ? { scale: 0.95 } : {}}
                                    className="glass-button p-3 rounded-xl flex items-center justify-center transition-all"
                                    style={
                                        product.stock === 0
                                            ? { cursor: 'not-allowed', opacity: 0.5 }
                                            : isInWishlist
                                                ? { background: 'rgba(239, 68, 68, 0.12)', borderColor: 'rgba(239, 68, 68, 0.25)', color: 'hsl(0, 72%, 55%)' }
                                                : {}
                                    }
                                >
                                    <Heart size={20} fill={isInWishlist ? "currentColor" : "none"} />
                                </motion.button>
                            </motion.div>

                            {/* Store Info */}
                            <motion.div className="my-6" variants={fadeIn}>
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
                                className="glass-inner rounded-xl p-4"
                                variants={fadeIn}
                            >
                                <div className="flex items-center gap-2 text-sm mb-1.5">
                                    <Package size={14} style={{ color: 'hsl(var(--muted-foreground))' }} />
                                    <span style={{ color: 'hsl(var(--muted-foreground))' }}>Category:</span>
                                    <span className="font-medium" style={{ color: 'hsl(var(--foreground))' }}>{product.category}</span>
                                </div>
                                <div className="flex items-center gap-2 text-sm">
                                    <Tag size={14} style={{ color: 'hsl(var(--muted-foreground))' }} />
                                    <span style={{ color: 'hsl(var(--muted-foreground))' }}>Brand:</span>
                                    <span className="font-medium" style={{ color: 'hsl(var(--foreground))' }}>{product.brand}</span>
                                </div>
                            </motion.div>
                        </motion.div>
                    </div>
                </motion.div>

                {/* Reviews Section */}
                <motion.div
                    className="glass-panel p-6 md:p-8"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.2 }}
                >
                    <h2 className="text-2xl font-extrabold tracking-tight mb-6" style={{ color: 'hsl(var(--foreground))' }}>
                        Customer Reviews
                    </h2>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                        {/* Add Review */}
                        <motion.div
                            className="glass-inner rounded-2xl p-6"
                            initial={{ opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ duration: 0.5, delay: 0.3 }}
                        >
                            <h3 className="text-lg font-semibold mb-4" style={{ color: 'hsl(var(--foreground))' }}>Add Your Review</h3>

                            <form onSubmit={handleAddReview} className="space-y-4">
                                <div>
                                    <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Your Rating</label>
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
                                                <Star size={28}
                                                    style={{ color: star <= rating ? 'hsl(45, 93%, 47%)' : 'hsl(var(--muted-foreground))', fill: star <= rating ? 'hsl(45, 93%, 47%)' : 'none' }}
                                                />
                                            </motion.button>
                                        ))}
                                    </div>
                                </div>

                                <div>
                                    <label htmlFor="comment" className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Your Review</label>
                                    <textarea
                                        ref={commentRef}
                                        id="comment"
                                        rows="4"
                                        className="glass-input"
                                        style={{ resize: 'vertical' }}
                                        placeholder="Share your experience with this product..."
                                    />
                                </div>

                                <motion.button
                                    type="submit"
                                    whileHover={{ scale: 1.02 }}
                                    whileTap={{ scale: 0.98 }}
                                    className="w-full py-3 px-4 rounded-xl font-semibold text-sm transition-all"
                                    style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.35)' }}
                                >
                                    Submit Review
                                </motion.button>
                            </form>
                        </motion.div>

                        {/* Existing Reviews */}
                        <div>
                            <h3 className="text-lg font-semibold mb-4" style={{ color: 'hsl(var(--foreground))' }}>
                                {product.reviews?.length || 0} Review{product.reviews?.length !== 1 ? 's' : ''}
                            </h3>

                            <div className="space-y-4 max-h-96 overflow-y-auto pr-2 filter-sb">
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
                                                    transition={{ duration: 0.3, delay: index * 0.05 }}
                                                    className="glass-inner rounded-xl p-4"
                                                >
                                                    <div className="flex items-start gap-3">
                                                        <div className="w-10 h-10 rounded-full overflow-hidden shrink-0"
                                                            style={{ border: '2px solid var(--glass-border)' }}>
                                                            <img className='w-full h-full object-cover' src={review.user.avatar || 'https://res.cloudinary.com/dus5sac8g/image/upload/v1756983317/Profile_Picture_dxq4w8.jpg'} alt="" />
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                                                                <span className="font-medium text-sm" style={{ color: 'hsl(var(--foreground))' }}>{review.user?.username || 'Anonymous'}</span>
                                                                <div className="flex gap-0.5">
                                                                    {[...Array(5)].map((_, i) => (
                                                                        <Star key={i} size={12}
                                                                            style={{ color: i < review.rating ? 'hsl(45, 93%, 47%)' : 'hsl(var(--muted-foreground))', fill: i < review.rating ? 'hsl(45, 93%, 47%)' : 'none' }}
                                                                        />
                                                                    ))}
                                                                </div>
                                                            </div>
                                                            <div className="text-xs mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                                {date.toLocaleDateString()} at {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                            </div>
                                                            <p className="text-sm" style={{ color: 'hsl(var(--foreground))' }}>{review.comment}</p>
                                                        </div>
                                                    </div>
                                                </motion.div>
                                            );
                                        })
                                    ) : (
                                        <motion.div
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                            className="text-center py-10"
                                        >
                                            <div className="glass-inner p-4 rounded-2xl inline-block mb-3">
                                                <Star size={32} style={{ color: 'hsl(var(--muted-foreground))' }} />
                                            </div>
                                            <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                No reviews yet. Be the first to review this product!
                                            </p>
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
