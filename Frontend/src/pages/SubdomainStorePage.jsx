import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Store, Package, Eye, Share2, Home, Globe, MapPin, Users, Sparkles, Star } from 'lucide-react';

const SellerTypePill = ({ type }) => {
    const isBrand = type === 'brand';
    const bg = isBrand ? 'hsla(280, 70%, 55%, 0.15)' : 'hsla(220, 70%, 55%, 0.15)';
    const border = isBrand ? 'hsla(280, 70%, 55%, 0.35)' : 'hsla(220, 70%, 55%, 0.35)';
    const color = isBrand ? 'hsl(280, 70%, 55%)' : 'hsl(220, 70%, 55%)';
    return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide"
            style={{ background: bg, border: `1px solid ${border}`, color, backdropFilter: 'blur(8px)' }}>
            {isBrand ? <Sparkles size={9} /> : <Store size={9} />}
            {isBrand ? 'Brand' : 'Store'}
        </span>
    );
};
import axios from 'axios';
import { toast } from 'react-toastify';
import ProductCard from '../components/common/ProductCard';
import Loader from '../components/common/Loader';
import TrustButton from '../components/common/TrustButton';
import VerifiedBadge from '../components/common/VerifiedBadge';
import SEOHead from '../components/common/SEOHead';
import { getSubdomain, redirectToMainDomain } from '../utils/subdomainHelper';
import { getAuthToken } from "../utils/cookieHelper";
import StoreReviews from '../components/common/StoreReviews';

const SubdomainStorePage = () => {
    const navigate = useNavigate();
    const subdomain = getSubdomain();
    const [store, setStore] = useState(null);
    const [products, setProducts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [productsLoading, setProductsLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);
    const [blocked, setBlocked] = useState(false);
    const [blockedStoreName, setBlockedStoreName] = useState('');
    const [trustStatus, setTrustStatus] = useState({ isTrusted: false, trustCount: 0 });
    const [storeRating, setStoreRating] = useState({ average: 0, count: 0 });

    useEffect(() => {
        if (!subdomain) {
            // No subdomain detected, redirect to main site
            redirectToMainDomain('/stores');
            return;
        }
        
        fetchStore();
        fetchProducts();
    }, [subdomain]);

    useEffect(() => {
        if (store?._id) {
            fetchTrustStatus();
        }
    }, [store?._id]);

    const fetchStore = async () => {
        try {
            setLoading(true);
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/subdomain/store?slug=${subdomain}`);
            setStore(res.data.store);
            setStoreRating({
                average: Number(res.data.store?.ratingAverage) || 0,
                count: Number(res.data.store?.ratingCount) || 0,
            });
            setNotFound(false);
        } catch (error) {
            console.error('Error fetching store:', error);
            if (error.response?.status === 403 && error.response?.data?.blocked) {
                setBlocked(true);
                setBlockedStoreName(error.response.data.storeName || 'This store');
            } else if (error.response?.status === 404) {
                setNotFound(true);
            } else {
                toast.error('Failed to load store');
            }
        } finally {
            setLoading(false);
        }
    };

    const fetchProducts = async () => {
        try {
            setProductsLoading(true);
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/subdomain/products?slug=${subdomain}`);
            setProducts(res.data.products);
        } catch (error) {
            console.error('Error fetching products:', error);
        } finally {
            setProductsLoading(false);
        }
    };

    const fetchTrustStatus = async () => {
        try {
            const token = getAuthToken();
            if (!token || !store?._id) return;
            const config = { headers: { Authorization: `Bearer ${token}` } };
            const res = await axios.get(
                `${import.meta.env.VITE_API_URL}api/stores/${store._id}/trust-status`,
                config
            );
            setTrustStatus(res.data.data);
        } catch (error) {
            console.error('Error fetching trust status:', error);
        }
    };

    const handleShare = () => {
        const url = window.location.href;
        if (navigator.share) {
            navigator.share({ title: store?.storeName, text: `Check out ${store?.storeName} on Rozare`, url });
        } else {
            navigator.clipboard.writeText(url);
            toast.success('Store link copied to clipboard!');
        }
    };

    if (loading) {
        return (
            <div className="flex justify-center items-center min-h-screen">
                <Loader />
            </div>
        );
    }

    if (blocked) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen p-4">
                <div className="glass-inner p-6 rounded-2xl mb-4">
                    <Store size={48} style={{ color: 'hsl(30, 90%, 50%)' }} />
                </div>
                <h1 className="text-2xl font-bold mb-2" style={{ color: 'hsl(var(--foreground))' }}>Store Temporarily Unavailable</h1>
                <p className="text-sm mb-2 text-center" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {blockedStoreName} is temporarily blocked.
                </p>
                <p className="text-sm mb-6 text-center" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    Products are currently hidden. Please check back later.
                </p>
                <motion.button whileHover={{ y: -1 }} whileTap={{ scale: 0.97 }}
                    onClick={() => redirectToMainDomain('/stores')}
                    className="px-6 py-2.5 rounded-xl font-semibold text-sm"
                    style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }}>
                    Browse Other Stores
                </motion.button>
            </div>
        );
    }

    if (notFound) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen p-4">
                <div className="glass-inner p-6 rounded-2xl mb-4">
                    <Store size={48} style={{ color: 'hsl(var(--muted-foreground))' }} />
                </div>
                <h1 className="text-2xl font-bold mb-2" style={{ color: 'hsl(var(--foreground))' }}>Store Not Found</h1>
                <p className="text-sm mb-6 text-center" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    This store doesn't exist or has been removed.
                </p>
                <motion.button whileHover={{ y: -1 }} whileTap={{ scale: 0.97 }}
                    onClick={() => redirectToMainDomain('/stores')}
                    className="px-6 py-2.5 rounded-xl font-semibold text-sm"
                    style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }}>
                    Browse All Stores
                </motion.button>
            </div>
        );
    }

    const trustCount = trustStatus.trustCount || store?.trustCount || 0;

    return (
        <motion.div
            className="min-h-screen py-8"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
        >
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                <SEOHead
                    title={store?.storeName || 'Store'}
                    description={store?.description
                        ? `${store.description.slice(0, 140)} - Shop on Rozare.`
                        : `Shop products from ${store?.storeName} on Rozare. Browse products, reviews, trust signals, and seller-managed shipping options.`}
                    canonical={`/`}
                    ogImage={store?.logo || undefined}
                    ogImageAlt={`${store?.storeName} store logo`}
                />

                {/* Store Header Card - Same as StorePage.jsx */}
                <motion.div
                    className="glass-panel-strong water-shimmer relative overflow-hidden mb-8"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.1 }}
                >
                    {store?.banner ? (
                        <div className="w-full h-44 md:h-60 overflow-hidden relative">
                            <motion.img
                                src={store.banner}
                                alt={`${store.storeName} banner`}
                                className="w-full h-full object-cover"
                                initial={{ scale: 1.08 }}
                                animate={{ scale: 1 }}
                                transition={{ duration: 0.7 }}
                            />
                            <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.4), transparent)' }} />
                        </div>
                    ) : (
                        <div className="w-full h-24 relative" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))' }}>
                            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.15),transparent_60%)]" />
                        </div>
                    )}

                    <div className="p-6 md:p-8">
                        <div className="flex flex-col md:flex-row gap-6 items-start">
                            <motion.div
                                className={`shrink-0 relative z-10 ${store?.banner ? '-mt-16 md:-mt-20' : '-mt-12'}`}
                                initial={{ scale: 0.85, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                transition={{ duration: 0.4, delay: 0.2 }}
                            >
                                {store?.logo ? (
                                    <img
                                        src={store.logo}
                                        alt={store.storeName}
                                        className="w-20 h-20 md:w-28 md:h-28 rounded-2xl object-cover shadow-xl"
                                        style={{ border: '3px solid var(--glass-border-strong)' }}
                                    />
                                ) : (
                                    <div className="w-20 h-20 md:w-28 md:h-28 rounded-2xl flex items-center justify-center shadow-xl"
                                        style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', border: '3px solid var(--glass-border-strong)' }}>
                                        <Store size={36} className="text-white" />
                                    </div>
                                )}
                            </motion.div>

                            <div className="flex-1 min-w-0">
                                <div className="flex flex-wrap items-center gap-2 mb-2">
                                    <h1 className="text-xl md:text-2xl lg:text-3xl font-extrabold tracking-tight"
                                        style={{ color: 'hsl(var(--foreground))' }}>
                                        {store?.storeName}
                                    </h1>
                                    <SellerTypePill type={store?.sellerType} />
                                    {store?.verification?.isVerified && <VerifiedBadge size="lg" />}
                                    {store && (
                                        <TrustButton
                                            storeId={store._id}
                                            storeName={store.storeName}
                                            initialTrustCount={trustCount}
                                            initialIsTrusted={trustStatus.isTrusted}
                                            compact={true}
                                            onTrustChange={(isTrusted, newCount) => {
                                                setTrustStatus({ isTrusted, trustCount: newCount });
                                                setStore(prev => ({ ...prev, trustCount: newCount }));
                                            }}
                                        />
                                    )}
                                </div>

                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs mb-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    <span className="inline-flex items-center gap-1.5"><Users size={13} />{trustCount} {trustCount === 1 ? 'truster' : 'trusters'}</span>
                                    <a href="#store-reviews" className="inline-flex items-center gap-1.5 hover:underline">
                                        <Star size={13} style={{ color: 'hsl(45,93%,47%)', fill: storeRating.count > 0 ? 'hsl(45,93%,47%)' : 'none' }} />
                                        {storeRating.count > 0 ? `${storeRating.average.toFixed(1)} (${storeRating.count})` : 'No ratings yet'}
                                    </a>
                                </div>

                                {store?.description && (
                                    <p className="text-sm mb-4 max-w-2xl leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        {store.description}
                                    </p>
                                )}

                                <div className="flex flex-wrap gap-2 text-xs">
                                    <span className="tag-pill flex items-center gap-1.5">
                                        <Package size={13} />{products.length} Products
                                    </span>
                                    <span className="tag-pill flex items-center gap-1.5" style={{ background: 'rgba(56, 189, 248, 0.1)', color: 'hsl(200, 80%, 50%)', borderColor: 'rgba(56, 189, 248, 0.18)' }}>
                                        <Eye size={13} />{store?.views || 0} Views
                                    </span>
                                </div>
                            </div>

                            <motion.button
                                onClick={handleShare}
                                className="glass-button px-5 py-2.5 rounded-xl flex items-center gap-2 font-medium text-sm"
                                style={{ color: 'hsl(var(--foreground))' }}
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                            >
                                <Share2 size={18} />
                                Share
                            </motion.button>
                        </div>
                    </div>
                </motion.div>

                <StoreReviews
                    storeId={store._id}
                    storeOwnerId={store.seller?._id || store.seller}
                    onSummaryChange={setStoreRating}
                />

                {/* Products Section */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.3 }}
                >
                    <div className="flex items-center justify-between mb-6">
                        <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>
                            Products
                        </h2>
                        <span className="tag-pill text-sm font-medium">
                            {products.length} {products.length === 1 ? 'item' : 'items'}
                        </span>
                    </div>

                    {productsLoading ? (
                        <div className="flex justify-center items-center h-64">
                            <Loader />
                        </div>
                    ) : products.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-64 glass-panel">
                            <div className="glass-inner p-5 rounded-2xl mb-4">
                                <Package size={40} style={{ color: 'hsl(var(--muted-foreground))' }} />
                            </div>
                            <p className="text-base font-semibold" style={{ color: 'hsl(var(--foreground))' }}>No products yet</p>
                            <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>This store hasn't added any products</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4 md:gap-5">
                            {products.map((product, idx) => (
                                <motion.div
                                    key={product._id}
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.4, delay: idx * 0.05 }}
                                >
                                    <ProductCard idx={idx} {...product} />
                                </motion.div>
                            ))}
                        </div>
                    )}
                </motion.div>
            </div>
        </motion.div>
    );
};

export default SubdomainStorePage;
