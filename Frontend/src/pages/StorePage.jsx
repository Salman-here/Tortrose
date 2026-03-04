import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Store, Package, Eye, Share2, ChevronRight, Home, Globe, MapPin, Users } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';
import ProductCard from '../components/common/ProductCard';
import Loader from '../components/common/Loader';
import TrustButton from '../components/common/TrustButton';
import VerifiedBadge from '../components/common/VerifiedBadge';
import SEOHead from '../components/common/SEOHead';

const StorePage = () => {
    const { slug } = useParams();
    const navigate = useNavigate();
    const [store, setStore] = useState(null);
    const [products, setProducts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [productsLoading, setProductsLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);
    const [trustStatus, setTrustStatus] = useState({ isTrusted: false, trustCount: 0 });

    useEffect(() => {
        fetchStore();
        fetchProducts();
        incrementViewCount();
    }, [slug]);

    useEffect(() => {
        if (store?._id) {
            fetchTrustStatus();
        }
    }, [store?._id]);

    const fetchStore = async () => {
        try {
            setLoading(true);
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/${slug}`);
            setStore(res.data.store);
            setNotFound(false);
        } catch (error) {
            console.error('Error fetching store:', error);
            if (error.response?.status === 404) {
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
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/${slug}/products`);
            setProducts(res.data.products);
        } catch (error) {
            console.error('Error fetching products:', error);
        } finally {
            setProductsLoading(false);
        }
    };

    const fetchTrustStatus = async () => {
        try {
            const token = localStorage.getItem('jwtToken');
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

    const incrementViewCount = async () => {
        try {
            await axios.post(`${import.meta.env.VITE_API_URL}api/stores/${slug}/view`);
        } catch (error) {
            console.error('Error incrementing view count:', error);
        }
    };

    const handleShare = () => {
        const url = window.location.href;
        if (navigator.share) {
            navigator.share({ title: store?.storeName, text: `Check out ${store?.storeName} on Tortrose`, url });
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

    if (notFound) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen p-4">
                <div className="glass-inner p-6 rounded-2xl mb-4">
                    <Store size={48} style={{ color: 'hsl(var(--muted-foreground))' }} />
                </div>
                <h1 className="text-2xl font-bold mb-2" style={{ color: 'hsl(var(--foreground))' }}>Store Not Found</h1>
                <p className="text-sm mb-6 text-center" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    The store you're looking for doesn't exist or has been removed.
                </p>
                <div className="flex gap-3">
                    <motion.button whileHover={{ y: -1 }} whileTap={{ scale: 0.97 }}
                        onClick={() => navigate('/stores')}
                        className="px-6 py-2.5 rounded-xl font-semibold text-sm"
                        style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }}>
                        Browse All Stores
                    </motion.button>
                    <motion.button whileHover={{ y: -1 }} whileTap={{ scale: 0.97 }}
                        onClick={() => navigate('/')}
                        className="glass-button px-6 py-2.5 rounded-xl font-semibold text-sm">
                        Go Home
                    </motion.button>
                </div>
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
                    description={store?.description || `Shop products from ${store?.storeName} on Tortrose.`}
                    canonical={`/stores/${slug}`}
                />
                {/* Breadcrumb */}
                <motion.div
                    className="flex items-center text-sm mb-6"
                    style={{ color: 'hsl(var(--muted-foreground))' }}
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3 }}
                >
                    <Link to="/" className="flex items-center gap-1 transition-colors hover:text-[hsl(220,70%,55%)]">
                        <Home size={15} />
                        <span>Home</span>
                    </Link>
                    <ChevronRight size={14} className="mx-1.5 opacity-50" />
                    <Link to="/stores" className="transition-colors hover:text-[hsl(220,70%,55%)]">Stores</Link>
                    <ChevronRight size={14} className="mx-1.5 opacity-50" />
                    <span className="font-medium truncate" style={{ color: 'hsl(var(--foreground))' }}>{store?.storeName}</span>
                </motion.div>

                {/* Store Header Card */}
                <motion.div
                    className="glass-panel-strong water-shimmer relative overflow-hidden mb-8"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.1 }}
                >
                    {/* Banner or fallback gradient */}
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

                    {/* Store Info */}
                    <div className="p-6 md:p-8">
                        <div className="flex flex-col md:flex-row gap-6 items-start">
                            {/* Logo */}
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

                            {/* Store Details */}
                            <div className="flex-1 min-w-0">
                                <div className="flex flex-wrap items-center gap-2 mb-2">
                                    <motion.h1
                                        className="text-xl md:text-2xl lg:text-3xl font-extrabold tracking-tight"
                                        style={{ color: 'hsl(var(--foreground))' }}
                                        initial={{ opacity: 0, x: -15 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        transition={{ duration: 0.4, delay: 0.3 }}
                                    >
                                        {store?.storeName}
                                    </motion.h1>
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

                                <div className="flex items-center gap-1.5 text-xs mb-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    <Users size={13} />
                                    <span>{trustCount} {trustCount === 1 ? 'truster' : 'trusters'}</span>
                                </div>

                                {store?.description && (
                                    <p className="text-sm mb-4 max-w-2xl leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        {store.description}
                                    </p>
                                )}

                                {/* Store Address */}
                                {store?.address && (store.address.street || store.address.city || store.address.country) && (
                                    <div className="mb-4 flex items-start gap-2 text-sm glass-inner rounded-xl p-3" style={{ color: 'hsl(var(--foreground))' }}>
                                        <MapPin size={16} className="shrink-0 mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }} />
                                        <div>
                                            {store.address.street && <p>{store.address.street}</p>}
                                            <p>{[store.address.city, store.address.state, store.address.postalCode].filter(Boolean).join(', ')}</p>
                                            {store.address.country && <p>{store.address.country}</p>}
                                        </div>
                                    </div>
                                )}

                                <div className="flex flex-wrap gap-2 text-xs">
                                    <span className="tag-pill flex items-center gap-1.5">
                                        <Package size={13} />{products.length} Products
                                    </span>
                                    <span className="tag-pill flex items-center gap-1.5" style={{ background: 'rgba(56, 189, 248, 0.1)', color: 'hsl(200, 80%, 50%)', borderColor: 'rgba(56, 189, 248, 0.18)' }}>
                                        <Eye size={13} />{store?.views || 0} Views
                                    </span>
                                </div>

                                {/* Social Links */}
                                {store?.socialLinks && Object.values(store.socialLinks).some(link => link) && (
                                    <motion.div
                                        className="flex flex-wrap gap-2 mt-4"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        transition={{ duration: 0.4, delay: 0.6 }}
                                    >
                                        {store.socialLinks.website && (
                                            <a href={store.socialLinks.website} target="_blank" rel="noopener noreferrer"
                                                className="glass-button flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all"
                                                style={{ color: 'hsl(var(--foreground))' }}>
                                                <Globe size={16} /> Website
                                            </a>
                                        )}
                                        {store.socialLinks.facebook && (
                                            <a href={store.socialLinks.facebook} target="_blank" rel="noopener noreferrer"
                                                className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all"
                                                style={{ background: 'rgba(59, 130, 246, 0.15)', color: 'hsl(220, 70%, 55%)', border: '1px solid rgba(59, 130, 246, 0.2)' }}>
                                                <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                                                    <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                                                </svg>
                                                Facebook
                                            </a>
                                        )}
                                        {store.socialLinks.instagram && (
                                            <a href={store.socialLinks.instagram} target="_blank" rel="noopener noreferrer"
                                                className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all"
                                                style={{ background: 'rgba(236, 72, 153, 0.12)', color: 'hsl(330, 70%, 55%)', border: '1px solid rgba(236, 72, 153, 0.2)' }}>
                                                <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                                                    <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
                                                </svg>
                                                Instagram
                                            </a>
                                        )}
                                        {store.socialLinks.twitter && (
                                            <a href={store.socialLinks.twitter} target="_blank" rel="noopener noreferrer"
                                                className="glass-button flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all"
                                                style={{ color: 'hsl(var(--foreground))' }}>
                                                <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                                                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                                                </svg>
                                                X
                                            </a>
                                        )}
                                        {store.socialLinks.youtube && (
                                            <a href={store.socialLinks.youtube} target="_blank" rel="noopener noreferrer"
                                                className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all"
                                                style={{ background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
                                                <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                                                    <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
                                                </svg>
                                                YouTube
                                            </a>
                                        )}
                                        {store.socialLinks.tiktok && (
                                            <a href={store.socialLinks.tiktok} target="_blank" rel="noopener noreferrer"
                                                className="glass-button flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all"
                                                style={{ color: 'hsl(var(--foreground))' }}>
                                                <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                                                    <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z"/>
                                                </svg>
                                                TikTok
                                            </a>
                                        )}
                                    </motion.div>
                                )}
                            </div>

                            {/* Share Button */}
                            <motion.button
                                onClick={handleShare}
                                className="glass-button px-5 py-2.5 rounded-xl flex items-center gap-2 font-medium text-sm"
                                style={{ color: 'hsl(var(--foreground))' }}
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                initial={{ opacity: 0, scale: 0.9 }}
                                animate={{ opacity: 1, scale: 1 }}
                                transition={{ duration: 0.3, delay: 0.6 }}
                            >
                                <Share2 size={18} />
                                Share Store
                            </motion.button>
                        </div>
                    </div>
                </motion.div>

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
                        <motion.div
                            className="flex flex-col items-center justify-center h-64 glass-panel"
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ duration: 0.4 }}
                        >
                            <div className="glass-inner p-5 rounded-2xl mb-4">
                                <Package size={40} style={{ color: 'hsl(var(--muted-foreground))' }} />
                            </div>
                            <p className="text-base font-semibold" style={{ color: 'hsl(var(--foreground))' }}>No products yet</p>
                            <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>This store hasn't added any products</p>
                        </motion.div>
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

export default StorePage;
