import axios from 'axios';
import React, { useRef, useState, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Heart, ShoppingCart, Star, ChevronRight, ChevronLeft, Zap, Sparkles, RotateCcw, Loader2, Home, Tag, Package, Ticket, Copy, Check, Calendar, Plus, Minus, X, CreditCard, Banknote, Flag, MoreHorizontal } from 'lucide-react';
import Loader from '../components/common/Loader';
import StoreInfo from '../components/common/StoreInfo';
import SEOHead from '../components/common/SEOHead';
import ProductCard from '../components/common/ProductCard';
import ProductOptionsModal from '../components/common/ProductOptionsModal';
import { toast } from 'react-toastify';
import { useGlobal } from '../contexts/GlobalContext';
import {
    resolveProductPresentationCurrency,
    resolveProductPresentationMoney,
    useCurrency,
} from '../contexts/CurrencyContext';
import { useBuyerLocation } from '../contexts/BuyerLocationContext';
import { getAuthToken } from "../utils/cookieHelper";
import { trackProductView } from '../utils/tiktokPixel';
import { addRecentlyViewedProduct } from '../utils/recentlyViewedProducts';
import { createProductSelection, hasProductOptions } from '../utils/productOptions';
import { buildProductAIChatPrompt, openAIChat } from '../utils/aiChatLauncher';
import SafetyActionsDialog from '../components/common/SafetyActionsDialog';
import { useAuth } from '../contexts/AuthContext';

function ProductDetailPage() {
    const { id } = useParams();
    const navigate = useNavigate();
    const { currentUser } = useAuth();
    const { formatPrice } = useCurrency();
    const { appendLocationParams, locationQueryString } = useBuyerLocation();
    const {
        wishlistItems,
        handleAddToWishlist,
        handleDeleteFromWishlist,
        cartItems,
        handleAddToCart,
        handleQtyInc,
        handleQtyDec,
        isCartLoading,
        loadingProductId,
        qtyUpdateId
    } = useGlobal();

    const [product, setProduct] = useState({});
    const [mainImg, setMainImg] = useState(null);
    const [selectedIdx, setSelectedIdx] = useState(0);
    const [loading, setLoading] = useState(true);
    const [rating, setRating] = useState(5);
    const [selectedColor, setSelectedColor] = useState(null);
    const [selectedOptions, setSelectedOptions] = useState({}); // { Size: 'L', Color: 'Red' }
    const [isOptionsModalOpen, setIsOptionsModalOpen] = useState(false);
    const [imageLoading, setImageLoading] = useState(true);
    const [storeData, setStoreData] = useState(null);
    const [storePolicy, setStorePolicy] = useState(null);
    const [availableCoupons, setAvailableCoupons] = useState([]);
    const [copiedCoupon, setCopiedCoupon] = useState(null);
    const [relatedProducts, setRelatedProducts] = useState([]);
    const [safetyAction, setSafetyAction] = useState(null);
    const commentRef = useRef();

    const isInWishlist = product && wishlistItems?.some((item) => item._id === product._id);
    // Stable key for variant combo (e.g. "Color:Red|Size:L"); used for cart line dedupe
    const optionsKeyOf = (opts) => opts ? Object.keys(opts).filter(k => opts[k]).sort().map(k => `${k}:${opts[k]}`).join('|') : '';
    const myOptKey = optionsKeyOf(selectedOptions);
    const cartLineItem = product && cartItems?.cart?.find((item) =>
        item.product?._id === product._id &&
        item.selectedColor === selectedColor &&
        optionsKeyOf(item.selectedOptions) === myOptKey
    );
    const isInCart = !!cartLineItem;
    const productHasOptions = hasProductOptions(product);
    const productSellerId = product?.seller?._id || product?.seller || storeData?.seller?._id || storeData?.seller;
    const isOwnSellerContent = Boolean(
        productSellerId && String(productSellerId) === String(currentUser?._id || currentUser?.id || ''),
    );

    const hasLoadedProductMoney = Boolean(product?._id);
    const productPrice = hasLoadedProductMoney
        ? resolveProductPresentationMoney(product, 'price')
        : 0;
    const productDiscountedPrice = hasLoadedProductMoney
        ? resolveProductPresentationMoney(product, 'discountedPrice')
        : 0;
    const hasProductDiscount = productDiscountedPrice > 0 && productDiscountedPrice < productPrice;
    const displayPrice = hasProductDiscount ? productDiscountedPrice : productPrice;
    const originalPrice = productPrice;
    const productCurrency = hasLoadedProductMoney
        ? resolveProductPresentationCurrency(product)
        : 'USD';

    const discountPercentage = hasProductDiscount
        ? Math.round(((productPrice - productDiscountedPrice) / productPrice) * 100)
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

    const handleAddToCartClick = () => {
        if (productHasOptions) {
            setIsOptionsModalOpen(true);
            return;
        }
        handleAddToCart(id, selectedColor, selectedOptions, product);
    };

    const handleOptionsConfirm = async ({ selectedOptions: nextOptions, selectedColor: nextColor }) => {
        const normalizedOptions = nextOptions || {};
        const normalizedColor = nextColor || null;
        setSelectedOptions(normalizedOptions);
        setSelectedColor(normalizedColor);
        const added = await handleAddToCart(id, normalizedColor, normalizedOptions, product);
        if (added) setIsOptionsModalOpen(false);
    };

    const handleAskAI = () => {
        if (!product?._id) return;
        const prompt = buildProductAIChatPrompt({
            product,
            storeName: storeData?.storeName,
            formattedPrice: formatPrice(displayPrice, { sourceCurrency: productCurrency }),
        });
        openAIChat({ prompt, productId: product._id });
    };

    const handleAddReview = async (e) => {
        e.preventDefault();
        if (!commentRef.current.value.trim()) return toast.error('Please write a review comment');
        try {
            const token = getAuthToken();
            if (!token) {
                toast.error('Please log in before adding a product review.');
                return;
            }
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
            const params = new URLSearchParams();
            appendLocationParams(params);
            const suffix = params.toString();
            const res = await axios.get(
                `${import.meta.env.VITE_API_URL}api/products/get-single-product/${id}${suffix ? `?${suffix}` : ''}`
            );
            setProduct(res.data.product);
            setStorePolicy(res.data.storePolicy || null);
            setMainImg(res.data.product.image);
            setImageLoading(true);
            // Pre-select only valid seller defaults; the add action still
            // opens the picker so buyers can review or change every option.
            const initialSelection = createProductSelection(res.data.product, {}, null);
            setSelectedOptions(initialSelection.selectedOptions || {});
            setSelectedColor(initialSelection.selectedColor || null);
            setIsOptionsModalOpen(false);
            if (res.data.product.seller) {
                try {
                    const storeParams = new URLSearchParams();
                    appendLocationParams(storeParams);
                    const storeSuffix = storeParams.toString();
                    const storeRes = await axios.get(
                        `${import.meta.env.VITE_API_URL}api/stores/seller/${res.data.product.seller}${storeSuffix ? `?${storeSuffix}` : ''}`
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

    useEffect(() => {
        fetchProduct();
        fetchProductCoupons();
        // Product identity and buyer location are the authoritative request
        // keys; render-created fetcher identities must not retrigger requests.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, locationQueryString]);

    useEffect(() => {
        if (product?._id) trackProductView(product);
        // Track exactly once per product id, not whenever the product object is
        // enriched or replaced with the same persisted product.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [product?._id]);

    // Related products by category (excludes current product)
    useEffect(() => {
        if (!product?._id) return;
        let cancelled = false;
        (async () => {
            try {
                let list = [];

                if (product.category) {
                    const params = new URLSearchParams({ categories: product.category, limit: '12' });
                    appendLocationParams(params);
                    const categoryRes = await axios.get(
                        `${import.meta.env.VITE_API_URL}api/products/get-products?${params.toString()}`
                    );
                    list = (categoryRes.data.products || [])
                        .filter(p => p._id !== product._id)
                        .slice(0, 8);
                }

                if (list.length < 4) {
                    const fallbackParams = new URLSearchParams({ limit: '12', sortBy: 'relevance' });
                    appendLocationParams(fallbackParams);
                    const fallbackRes = await axios.get(
                        `${import.meta.env.VITE_API_URL}api/products/get-products?${fallbackParams.toString()}`
                    );
                    const seen = new Set(list.map(p => p._id));
                    const fallback = (fallbackRes.data.products || [])
                        .filter(p => p._id !== product._id && !seen.has(p._id))
                        .slice(0, 8 - list.length);
                    list = [...list, ...fallback];
                }

                if (cancelled) return;
                setRelatedProducts(list);
            } catch (err) {
                console.log('Related products unavailable');
                if (!cancelled) setRelatedProducts([]);
            }
        })();
        return () => { cancelled = true; };
    }, [product?.category, product?._id, locationQueryString, appendLocationParams]);

    const fetchProductCoupons = async () => {
        try {
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/coupons/product/${id}`);
            setAvailableCoupons(res.data.coupons || []);
        } catch (err) {
            console.log('No coupons available');
        }
    };

    const copyCouponCode = (code) => {
        navigator.clipboard.writeText(code);
        setCopiedCoupon(code);
        toast.success('Coupon code copied!');
        setTimeout(() => setCopiedCoupon(null), 2000);
    };

    // Track product view for personalized recommendations
    useEffect(() => {
        addRecentlyViewedProduct(id);
    }, [id]);

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
                    title={`${product.name}${product.brand ? ` by ${product.brand}` : ''} - Buy Online`}
                    description={product.description?.slice(0, 155) || `Buy ${product.name} online on Rozare marketplace. ${product.category ? `Category: ${product.category}.` : ''} ${product.brand ? `Brand: ${product.brand}.` : ''} Review price, stock, options, seller details, and shipping information before checkout.`}
                    canonical={`/single-product/${id}`}
                    ogType="product"
                    ogImage={product.image}
                    ogImageAlt={`${product.name} - Buy on Rozare`}
                    keywords={`${product.name}, buy ${product.name}, ${product.name} online, ${product.name} price, ${product.brand || ''}, ${product.category || ''}, buy ${product.category || 'products'} online, shop ${product.category || 'products'}, rozare ${product.category || 'products'}, ${product.category || 'products'} deals`}
                    jsonLd={[
                        {
                            '@context': 'https://schema.org',
                            '@type': 'Product',
                            name: product.name,
                            description: product.description,
                            image: product.image,
                            brand: product.brand ? { '@type': 'Brand', name: product.brand } : undefined,
                            offers: {
                                '@type': 'Offer',
                                price: displayPrice,
                                priceCurrency: productCurrency,
                                availability: product.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
                                url: `https://rozare.com/single-product/${id}`,
                                seller: { '@type': 'Organization', name: 'Rozare' },
                            },
                            ...(product.rating && {
                                aggregateRating: {
                                    '@type': 'AggregateRating',
                                    ratingValue: product.rating,
                                    reviewCount: product.numReviews || 0,
                                    bestRating: 5,
                                    worstRating: 1,
                                },
                            }),
                        },
                        {
                            '@context': 'https://schema.org',
                            '@type': 'BreadcrumbList',
                            itemListElement: [
                                { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://rozare.com/' },
                                { '@type': 'ListItem', position: 2, name: product.category || 'Products', item: 'https://rozare.com/' },
                                { '@type': 'ListItem', position: 3, name: product.name, item: `https://rozare.com/single-product/${id}` },
                            ],
                        },
                    ]}
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

                    <div className="relative flex flex-col lg:grid lg:grid-cols-2 lg:gap-8 p-6 md:p-8">
                        {/* Images Section */}
                        <div className="contents lg:flex lg:flex-col">
                            {/* Main Image */}
                            <div className="relative order-[10] lg:order-none h-80 md:h-96 glass-inner rounded-2xl overflow-hidden flex items-center justify-center">
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
                                <div className="order-[20] lg:order-none flex gap-3 mt-4 overflow-x-auto py-2">
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

                            <div className="contents lg:block lg:mt-5">
                                {product.tags && product.tags.length > 0 && (
                                    <motion.div className="order-[50] lg:order-none flex flex-wrap gap-2 mt-5 lg:mt-0 mb-6" variants={fadeIn}>
                                        {product.tags.map((tag) => (
                                            <span key={tag} className="tag-pill text-xs font-medium"
                                                style={{ background: 'rgba(56, 189, 248, 0.1)', color: 'hsl(200, 80%, 50%)', borderColor: 'rgba(56, 189, 248, 0.18)' }}>
                                                <Tag size={11} /> {tag}
                                            </span>
                                        ))}
                                    </motion.div>
                                )}

                                {/* Return Policy */}
                                {(() => {
                                    const rp = product.returnPolicy?.useStorePolicy === false
                                        ? product.returnPolicy
                                        : (storePolicy?.returnPolicy || storeData?.returnPolicy);
                                    if (!rp) return (
                                        <motion.div className="order-[80] lg:order-none flex items-center gap-3 mb-6" variants={fadeIn}>
                                            <div className="glass-inner flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm" style={{ color: 'hsl(var(--foreground))' }}>
                                                <RotateCcw size={16} style={{ color: 'hsl(var(--primary))' }} />
                                                <span>Contact seller for return policy</span>
                                            </div>
                                        </motion.div>
                                    );
                                    return (
                                        <motion.div className="order-[80] lg:order-none glass-inner rounded-xl p-4 mb-6 space-y-2" variants={fadeIn}>
                                            <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'hsl(var(--muted-foreground))' }}>Return & Warranty</p>
                                            <div className="flex flex-wrap gap-2">
                                                {rp.returnsEnabled ? (
                                                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
                                                        style={{ background: 'rgba(16,185,129,0.12)', color: 'hsl(150,60%,45%)' }}>
                                                        <RotateCcw size={12} />
                                                        {rp.returnDuration}-Day Returns
                                                    </span>
                                                ) : (
                                                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
                                                        style={{ background: 'rgba(239,68,68,0.1)', color: 'hsl(0,72%,55%)' }}>
                                                        No Returns
                                                    </span>
                                                )}
                                                {rp.refundType && rp.refundType !== 'none' && (
                                                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
                                                        style={{ background: 'rgba(99,102,241,0.1)', color: 'hsl(220,70%,55%)' }}>
                                                        {rp.refundType === 'full_refund' ? 'Full Refund to Rozare Wallet' : rp.refundType === 'replacement_only' ? 'Replacement Only' : 'Rozare Wallet Credit'}
                                                    </span>
                                                )}
                                                {rp.warrantyEnabled && (
                                                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
                                                        style={{ background: 'rgba(245,158,11,0.1)', color: 'hsl(45,80%,40%)' }}>
                                                        🛡️ {rp.warrantyDuration}-Month Warranty
                                                    </span>
                                                )}
                                                {!rp.returnsEnabled && (!rp.refundType || rp.refundType === 'none') && !rp.warrantyEnabled && (
                                                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
                                                        style={{ background: 'rgba(107,114,128,0.1)', color: 'hsl(var(--muted-foreground))' }}>
                                                        No returns, refunds, or warranty
                                                    </span>
                                                )}
                                            </div>
                                            {rp.policyDescription && (
                                                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{rp.policyDescription}</p>
                                            )}
                                            {rp.warrantyDescription && (
                                                <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Warranty: {rp.warrantyDescription}</p>
                                            )}
                                        </motion.div>
                                    );
                                })()}

                                <motion.div
                                    className="order-[70] lg:order-none glass-inner rounded-xl p-4 mb-6"
                                    variants={fadeIn}
                                    style={{ border: '1px solid var(--glass-border)' }}
                                >
                                    <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        Payment availability
                                    </p>
                                    {(storePolicy?.paymentPolicy || storeData?.paymentPolicy) === 'advance_only' ? (
                                        <div className="flex items-start gap-3">
                                            <CreditCard size={18} className="mt-0.5 shrink-0" style={{ color: 'hsl(220, 70%, 55%)' }} />
                                            <div>
                                                <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Online payment only</p>
                                                <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                    Pay online by card or Rozare Wallet. Cash on Delivery is not available.
                                                </p>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="flex items-start gap-3">
                                            <Banknote size={18} className="mt-0.5 shrink-0" style={{ color: 'hsl(150, 60%, 40%)' }} />
                                            <div>
                                                <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Online payment and Cash on Delivery</p>
                                                <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                    Pay by card or Rozare Wallet, or pay when this product is delivered.
                                                </p>
                                            </div>
                                        </div>
                                    )}
                                </motion.div>
                            </div>
                        </div>

                        {/* Product Info */}
                        <motion.div
                            className="contents lg:flex lg:flex-col"
                            variants={staggerChildren}
                            initial="hidden"
                            animate="visible"
                        >
                            <div className="order-[30] lg:order-none mt-5 lg:mt-0">
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
                                            {formatPrice(displayPrice, { sourceCurrency: productCurrency })}
                                        </span>
                                        <span className="text-xl line-through" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            {formatPrice(originalPrice, { sourceCurrency: productCurrency })}
                                        </span>
                                        <span className="tag-pill text-xs font-semibold"
                                            style={{ background: 'rgba(239, 68, 68, 0.1)', color: 'hsl(0, 72%, 55%)', borderColor: 'rgba(239, 68, 68, 0.2)' }}>
                                            Save {discountPercentage}%
                                        </span>
                                    </div>
                                ) : (
                                    <span className="text-3xl font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>
                                        {formatPrice(displayPrice, { sourceCurrency: productCurrency })}
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

                            {!isOwnSellerContent && <motion.button
                                type="button"
                                onClick={handleAskAI}
                                variants={fadeIn}
                                whileHover={{ y: -2, scale: 1.01 }}
                                whileTap={{ scale: 0.985 }}
                                className="group relative w-full overflow-hidden rounded-2xl p-[1px] mb-6 text-left"
                                style={{
                                    background: 'linear-gradient(120deg, rgba(20,184,166,0.75), rgba(14,165,233,0.68), rgba(99,102,241,0.78))',
                                    boxShadow: '0 14px 34px -22px rgba(14,165,233,0.85)',
                                }}
                                aria-label={`Ask Rozare AI about ${product.name}`}
                            >
                                <span
                                    className="relative flex items-center gap-3 rounded-[15px] px-4 py-3.5 sm:px-5"
                                    style={{ background: 'hsl(var(--background) / 0.9)', backdropFilter: 'blur(18px)' }}
                                >
                                    <span
                                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-white"
                                        style={{
                                            background: 'var(--logo-gradient, linear-gradient(135deg, #14b8a6, #0ea5e9, #6366f1))',
                                            boxShadow: '0 9px 22px -8px rgba(14,165,233,0.8)',
                                        }}
                                    >
                                        <Sparkles size={19} />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>
                                            Ask Rozare AI about this product
                                        </span>
                                        <span className="mt-0.5 block text-xs leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            Compare it, check the fit, or discover useful alternatives.
                                        </span>
                                    </span>
                                    <span
                                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 group-hover:translate-x-0.5"
                                        style={{ background: 'rgba(99,102,241,0.1)', color: 'hsl(230, 70%, 58%)' }}
                                    >
                                        <ChevronRight size={18} />
                                    </span>
                                </span>
                            </motion.button>}

                            <motion.button
                                type="button"
                                onClick={() => setSafetyAction({
                                    report: { kind: 'product', targetId: product._id },
                                    block: productSellerId ? { userId: productSellerId, source: 'seller', label: 'seller' } : null,
                                    onBlocked: () => navigate('/products'),
                                })}
                                variants={fadeIn}
                                className="mb-6 inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition-colors hover:bg-white/10"
                                style={{ color: 'hsl(var(--muted-foreground))', border: '1px solid var(--glass-border)' }}
                            >
                                <Flag size={13} /> Product safety options
                            </motion.button>

                            {/* Dynamic Option Selectors (Size, Color, Material, etc.) */}
                            {product.optionGroups && product.optionGroups.length > 0 && (
                                <motion.div className="mb-6 space-y-5" variants={fadeIn}>
                                    {product.optionGroups.map((group) => (
                                        <div key={group.name}>
                                            <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                {group.name}: <span className="normal-case font-medium" style={{ color: 'hsl(var(--foreground))' }}>{selectedOptions[group.name] || `Select ${group.name.toLowerCase()}`}</span>
                                            </p>
                                            <div className="flex flex-wrap gap-2">
                                                {group.values.map((val) => {
                                                    const isActive = selectedOptions[group.name] === val;
                                                    return (
                                                        <motion.button key={val} type="button"
                                                            onClick={() => setSelectedOptions(prev => ({ ...prev, [group.name]: isActive ? undefined : val }))}
                                                            whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                                                            className="px-4 py-2 rounded-xl text-sm font-medium transition-all"
                                                            style={isActive
                                                                ? { background: 'var(--logo-gradient, linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%)))', color: 'white', boxShadow: '0 0 15px -3px hsl(220, 70%, 55%, 0.4)' }
                                                                : { background: 'rgba(255,255,255,0.06)', color: 'hsl(var(--foreground))', border: '1px solid var(--glass-border)' }}>
                                                            {val}
                                                        </motion.button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    ))}
                                </motion.div>
                            )}

                            {/* Legacy Color Selector (only show if no new optionGroups configured) */}
                            {(!product.optionGroups || product.optionGroups.length === 0) && product.colors && product.colors.length > 0 && (
                                <motion.div className="mb-6" variants={fadeIn}>
                                    <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        Color: <span className="normal-case font-medium" style={{ color: 'hsl(var(--foreground))' }}>{selectedColor || 'Select a color'}</span>
                                    </p>
                                    <div className="flex flex-wrap gap-2">
                                        {product.colors.map((color) => (
                                            <motion.button
                                                key={color}
                                                type="button"
                                                onClick={() => setSelectedColor(color === selectedColor ? null : color)}
                                                whileHover={{ scale: 1.05 }}
                                                whileTap={{ scale: 0.95 }}
                                                className="px-4 py-2 rounded-xl text-sm font-medium transition-all"
                                                style={selectedColor === color
                                                    ? { background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white', boxShadow: '0 0 15px -3px hsl(220, 70%, 55%, 0.4)' }
                                                    : { background: 'rgba(255,255,255,0.06)', color: 'hsl(var(--foreground))', border: '1px solid var(--glass-border)' }
                                                }
                                            >
                                                {color}
                                            </motion.button>
                                        ))}
                                    </div>
                                </motion.div>
                            )}

                            {/* Available Coupons */}
                            {availableCoupons.length > 0 && (
                                <motion.div className="mb-6" variants={fadeIn}>
                                    <p className="text-xs font-semibold uppercase tracking-wider mb-3 flex items-center gap-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        <Ticket size={13} style={{ color: 'hsl(280, 60%, 55%)' }} />
                                        Available Coupons
                                    </p>
                                    <div className="space-y-2">
                                        {availableCoupons.map(coupon => (
                                            <motion.div key={coupon._id}
                                                className="glass-inner rounded-xl p-3 flex items-center justify-between gap-3"
                                                whileHover={{ scale: 1.01 }}>
                                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                                    <div className="p-1.5 rounded-lg shrink-0" style={{ background: 'rgba(168, 85, 247, 0.1)', color: 'hsl(280, 60%, 55%)' }}>
                                                        <Ticket size={14} />
                                                    </div>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-2">
                                                            <span className="font-mono font-bold text-xs tracking-wider" style={{ color: 'hsl(280, 60%, 55%)' }}>
                                                                {coupon.code}
                                                            </span>
                                                            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                                                                style={{ background: 'rgba(16,185,129,0.1)', color: 'hsl(150, 60%, 45%)' }}>
                                                                {coupon.discountType === 'percentage' ? `${coupon.discountValue}% OFF` : `${formatPrice(coupon.discountValue, { sourceCurrency: coupon.currency || 'USD' })} OFF`}
                                                            </span>
                                                        </div>
                                                        {coupon.description && (
                                                            <p className="text-[10px] mt-0.5 truncate" style={{ color: 'hsl(var(--muted-foreground))' }}>{coupon.description}</p>
                                                        )}
                                                        <div className="flex items-center gap-2 mt-1 text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                            {coupon.minOrderAmount > 0 && (
                                                                <span>Min: {formatPrice(coupon.minOrderAmount, { sourceCurrency: coupon.currency || 'USD' })}</span>
                                                            )}
                                                            <span className="flex items-center gap-0.5">
                                                                <Calendar size={9} />
                                                                Expires {new Date(coupon.expiryDate).toLocaleDateString()}
                                                            </span>
                                                        </div>
                                                    </div>
                                                </div>
                                                <motion.button whileTap={{ scale: 0.9 }}
                                                    onClick={() => copyCouponCode(coupon.code)}
                                                    className="px-3 py-1.5 rounded-lg text-[11px] font-semibold shrink-0 flex items-center gap-1"
                                                    style={copiedCoupon === coupon.code
                                                        ? { background: 'rgba(16,185,129,0.15)', color: 'hsl(150, 60%, 45%)' }
                                                        : { background: 'rgba(168, 85, 247, 0.12)', color: 'hsl(280, 60%, 55%)' }
                                                    }>
                                                    {copiedCoupon === coupon.code ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy</>}
                                                </motion.button>
                                            </motion.div>
                                        ))}
                                    </div>
                                </motion.div>
                            )}

                            <motion.div className="flex gap-3 mb-6" variants={fadeIn}>
                                {isInCart && cartLineItem ? (
                                    <div className="flex-1 flex items-center justify-between px-3 py-2 rounded-xl"
                                        style={{ background: 'rgba(16, 185, 129, 0.1)', border: '1px solid rgba(16, 185, 129, 0.25)' }}>
                                        <button
                                            onClick={() => handleQtyDec(cartLineItem._id)}
                                            disabled={qtyUpdateId === cartLineItem._id}
                                            className="p-2 rounded-lg glass-button transition active:scale-90 disabled:opacity-50"
                                            aria-label="Decrease quantity">
                                            {cartLineItem.qty <= 1 ? <X size={16} /> : <Minus size={16} />}
                                        </button>
                                        <div className="flex items-center gap-2">
                                            <Sparkles size={14} style={{ color: 'hsl(150, 60%, 45%)' }} />
                                            <span className="text-sm font-semibold" style={{ color: 'hsl(150, 60%, 40%)' }}>In cart</span>
                                            <span className="text-base font-bold min-w-[24px] text-center" style={{ color: 'hsl(var(--foreground))' }}>
                                                {qtyUpdateId === cartLineItem._id ? <Loader2 size={14} className="animate-spin inline" /> : cartLineItem.qty}
                                            </span>
                                        </div>
                                        <button
                                            onClick={() => handleQtyInc(cartLineItem._id)}
                                            disabled={qtyUpdateId === cartLineItem._id || cartLineItem.qty >= product.stock}
                                            className="p-2 rounded-lg transition active:scale-90 disabled:opacity-50"
                                            style={{ background: 'var(--logo-gradient)', color: 'white' }}
                                            aria-label="Increase quantity">
                                            <Plus size={16} />
                                        </button>
                                    </div>
                                ) : (
                                    <motion.button
                                        disabled={product.stock === 0 || isCartLoading || loadingProductId === id}
                                        onClick={handleAddToCartClick}
                                        whileHover={product.stock > 0 ? { scale: 1.02 } : {}}
                                        whileTap={product.stock > 0 ? { scale: 0.98 } : {}}
                                        className="flex-1 px-6 py-3 rounded-xl font-semibold flex items-center justify-center gap-2 transition-all text-sm"
                                        style={
                                            product.stock === 0
                                                ? { background: 'rgba(255,255,255,0.08)', color: 'hsl(var(--muted-foreground))', cursor: 'not-allowed' }
                                                : { background: 'var(--logo-gradient)', color: 'white', boxShadow: 'var(--logo-glow)' }
                                        }
                                    >
                                        {product.stock === 0 ? "Out of Stock" :
                                            isCartLoading && loadingProductId === id ? (
                                                <span className="flex items-center gap-2">
                                                    <Loader2 size={16} className="animate-spin" /> Adding...
                                                </span>
                                            ) : (
                                                <span className="flex items-center gap-2">
                                                    <ShoppingCart size={16} /> {productHasOptions ? 'Choose options' : 'Add to Cart'}
                                                </span>
                                            )
                                        }
                                    </motion.button>
                                )}

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
                            </div>

                            {/* Store Info */}
                            <motion.div className="order-[60] lg:order-none my-6" variants={fadeIn}>
                                <StoreInfo
                                    storeName={storeData?.storeName}
                                    storeSlug={storeData?.storeSlug}
                                    storeLogo={storeData?.logo}
                                    sellerUsername={product.seller?.username}
                                    storeId={storeData?._id}
                                    trustCount={storeData?.trustCount}
                                    verification={storeData?.verification}
                                    ratingAverage={storeData?.ratingAverage}
                                    ratingCount={storeData?.ratingCount}
                                />
                            </motion.div>

                            <motion.div
                                className="order-[40] lg:order-none glass-inner rounded-xl p-4"
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
                                            const reviewerId = review.user?._id || review.user;
                                            const isOwnReview = reviewerId && String(reviewerId) === String(currentUser?._id || currentUser?.id || '');
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
                                                        {!isOwnReview && review._id && (
                                                            <button
                                                                type="button"
                                                                onClick={() => setSafetyAction({
                                                                    report: { kind: 'review', targetId: review._id },
                                                                    block: reviewerId ? { userId: reviewerId, source: 'reviewer', label: 'reviewer' } : null,
                                                                    onBlocked: () => setProduct(previous => ({
                                                                        ...previous,
                                                                        reviews: (previous.reviews || []).filter(item => String(item.user?._id || item.user) !== String(reviewerId)),
                                                                    })),
                                                                })}
                                                                className="w-8 h-8 rounded-xl inline-flex items-center justify-center shrink-0"
                                                                style={{ color: 'hsl(var(--muted-foreground))', background: 'var(--glass-bg-subtle)' }}
                                                                aria-label="Review safety options"
                                                            >
                                                                <MoreHorizontal size={16} />
                                                            </button>
                                                        )}
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

                {/* Related Products */}
                {relatedProducts.length > 0 && (
                    <motion.section
                        className="mt-12"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.5 }}
                        aria-labelledby="related-products-heading"
                    >
                        <div className="flex items-center justify-between mb-6">
                            <h2 id="related-products-heading" className="text-xl md:text-2xl font-bold" style={{ color: 'hsl(var(--foreground))' }}>
                                Related Products
                            </h2>
                            <Link
                                to="/products"
                                className="text-sm font-medium flex items-center gap-1 hover:opacity-80 transition-opacity"
                                style={{ color: 'hsl(220, 70%, 55%)' }}
                            >
                                View all <ChevronRight size={16} />
                            </Link>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-5">
                            {relatedProducts.slice(0, 4).map((p, idx) => (
                                <ProductCard key={p._id} {...p} idx={idx} />
                            ))}
                        </div>
                    </motion.section>
                )}

                <ProductOptionsModal
                    open={isOptionsModalOpen}
                    product={product}
                    selectedOptions={selectedOptions}
                    selectedColor={selectedColor}
                    onClose={() => setIsOptionsModalOpen(false)}
                    onConfirm={handleOptionsConfirm}
                    submitting={isCartLoading && loadingProductId === id}
                />
                <SafetyActionsDialog
                    open={Boolean(safetyAction)}
                    onClose={() => setSafetyAction(null)}
                    report={safetyAction?.report}
                    block={safetyAction?.block}
                    onBlocked={safetyAction?.onBlocked}
                />
            </div>
        </motion.div>
    );
}

export default ProductDetailPage;
