import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Store, Package, Eye, Share2, ChevronRight, ChevronLeft, Home, Globe, MapPin, Users, Ticket, Copy, Check, Calendar, Percent, DollarSign, Search, Tag, Star, Flag } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';
import ProductCard from '../components/common/ProductCard';
import Loader from '../components/common/Loader';
import TrustButton from '../components/common/TrustButton';
import VerifiedBadge from '../components/common/VerifiedBadge';
import SEOHead from '../components/common/SEOHead';
import { navigateToMainDomainPath, isSubdomain } from '../utils/subdomainHelper';
import { getAuthToken } from "../utils/cookieHelper";
import { useCurrency } from '../contexts/CurrencyContext';
import { useBuyerLocation } from '../contexts/BuyerLocationContext';
import { buildStoreThemeStyle, getStoreTheme, isDefaultStoreTheme } from '../utils/storeThemes';
import StoreReviews from '../components/common/StoreReviews';
import SafetyActionsDialog from '../components/common/SafetyActionsDialog';
import { useAuth } from '../contexts/AuthContext';

const getEntityId = (value) => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    return value._id || value.id || '';
};

const getStoreVisitorId = () => {
    const key = 'rozareStoreVisitorId';
    let visitorId = localStorage.getItem(key);
    if (!visitorId) {
        visitorId = (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
        localStorage.setItem(key, visitorId);
    }
    return visitorId;
};

const StorePage = ({ slugOverride = null }) => {
    const STORE_PRODUCTS_PER_PAGE = 12;
    const { slug: slugFromParams } = useParams();
    const slug = slugOverride || slugFromParams;
    const { currentUser } = useAuth();
    const { formatPrice } = useCurrency();
    const { appendLocationParams, locationQueryString } = useBuyerLocation();
    const [store, setStore] = useState(null);
    const [products, setProducts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [productsLoading, setProductsLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);
    const [trustStatus, setTrustStatus] = useState({ isTrusted: false, trustCount: 0 });
    const [storeCoupons, setStoreCoupons] = useState([]);
    const [copiedCoupon, setCopiedCoupon] = useState(null);
    const [productSearch, setProductSearch] = useState('');
    const [selectedCategory, setSelectedCategory] = useState('all');
    const [productPage, setProductPage] = useState(1);
    const [productPagination, setProductPagination] = useState({ total: 0, page: 1, pages: 1, limit: STORE_PRODUCTS_PER_PAGE });
    const [storeCategories, setStoreCategories] = useState([]);
    const [storeRating, setStoreRating] = useState({ average: 0, count: 0 });
    const [safetyVisible, setSafetyVisible] = useState(false);
    const isOwnStore = Boolean(
        getEntityId(store?.seller) && getEntityId(store.seller) === getEntityId(currentUser),
    );

    const categories = useMemo(() => {
        if (storeCategories.length > 0) return storeCategories;
        return [...new Set(products.map(p => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    }, [products, storeCategories]);

    const filteredProducts = products;
    const totalStoreProducts = productPagination.total ?? filteredProducts.length;
    const totalProductPages = Math.max(1, productPagination.pages || 1);

    useEffect(() => {
        // When slugOverride is provided we are already on the store's subdomain —
        // skip the path -> subdomain redirect.
        if (!slugOverride) {
            const host = window.location.hostname;
            const isLocalLike = host === 'localhost'
                || /^\d+\.\d+\.\d+\.\d+$/.test(host)
                || host.endsWith('lovableproject.com')
                || host.endsWith('lovable.app')
                || host.endsWith('vercel.app');
            if (slugFromParams && !isLocalLike) {
                const parts = host.split('.');
                const root = parts.length >= 2 ? parts.slice(-2).join('.') : host;
                window.location.replace(`${window.location.protocol}//${slugFromParams}.${root}`);
                return;
            }
        }
        fetchStore();
        incrementViewCount();
        // Slug and buyer location own this request lifecycle; including the
        // render-created fetch functions would re-run on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slug, locationQueryString]);

    useEffect(() => {
        setProductPage(1);
    }, [slug, locationQueryString, selectedCategory, productSearch]);

    useEffect(() => {
        fetchProducts();
        // The explicit query state above is the authoritative request key.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slug, locationQueryString, productPage, selectedCategory, productSearch]);

    useEffect(() => {
        if (store?._id) {
            fetchTrustStatus();
        }
        const sellerId = getEntityId(store?.seller);
        if (sellerId) {
            fetchStoreCoupons(sellerId);
        } else {
            setStoreCoupons([]);
        }
        // Store identity/seller snapshots own this refresh; function identities
        // are render-local and would cause a request loop.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [store?._id, store?.seller]);

    useEffect(() => {
        const root = document.documentElement;
        const theme = getStoreTheme(store?.storeTheme);
        const clearThemeNav = () => {
            root.style.removeProperty('--store-theme-nav-bg');
            root.style.removeProperty('--store-theme-nav-border');
            root.style.removeProperty('--store-theme-nav-fg');
            root.style.removeProperty('--store-theme-nav-accent');
        };

        if (!store || isDefaultStoreTheme(theme)) {
            clearThemeNav();
            return clearThemeNav;
        }

        root.style.setProperty('--store-theme-nav-bg', theme.palette.panel || 'rgba(255,255,255,0.72)');
        root.style.setProperty('--store-theme-nav-border', theme.palette.chipBorder || 'var(--glass-border)');
        root.style.setProperty('--store-theme-nav-fg', theme.palette.text || 'hsl(var(--foreground))');
        root.style.setProperty('--store-theme-nav-accent', theme.palette.primary || 'hsl(var(--primary))');
        return clearThemeNav;
    }, [store]);

    const fetchStoreCoupons = async (sellerId) => {
        if (!sellerId || typeof sellerId !== 'string') {
            setStoreCoupons([]);
            return;
        }

        try {
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/coupons/store/${sellerId}`);
            setStoreCoupons(res.data.coupons || []);
        } catch (err) {
            console.log('No coupons for this store');
        }
    };

    const copyCouponCode = (code) => {
        navigator.clipboard.writeText(code);
        setCopiedCoupon(code);
        toast.success('Coupon code copied!');
        setTimeout(() => setCopiedCoupon(null), 2000);
    };

    // Handle navigation - redirect to main domain if on subdomain
    const handleNavClick = (e, path) => {
        if (isSubdomain()) {
            e.preventDefault();
            navigateToMainDomainPath(path);
        }
    };

    const fetchStore = async () => {
        try {
            setLoading(true);
            const params = new URLSearchParams();
            appendLocationParams(params);
            const suffix = params.toString();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/${slug}${suffix ? `?${suffix}` : ''}`);
            setStore(res.data.store);
            setStoreRating({
                average: Number(res.data.store?.ratingAverage) || 0,
                count: Number(res.data.store?.ratingCount) || 0,
            });
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
            const params = new URLSearchParams();
            appendLocationParams(params);
            params.set('page', String(productPage));
            params.set('limit', String(STORE_PRODUCTS_PER_PAGE));
            if (selectedCategory !== 'all') params.set('categories', selectedCategory);
            if (productSearch.trim()) params.set('search', productSearch.trim());
            const suffix = params.toString();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/${slug}/products${suffix ? `?${suffix}` : ''}`);
            setProducts(res.data.products || []);
            setProductPagination(res.data.pagination || { total: res.data.products?.length || 0, page: productPage, pages: 1, limit: STORE_PRODUCTS_PER_PAGE });
            setStoreCategories(res.data.categories || []);
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

    const incrementViewCount = async () => {
        try {
            await axios.post(
                `${import.meta.env.VITE_API_URL}api/stores/${slug}/view`,
                {},
                { headers: { 'x-rozare-visitor-id': getStoreVisitorId() } }
            );
        } catch (error) {
            console.error('Error incrementing view count:', error);
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
                        onClick={(e) => { e.preventDefault(); navigateToMainDomainPath('/stores'); }}
                        className="px-6 py-2.5 rounded-xl font-semibold text-sm"
                        style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }}>
                        Browse All Stores
                    </motion.button>
                    <motion.button whileHover={{ y: -1 }} whileTap={{ scale: 0.97 }}
                        onClick={(e) => { e.preventDefault(); navigateToMainDomainPath('/'); }}
                        className="glass-button px-6 py-2.5 rounded-xl font-semibold text-sm">
                        Go Home
                    </motion.button>
                </div>
            </div>
        );
    }

    const trustCount = trustStatus.trustCount || store?.trustCount || 0;
    const activeTheme = getStoreTheme(store?.storeTheme);
    const isDefaultTheme = isDefaultStoreTheme(activeTheme);
    const isCenteredTheme = ['centered', 'showcase'].includes(activeTheme.layout);
    const isCompactTheme = activeTheme.layout === 'compact';
    const isEditorialTheme = activeTheme.layout === 'editorial';
    const themePageStyle = buildStoreThemeStyle(activeTheme);
    const themedPanelStyle = isDefaultTheme ? undefined : {
        background: activeTheme.palette.panel,
        borderColor: activeTheme.palette.chipBorder,
        borderRadius: activeTheme.radius,
        boxShadow: `0 28px 90px -56px ${activeTheme.colors.primary}`,
    };
    const themeForeground = isDefaultTheme ? 'hsl(var(--foreground))' : activeTheme.palette.text;
    const themeMuted = isDefaultTheme ? 'hsl(var(--muted-foreground))' : activeTheme.palette.muted;
    const themePrimaryGradient = activeTheme.palette.accentGradient || activeTheme.palette.heroGradient;
    const chipStyle = isDefaultTheme ? undefined : {
        background: activeTheme.palette.chipBackground,
        color: activeTheme.palette.chipText,
        borderColor: activeTheme.palette.chipBorder,
    };
    const headerLayoutClass = isCenteredTheme
        ? 'flex flex-col gap-5 items-center text-center'
        : 'flex flex-col md:flex-row gap-6 items-start';
    const storeDetailsClass = isCenteredTheme
        ? 'flex-1 min-w-0 w-full flex flex-col items-center'
        : 'flex-1 min-w-0';
    const titleRowClass = isCenteredTheme
        ? 'flex flex-wrap items-center justify-center gap-2 mb-2'
        : 'flex flex-wrap items-center gap-2 mb-2';
    const bannerClass = isCompactTheme
        ? 'w-full h-32 md:h-44 overflow-hidden relative'
        : isEditorialTheme || activeTheme.layout === 'showcase'
            ? 'w-full h-52 md:h-72 overflow-hidden relative'
            : 'w-full h-44 md:h-60 overflow-hidden relative';
    const fallbackBannerClass = isCompactTheme ? 'w-full h-20 relative' : 'w-full h-24 relative';
    const logoOffsetClass = store?.banner
        ? isCenteredTheme ? '-mt-14 md:-mt-16 mx-auto' : '-mt-16 md:-mt-20'
        : isCenteredTheme ? '-mt-10 mx-auto' : '-mt-12';

    return (
        <motion.div
            className="min-h-screen py-8"
            style={themePageStyle}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
        >
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                <SEOHead
                    title={`${store?.storeName || 'Store'} - Shop Products Online`}
                    description={store?.description
                        ? `${store.description.slice(0, 120)} - Shop products from ${store?.storeName} on Rozare with secure checkout, trust signals, and seller-managed shipping.`
                        : `Shop products from ${store?.storeName} on Rozare. Browse this seller's products, reviews, trust count, and shipping options before checkout.`}
                    canonical={`https://${slug}.rozare.com`}
                    ogImage={store?.logo || undefined}
                    ogImageAlt={`${store?.storeName} - Shop on Rozare Marketplace`}
                    keywords={`${store?.storeName}, ${store?.storeName} store, ${store?.storeName} products, ${store?.storeName} shop, buy from ${store?.storeName}, ${store?.storeName} online, rozare store, trusted store, online shop, independent seller`}
                    jsonLd={{
                        '@context': 'https://schema.org',
                        '@type': 'Store',
                        name: store?.storeName,
                        description: store?.description,
                        url: `https://${slug}.rozare.com`,
                        logo: store?.logo,
                        image: store?.banner || store?.logo,
                        ...(store?.address?.city && {
                            address: {
                                '@type': 'PostalAddress',
                                streetAddress: store.address.street,
                                addressLocality: store.address.city,
                                addressRegion: store.address.state,
                                postalCode: store.address.postalCode,
                                addressCountry: store.address.country,
                            },
                        }),
                        ...(store?.socialLinks?.website && { sameAs: [store.socialLinks.website] }),
                        ...(storeRating.count > 0 && {
                            aggregateRating: {
                                '@type': 'AggregateRating',
                                ratingValue: storeRating.average,
                                ratingCount: storeRating.count,
                                bestRating: 5,
                                worstRating: 1,
                            },
                        }),
                    }}
                />
                {/* Breadcrumb */}
                <motion.div
                    className="flex items-center text-sm mb-6"
                    style={{ color: 'hsl(var(--muted-foreground))' }}
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3 }}
                >
                    <Link to="/" onClick={(e) => handleNavClick(e, '/')} className="flex items-center gap-1 transition-colors hover:text-[hsl(220,70%,55%)]">
                        <Home size={15} />
                        <span>Home</span>
                    </Link>
                    <ChevronRight size={14} className="mx-1.5 opacity-50" />
                    <Link to="/stores" onClick={(e) => handleNavClick(e, '/stores')} className="transition-colors hover:text-[hsl(220,70%,55%)]">Stores</Link>
                    <ChevronRight size={14} className="mx-1.5 opacity-50" />
                    <span className="font-medium truncate" style={{ color: 'hsl(var(--foreground))' }}>{store?.storeName}</span>
                </motion.div>

                {/* Store Header Card */}
                <motion.div
                    className="glass-panel-strong water-shimmer relative overflow-hidden mb-8"
                    style={themedPanelStyle}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.1 }}
                >
                    {/* Banner or fallback gradient */}
                    {store?.banner ? (
                        <div className={bannerClass}>
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
                        <div className={fallbackBannerClass} style={{ background: activeTheme.palette.heroGradient }}>
                            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.15),transparent_60%)]" />
                        </div>
                    )}

                    {/* Store Info */}
                    <div className={isCompactTheme ? 'p-5 md:p-6' : 'p-6 md:p-8'}>
                        <div className={headerLayoutClass}>
                            {/* Logo */}
                            <motion.div
                                className={`shrink-0 relative z-10 ${logoOffsetClass}`}
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
                                        style={{ background: activeTheme.palette.heroGradient, border: '3px solid var(--glass-border-strong)' }}>
                                        <Store size={36} className="text-white" />
                                    </div>
                                )}
                            </motion.div>

                            {/* Store Details */}
                            <div className={storeDetailsClass}>
                                <div className={titleRowClass}>
                                    <motion.h1
                                        className="text-xl md:text-2xl lg:text-3xl font-extrabold tracking-tight"
                                        style={{ color: themeForeground }}
                                        initial={{ opacity: 0, x: -15 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        transition={{ duration: 0.4, delay: 0.3 }}
                                    >
                                        {store?.storeName}
                                    </motion.h1>
                                    {store?.verification?.isVerified && <VerifiedBadge size="lg" />}
                                    {store && (
                                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide"
                                            style={{
                                                background: isDefaultTheme ? ((store.sellerType === 'brand') ? 'hsla(280, 70%, 55%, 0.15)' : 'hsla(220, 70%, 55%, 0.15)') : activeTheme.palette.chipBackground,
                                                border: `1px solid ${isDefaultTheme ? ((store.sellerType === 'brand') ? 'hsla(280, 70%, 55%, 0.35)' : 'hsla(220, 70%, 55%, 0.35)') : activeTheme.palette.chipBorder}`,
                                                color: isDefaultTheme ? ((store.sellerType === 'brand') ? 'hsl(280, 70%, 55%)' : 'hsl(220, 70%, 55%)') : activeTheme.palette.chipText,
                                            }}>
                                            {(store.sellerType === 'brand') ? 'Brand' : 'Store'}
                                        </span>
                                    )}
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

                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs mb-3" style={{ color: themeMuted }}>
                                    <span className="inline-flex items-center gap-1.5"><Users size={13} />{trustCount} {trustCount === 1 ? 'truster' : 'trusters'}</span>
                                    <a href="#store-reviews" className="inline-flex items-center gap-1.5 hover:underline">
                                        <Star size={13} style={{ color: 'hsl(45,93%,47%)', fill: storeRating.count > 0 ? 'hsl(45,93%,47%)' : 'none' }} />
                                        {storeRating.count > 0 ? `${storeRating.average.toFixed(1)} (${storeRating.count})` : 'No ratings yet'}
                                    </a>
                                </div>

                                {store?.description && (
                                    <p className="text-sm mb-4 max-w-2xl leading-relaxed" style={{ color: themeMuted }}>
                                        {store.description}
                                    </p>
                                )}

                                {/* Store Address */}
                                {store?.address && (store.address.street || store.address.city || store.address.country) && (
                                    <div className={`mb-4 flex items-start gap-2 text-sm glass-inner rounded-xl p-3 ${isCenteredTheme ? 'max-w-2xl' : ''}`} style={{ color: themeForeground }}>
                                        <MapPin size={16} className="shrink-0 mt-0.5" style={{ color: themeMuted }} />
                                        <div>
                                            {store.address.street && <p>{store.address.street}</p>}
                                            <p>{[store.address.city, store.address.state, store.address.postalCode].filter(Boolean).join(', ')}</p>
                                            {store.address.country && <p>{store.address.country}</p>}
                                        </div>
                                    </div>
                                )}

                                <div className="flex flex-wrap gap-2 text-xs">
                                    <span className="tag-pill flex items-center gap-1.5" style={chipStyle}>
                                        <Package size={13} />{products.length} Products
                                    </span>
                                    <span className="tag-pill flex items-center gap-1.5" style={isDefaultTheme ? { background: 'rgba(56, 189, 248, 0.1)', color: 'hsl(200, 80%, 50%)', borderColor: 'rgba(56, 189, 248, 0.18)' } : chipStyle}>
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
                                                    <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
                                                </svg>
                                                Facebook
                                            </a>
                                        )}
                                        {store.socialLinks.instagram && (
                                            <a href={store.socialLinks.instagram} target="_blank" rel="noopener noreferrer"
                                                className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all"
                                                style={{ background: 'rgba(236, 72, 153, 0.12)', color: 'hsl(330, 70%, 55%)', border: '1px solid rgba(236, 72, 153, 0.2)' }}>
                                                <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                                                    <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
                                                </svg>
                                                Instagram
                                            </a>
                                        )}
                                        {store.socialLinks.twitter && (
                                            <a href={store.socialLinks.twitter} target="_blank" rel="noopener noreferrer"
                                                className="glass-button flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all"
                                                style={{ color: 'hsl(var(--foreground))' }}>
                                                <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                                                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                                                </svg>
                                                X
                                            </a>
                                        )}
                                        {store.socialLinks.youtube && (
                                            <a href={store.socialLinks.youtube} target="_blank" rel="noopener noreferrer"
                                                className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all"
                                                style={{ background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
                                                <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                                                    <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                                                </svg>
                                                YouTube
                                            </a>
                                        )}
                                        {store.socialLinks.tiktok && (
                                            <a href={store.socialLinks.tiktok} target="_blank" rel="noopener noreferrer"
                                                className="glass-button flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all"
                                                style={{ color: 'hsl(var(--foreground))' }}>
                                                <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                                                    <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z" />
                                                </svg>
                                                TikTok
                                            </a>
                                        )}
                                    </motion.div>
                                )}
                            </div>

                            {/* Share Button */}
                            {!isOwnStore && <motion.button
                                onClick={handleShare}
                                className="glass-button px-5 py-2.5 rounded-xl flex items-center gap-2 font-medium text-sm"
                                style={{ color: themeForeground }}
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                initial={{ opacity: 0, scale: 0.9 }}
                                animate={{ opacity: 1, scale: 1 }}
                                transition={{ duration: 0.3, delay: 0.6 }}
                            >
                                <Share2 size={18} />
                                Share Store
                            </motion.button>}
                            <motion.button
                                type="button"
                                onClick={() => setSafetyVisible(true)}
                                className="glass-button px-4 py-2.5 rounded-xl flex items-center gap-2 font-medium text-sm"
                                style={{ color: themeMuted }}
                                whileHover={{ scale: 1.03 }}
                                whileTap={{ scale: 0.96 }}
                            >
                                <Flag size={16} /> Safety
                            </motion.button>
                        </div>
                    </div>
                </motion.div>

                {/* Available Coupons */}
                {storeCoupons.length > 0 && (
                    <motion.div
                        className="glass-panel-strong p-5 sm:p-6 mb-8"
                        style={themedPanelStyle}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.5, delay: 0.25 }}
                    >
                        <h3 className="text-lg font-bold mb-4 flex items-center gap-2" style={{ color: themeForeground }}>
                            <div className="p-1.5 rounded-lg" style={{ background: isDefaultTheme ? 'rgba(168, 85, 247, 0.12)' : activeTheme.palette.chipBackground, color: isDefaultTheme ? 'hsl(280, 60%, 55%)' : activeTheme.palette.chipText }}>
                                <Ticket size={18} />
                            </div>
                            Available Coupons
                            <span className="ml-auto tag-pill text-xs font-medium">{storeCoupons.length} coupon{storeCoupons.length !== 1 ? 's' : ''}</span>
                        </h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            {storeCoupons.map((coupon, idx) => (
                                <motion.div key={coupon._id}
                                    initial={{ opacity: 0, scale: 0.95 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    transition={{ delay: idx * 0.05 }}
                                    className="glass-inner rounded-xl p-4 relative overflow-hidden group hover:shadow-md transition-shadow"
                                >
                                    {/* Decorative accent */}
                                    <div className="absolute top-0 left-0 right-0 h-1 rounded-t-xl" style={{ background: activeTheme.palette.couponGradient }} />
                                    
                                    <div className="flex items-start justify-between gap-2 mb-2">
                                        <div>
                                            <span className="font-mono font-bold text-sm tracking-wider" style={{ color: isDefaultTheme ? 'hsl(280, 60%, 55%)' : activeTheme.palette.chipText }}>
                                                {coupon.code}
                                            </span>
                                            <div className="flex items-center gap-1.5 mt-1">
                                                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
                                                    style={{ background: 'rgba(16,185,129,0.1)', color: 'hsl(150, 60%, 45%)' }}>
                                                    {coupon.discountType === 'percentage' ? (
                                                        <span className="flex items-center gap-0.5"><Percent size={9} />{coupon.discountValue}% OFF</span>
                                                    ) : (
                                                        <span className="flex items-center gap-0.5"><DollarSign size={9} />{formatPrice(coupon.discountValue, { sourceCurrency: coupon.currency || 'USD' })} OFF</span>
                                                    )}
                                                </span>
                                                <span className="text-[10px] px-2 py-0.5 rounded-full"
                                                    style={{ background: 'rgba(59,130,246,0.08)', color: 'hsl(220, 70%, 55%)' }}>
                                                    {coupon.applicableTo === 'all' ? 'All Products' : `${coupon.applicableProducts?.length || 0} Products`}
                                                </span>
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
                                    </div>

                                    {coupon.description && (
                                        <p className="text-xs mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>{coupon.description}</p>
                                    )}

                                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        {coupon.minOrderAmount > 0 && <span>Min order: {formatPrice(coupon.minOrderAmount, { sourceCurrency: coupon.currency || 'USD' })}</span>}
                                        {coupon.maxDiscountAmount && <span>Max discount: {formatPrice(coupon.maxDiscountAmount, { sourceCurrency: coupon.currency || 'USD' })}</span>}
                                        <span className="flex items-center gap-0.5">
                                            <Calendar size={9} />
                                            Expires {new Date(coupon.expiryDate).toLocaleDateString()}
                                        </span>
                                    </div>
                                </motion.div>
                            ))}
                        </div>
                    </motion.div>
                )}

                {/* Products Section */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.3 }}
                >
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight" style={{ color: themeForeground }}>
                            Products
                        </h2>
                        <span className="tag-pill text-sm font-medium" style={chipStyle}>
                            {totalStoreProducts} {totalStoreProducts === 1 ? 'item' : 'items'}
                        </span>
                    </div>

                    {/* Search + Categories */}
                    {products.length > 0 && (
                        <div className="glass-panel p-3 sm:p-4 mb-5 space-y-3" style={themedPanelStyle}>
                            <div className="search-input-wrapper">
                                <div className="search-input-icon"><Search size={16} /></div>
                                <input
                                    type="text"
                                    value={productSearch}
                                    onChange={(e) => setProductSearch(e.target.value)}
                                    placeholder="Search products in this store..."
                                    className="glass-input glass-input-search w-full"
                                />
                            </div>
                            {categories.length > 0 && (
                                <div className="flex flex-wrap gap-2">
                                    <motion.button whileTap={{ scale: 0.96 }} onClick={() => setSelectedCategory('all')}
                                        className="px-3 py-1.5 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5"
                                        style={selectedCategory === 'all'
                                            ? { background: themePrimaryGradient, color: 'white' }
                                            : { background: 'rgba(255,255,255,0.08)', color: themeForeground, border: '1px solid var(--glass-border)' }}>
                                        <Tag size={12} /> All
                                    </motion.button>
                                    {categories.map(cat => (
                                        <motion.button key={cat} whileTap={{ scale: 0.96 }} onClick={() => setSelectedCategory(cat)}
                                            className="px-3 py-1.5 rounded-full text-xs font-semibold transition-all"
                                            style={selectedCategory === cat
                                                ? { background: themePrimaryGradient, color: 'white' }
                                                : { background: 'rgba(255,255,255,0.08)', color: themeForeground, border: '1px solid var(--glass-border)' }}>
                                            {cat.charAt(0).toUpperCase() + cat.slice(1)}
                                        </motion.button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {productsLoading ? (
                        <div className="flex justify-center items-center h-64">
                            <Loader />
                        </div>
                    ) : filteredProducts.length === 0 ? (
                        <motion.div
                            className="flex flex-col items-center justify-center h-64 glass-panel"
                            style={themedPanelStyle}
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ duration: 0.4 }}
                        >
                            <div className="glass-inner p-5 rounded-2xl mb-4">
                                <Package size={40} style={{ color: 'hsl(var(--muted-foreground))' }} />
                            </div>
                            <p className="text-base font-semibold" style={{ color: themeForeground }}>
                                {products.length === 0 ? 'No products yet' : 'No products match your filters'}
                            </p>
                            <p className="text-sm mt-1" style={{ color: themeMuted }}>
                                {products.length === 0 ? "This store hasn't added any products" : 'Try a different search or category'}
                            </p>
                        </motion.div>
                    ) : (
                        <>
                            <div className={`grid ${activeTheme.gridClass} gap-3 sm:gap-4 md:gap-5`}>
                                {filteredProducts.map((product, idx) => (
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
                            {totalProductPages > 1 && (
                                <div className="mt-6 flex flex-col sm:flex-row items-center justify-between gap-3">
                                    <p className="text-xs sm:text-sm" style={{ color: themeMuted }}>
                                        Page {productPagination.page || productPage} of {totalProductPages}
                                    </p>
                                    <div className="flex items-center gap-2">
                                        <motion.button
                                            type="button"
                                            whileTap={{ scale: 0.96 }}
                                            onClick={() => setProductPage(page => Math.max(1, page - 1))}
                                            disabled={productPage <= 1 || productsLoading}
                                            className="glass-button px-3 py-2 rounded-xl text-sm font-semibold disabled:opacity-45 disabled:cursor-not-allowed flex items-center gap-1.5"
                                            style={{ color: themeForeground }}
                                        >
                                            <ChevronLeft size={15} /> Previous
                                        </motion.button>
                                        <div className="flex items-center gap-1">
                                            {Array.from({ length: totalProductPages }, (_, i) => i + 1)
                                                .filter(page => page === 1 || page === totalProductPages || Math.abs(page - productPage) <= 1)
                                                .map((page, index, visiblePages) => (
                                                    <div key={page} className="flex items-center gap-1">
                                                        {index > 0 && page - visiblePages[index - 1] > 1 && (
                                                            <span className="px-1 text-xs" style={{ color: themeMuted }}>...</span>
                                                        )}
                                                        <motion.button
                                                            type="button"
                                                            whileTap={{ scale: 0.94 }}
                                                            onClick={() => setProductPage(page)}
                                                            className="w-9 h-9 rounded-xl text-sm font-bold"
                                                            style={page === productPage
                                                                ? { background: themePrimaryGradient, color: 'white' }
                                                                : { background: 'rgba(255,255,255,0.08)', color: themeForeground, border: '1px solid var(--glass-border)' }}
                                                        >
                                                            {page}
                                                        </motion.button>
                                                    </div>
                                                ))}
                                        </div>
                                        <motion.button
                                            type="button"
                                            whileTap={{ scale: 0.96 }}
                                            onClick={() => setProductPage(page => Math.min(totalProductPages, page + 1))}
                                            disabled={productPage >= totalProductPages || productsLoading}
                                            className="glass-button px-3 py-2 rounded-xl text-sm font-semibold disabled:opacity-45 disabled:cursor-not-allowed flex items-center gap-1.5"
                                            style={{ color: themeForeground }}
                                        >
                                            Next <ChevronRight size={15} />
                                        </motion.button>
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </motion.div>

                <StoreReviews
                    storeId={store._id}
                    storeOwnerId={getEntityId(store.seller)}
                    onSummaryChange={setStoreRating}
                />
                <SafetyActionsDialog
                    open={safetyVisible}
                    onClose={() => setSafetyVisible(false)}
                    report={{ kind: 'store', targetId: store._id }}
                    block={getEntityId(store.seller) ? { userId: getEntityId(store.seller), source: 'seller', label: 'seller' } : null}
                    onBlocked={() => navigateToMainDomainPath('/stores')}
                />
            </div>
        </motion.div>
    );
};

export default StorePage;
